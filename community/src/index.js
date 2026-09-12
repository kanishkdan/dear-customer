/*
 * bouncer-list — the public list behind Bouncer for WhatsApp Web.
 *
 *   POST /report     extension sends { install, items:[{ name, is_api, cc, numbers:[sha256…] }] }
 *   GET  /list.json  aggregated list the extension pulls daily
 *   GET  /           the Wall of Shame page
 *
 * Stores business display names as WhatsApp shows them, SHA-256 hashes of numbers,
 * and a random per-install id. No user identity, no message content.
 */

const MAX_BODY = 64 * 1024;
const MAX_ITEMS = 50;
const MAX_HASHES = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_RE = /^[0-9a-f]{64}$/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
      if (url.pathname === '/report' && request.method === 'POST') return await report(request, env, ctx);
      if (url.pathname === '/list.json' && request.method === 'GET') return await cached(request, ctx, () => listJson(env));
      if (url.pathname === '/' && request.method === 'GET') return await cached(request, ctx, () => page(env));
      if (url.pathname === '/privacy' && request.method === 'GET') return privacyPage(env);
      if (url.pathname === '/health') return json({ ok: true });
      return json({ error: 'not_found' }, 404);
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', path: url.pathname, message: String((e && e.message) || e) }));
      return json({ error: 'internal' }, 500);
    }
  },
};

// ------------------------------------------------------------------ helpers
function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(), ...extra },
  });
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Must match normName() in the extension so keys line up.
const normName = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

async function cached(request, ctx, produce) {
  const url = new URL(request.url);
  const key = new Request(url.origin + url.pathname, { method: 'GET' });
  let cache = null;
  // The Cache API misbehaves on the workers.dev hostname once the Worker also has a custom domain.
  if (!url.hostname.endsWith('.workers.dev')) { try { cache = caches.default; } catch (_) {} }
  if (cache) {
    try { const hit = await cache.match(key); if (hit) return hit; } catch (_) {}
  }
  const res = await produce();
  res.headers.set('cache-control', 'public, max-age=60');
  if (cache) ctx.waitUntil(cache.put(key, res.clone()).catch(() => {}));
  return res;
}

async function purge(request, ctx) {
  let cache = null;
  const origin = new URL(request.url).origin;
  if (origin.endsWith('.workers.dev')) return;
  try { cache = caches.default; } catch (_) { return; }
  ctx.waitUntil(Promise.all(['/', '/list.json'].map((p) => cache.delete(new Request(origin + p, { method: 'GET' })).catch(() => {}))));
}

// ------------------------------------------------------------------ report
async function report(request, env, ctx) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rl = await env.RL.limit({ key: ip });
  if (!rl.success) return json({ error: 'rate_limited' }, 429);

  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return json({ error: 'too_large' }, 413);
  let body;
  try { body = JSON.parse(await request.text()); } catch (_) { return json({ error: 'bad_json' }, 400); }

  const install = String(body.install || '');
  if (!UUID_RE.test(install)) return json({ error: 'bad_install' }, 400);
  if (!Array.isArray(body.items) || !body.items.length) return json({ error: 'no_items' }, 400);
  if (body.items.length > MAX_ITEMS) return json({ error: 'too_many_items' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const stmts = [];
  const insReport = env.DB.prepare(`
    INSERT INTO reports (install_id, name_key, name, is_api, cc, created_at, updated_at, count, category)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7)
    ON CONFLICT(install_id, name_key) DO UPDATE SET
      updated_at = excluded.updated_at,
      count = count + 1,
      name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
      is_api = MAX(is_api, excluded.is_api),
      cc = COALESCE(excluded.cc, cc),
      category = COALESCE(excluded.category, category)`);
  const insNumber = env.DB.prepare(`
    INSERT OR IGNORE INTO numbers (name_key, number_hash, install_id, created_at) VALUES (?1, ?2, ?3, ?4)`);

  let accepted = 0;
  const rejected = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const key = normName(name);
    const hasLetter = /\p{L}/u.test(name);
    if (key.length < 2 || !hasLetter) { rejected.push(name || '(empty)'); continue; }
    const isApi = raw.is_api ? 1 : 0;
    const cc = /^\d{1,3}$/.test(String(raw.cc || '')) ? String(raw.cc) : null;
    const category = ['promo', 'guess', 'txn', 'api', 'smb'].includes(raw.category) ? raw.category : null;
    stmts.push(insReport.bind(install, key, name, isApi, cc, now, category));
    const hashes = Array.isArray(raw.numbers) ? raw.numbers.filter((h) => typeof h === 'string' && HASH_RE.test(h)).slice(0, MAX_HASHES) : [];
    for (const h of hashes) stmts.push(insNumber.bind(key, h.toLowerCase(), install, now));
    accepted++;
  }
  if (!stmts.length) return json({ error: 'nothing_valid', rejected }, 400);

  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  await purge(request, ctx);

  const totals = await totalsRow(env);
  return json({ ok: true, accepted, rejected, totals });
}

// -------------------------------------------------------------------- list
async function totalsRow(env) {
  const t = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(DISTINCT install_id) FROM reports) AS people,
      (SELECT COUNT(DISTINCT name_key) FROM reports) AS businesses,
      (SELECT COUNT(DISTINCT number_hash) FROM numbers) AS numbers,
      (SELECT COALESCE(SUM(count), 0) FROM reports) AS reports`).first();
  return { people: t.people || 0, businesses: t.businesses || 0, numbers: t.numbers || 0, reports: t.reports || 0 };
}

// Last 30 days, one bucket per UTC day: new report rows, first-time people,
// first-time businesses, first-time numbers. Cumulative lines start from the
// totals before the window so they read as growth, not as activity.
async function dailySeries(env, totals) {
  const DAYS = 30;
  const today = Math.floor(Date.now() / 86400000);
  const since = (today - DAYS + 1) * 86400;
  const days = Array.from({ length: DAYS }, (_, i) => new Date((today - DAYS + 1 + i) * 86400000).toISOString().slice(0, 10));
  const q = (sql) => env.DB.prepare(sql).bind(since).all().then((r) => r.results || []);
  const [reports, people, businesses, numbers] = await Promise.all([
    q(`SELECT date(created_at, 'unixepoch') AS d, COUNT(*) AS n FROM reports WHERE created_at >= ?1 GROUP BY d`),
    q(`SELECT d, COUNT(*) AS n FROM (SELECT MIN(created_at) AS t, date(MIN(created_at), 'unixepoch') AS d FROM reports GROUP BY install_id) WHERE t >= ?1 GROUP BY d`),
    q(`SELECT d, COUNT(*) AS n FROM (SELECT MIN(created_at) AS t, date(MIN(created_at), 'unixepoch') AS d FROM reports GROUP BY name_key) WHERE t >= ?1 GROUP BY d`),
    q(`SELECT d, COUNT(*) AS n FROM (SELECT MIN(created_at) AS t, date(MIN(created_at), 'unixepoch') AS d FROM numbers GROUP BY number_hash) WHERE t >= ?1 GROUP BY d`),
  ]);
  const toDaily = (rows) => { const m = new Map(rows.map((r) => [r.d, r.n])); return days.map((d) => m.get(d) || 0); };
  const cumulative = (daily, total) => { const inWindow = daily.reduce((a, b) => a + b, 0); let acc = Math.max(0, total - inWindow); return daily.map((n) => (acc += n)); };
  const rDaily = toDaily(reports), pDaily = toDaily(people), bDaily = toDaily(businesses), nDaily = toDaily(numbers);
  return {
    days,
    reports: { daily: rDaily, cumulative: cumulative(rDaily, totals.reports) },
    people: { daily: pDaily, cumulative: cumulative(pDaily, totals.people) },
    businesses: { daily: bDaily, cumulative: cumulative(bDaily, totals.businesses) },
    numbers: { daily: nDaily, cumulative: cumulative(nDaily, totals.numbers) },
  };
}

async function listData(env) {
  const [rows, totals, hashes] = await Promise.all([
    env.DB.prepare(`
      SELECT r.name_key AS key,
        (SELECT name FROM reports r2 WHERE r2.name_key = r.name_key GROUP BY name ORDER BY COUNT(*) DESC, MAX(updated_at) DESC LIMIT 1) AS name,
        COUNT(*) AS people,
        SUM(CASE WHEN category IS NULL OR category IN ('promo', 'guess') THEN 1 ELSE 0 END) AS promo_people,
        SUM(count) AS reports,
        MAX(is_api) AS is_api,
        MIN(created_at) AS first_seen,
        MAX(updated_at) AS last_seen,
        (SELECT COUNT(DISTINCT number_hash) FROM numbers n WHERE n.name_key = r.name_key) AS numbers
      FROM reports r
      GROUP BY r.name_key
      ORDER BY promo_people DESC, people DESC, numbers DESC, reports DESC
      LIMIT 1000`).all(),
    totalsRow(env),
    env.DB.prepare(`SELECT DISTINCT number_hash, name_key FROM numbers LIMIT 20000`).all(),
  ]);
  const hashMap = {};
  for (const h of hashes.results || []) hashMap[h.number_hash] = h.name_key;
  let series = null;
  try { series = await dailySeries(env, totals); } catch (e) { console.error(JSON.stringify({ level: 'error', where: 'dailySeries', message: String((e && e.message) || e) })); }
  return {
    updated: Math.floor(Date.now() / 1000),
    totals,
    series,
    businesses: (rows.results || []).map((r) => ({
      key: r.key, name: r.name, people: r.people, promo_people: r.promo_people || 0, reports: r.reports, is_api: !!r.is_api,
      numbers: r.numbers, first_seen: r.first_seen, last_seen: r.last_seen,
    })),
    hashes: hashMap,
  };
}

async function listJson(env) {
  const data = await listData(env);
  return json(data);
}

// ----------------------------------------------------------------- privacy
function privacyPage(env) {
  const repo = env.REPO_URL || '#';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bouncer · Privacy</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0b141a; color: #e9edef; font: 16px/1.6 -apple-system, "SF Pro Display", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 40px 20px 80px; }
  .bar { height: 8px; background: #ff3b30; }
  h1 { font-size: 30px; font-weight: 900; margin: 20px 0 6px; }
  h2 { font-size: 18px; margin: 28px 0 8px; }
  p, li { color: #cfd6da; }
  a { color: #00a884; }
  .muted { color: #8696a0; font-size: 14px; }
</style></head>
<body><div class="bar"></div><div class="wrap">
  <h1>Privacy</h1>
  <p class="muted">Bouncer, a Chrome extension for WhatsApp Web, and this website. Last updated 12 September 2026.</p>

  <h2>The short version</h2>
  <p>Bouncer runs inside your browser. It reads your WhatsApp Web chats locally to find business senders, and it acts on them locally through WhatsApp Web itself. Nothing about your chats leaves your computer unless you press <b>Add to the Wall of Shame</b>.</p>

  <h2>What the extension stores on your computer</h2>
  <ul>
    <li>A list of business senders it has seen, with their names and the numbers they used, so it can count how many numbers a business has burned on you across weeks.</li>
    <li>A random identifier, generated once, used only so the public list can count one person once.</li>
    <li>A cached copy of the public list.</li>
  </ul>
  <p>All of this lives in Chrome's extension storage on your device. Removing the extension deletes it.</p>

  <h2>What is sent to this website, and when</h2>
  <p>Only when you press <b>Add to the Wall of Shame</b>, and only for the businesses you tick:</p>
  <ul>
    <li>The business name exactly as WhatsApp shows it.</li>
    <li>A SHA-256 hash of the digits of each number that business used. The number itself is never sent.</li>
    <li>Whether WhatsApp marks it as an official Business Platform account, and a country-code guess.</li>
    <li>Your random identifier.</li>
  </ul>
  <p>Not sent, ever: your phone number, your name, your contacts, message content, or which businesses you chose not to report. The extension makes one other request to this site: it downloads the public list about every six hours so it can flag businesses others have reported.</p>

  <h2>What this website keeps</h2>
  <p>The reports above, in a database, for as long as the list exists. The public page shows business names and counts. Hashes are published in <code>list.json</code> so the extension can match numbers; they are not reversible into numbers without already knowing the number. Standard server logs with IP addresses are kept briefly for abuse prevention and rate limiting.</p>

  <h2>Removal</h2>
  <p>If a business is listed and you believe that is wrong, or you run that business, <a href="${esc(repo)}/issues/new?title=Removal%20request">open a removal request</a>. Entries come from users, not from the site operator.</p>

  <h2>Third parties</h2>
  <p>No analytics, no advertising, no trackers. The site runs on Cloudflare. The extension uses <a href="https://github.com/wppconnect-team/wa-js">wa-js</a>, an open-source library, bundled locally. Bouncer is not affiliated with WhatsApp or Meta.</p>

  <h2>Contact</h2>
  <p>Questions go to the <a href="${esc(repo)}/issues">issue tracker</a>.</p>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

// -------------------------------------------------------------------- page
async function page(env) {
  const data = await listData(env);
  const repo = env.REPO_URL || '#';
  const fmtAgo = (ts) => {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if (d < 3600) return 'just now';
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  };
  const spark = (values) => {
    if (!values || values.length < 2) return '';
    const W = 100, H = 28, max = Math.max(1, ...values), min = Math.min(...values);
    const span = Math.max(1, max - min);
    const pts = values.map((v, i) => [ 3 + (i / (values.length - 1)) * (W - 6), H - 3 - ((v - min) / span) * (H - 6) ]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const last = pts[pts.length - 1];
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="#aebac1" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" fill="#e9edef"/></svg>`;
  };
  const columns = (days, values) => {
    if (!values || !values.length) return '';
    const n = values.length, W = 600, H = 96, pad = 4, cw = (W - pad * (n - 1)) / n, max = Math.max(1, ...values);
    const bars = values.map((v, i) => {
      const h = v ? Math.max(3, Math.round((v / max) * (H - 24))) : 0;
      const x = (i * (cw + pad)).toFixed(1), y = (H - 18 - h).toFixed(1);
      return `<rect x="${x}" y="${y}" width="${cw.toFixed(1)}" height="${h}" rx="2" fill="${v ? '#e0332b' : '#1f2c34'}"${v ? '' : ` height="2" y="${H - 20}"`}><title>${esc(days[i])} · ${v} ${v === 1 ? 'report' : 'reports'}</title></rect>`;
    }).join('');
    return `<svg class="cols" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Reports per day, last 30 days">${bars}
      <text x="0" y="${H - 4}" fill="#8696a0" font-size="10">${esc(days[0])}</text><text x="${W}" y="${H - 4}" fill="#8696a0" font-size="10" text-anchor="end">${esc(days[n - 1])}</text>
      <text x="0" y="10" fill="#8696a0" font-size="10">peak ${max} in a day</text></svg>`;
  };
  const S = data.series;
  const rowsHtml = data.businesses.length
    ? data.businesses.map((b, i) => `
      <tr>
        <td class="rank">${i + 1}</td>
        <td class="name">${esc(b.name)}${b.is_api ? ' <span class="tag">API</span>' : ''}</td>
        <td class="num people">${b.promo_people}${b.people > b.promo_people ? ` <span class="muted">+${b.people - b.promo_people}</span>` : ''}</td>
        <td class="num burned">${b.numbers}</td>
        <td class="num muted">${esc(fmtAgo(b.last_seen))}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">Nothing here yet. Be the first to bounce someone.</td></tr>';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bouncer · Wall of Shame</title>
<meta name="description" content="Businesses that spam Indian WhatsApp, ranked by how many people bounced them and how many numbers they burned.">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b141a; color: #e9edef; font: 15px/1.5 -apple-system, "SF Pro Display", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 40px 20px 80px; }
  .bar { height: 8px; background: #ff3b30; }
  h1 { font-size: 34px; font-weight: 900; letter-spacing: -.01em; margin: 24px 0 6px; display: flex; align-items: center; gap: 12px; }
  h1 .dot { width: 14px; height: 14px; border-radius: 50%; background: #ff3b30; display: inline-block; }
  .sub { color: #8696a0; margin: 0 0 28px; max-width: 640px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 28px; }
  .stat { background: #111b21; border: 1px solid #2a3942; border-radius: 12px; padding: 14px 16px; }
  .stat .n { font-size: 30px; font-weight: 900; line-height: 1; color: #e9edef; }
  .stat .l { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8696a0; margin-top: 6px; }
  .stat .spark { display: block; width: 100%; height: 28px; margin-top: 10px; }
  .activity { background: #111b21; border: 1px solid #2a3942; border-radius: 12px; padding: 14px 16px 10px; margin-bottom: 28px; }
  .activity .l { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8696a0; margin-bottom: 8px; display: flex; justify-content: space-between; }
  .activity .cols { display: block; width: 100%; height: 96px; }
  table { width: 100%; border-collapse: collapse; background: #111b21; border: 1px solid #2a3942; border-radius: 12px; overflow: hidden; }
  th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid #1f2c34; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8696a0; font-weight: 700; background: #182229; }
  tr:last-child td { border-bottom: 0; }
  td.rank { color: #8696a0; font-weight: 800; width: 44px; }
  td.name { font-weight: 700; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th.num { text-align: right; }
  td.burned { color: #ff3b30; font-weight: 900; }
  td.people { color: #00a884; font-weight: 800; }
  .muted { color: #8696a0; }
  .tag { font-size: 10px; font-weight: 800; letter-spacing: .04em; padding: 2px 6px; border-radius: 4px; background: rgba(255,59,48,.18); color: #ff6b62; vertical-align: middle; }
  .empty { color: #8696a0; text-align: center; padding: 40px 16px !important; }
  .cta { margin: 28px 0; padding: 18px 20px; background: #111b21; border: 1px solid #2a3942; border-radius: 12px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .cta a.btn { background: #ff3b30; color: #fff; text-decoration: none; font-weight: 800; padding: 10px 16px; border-radius: 10px; }
  a { color: #00a884; }
  footer { color: #8696a0; font-size: 13px; margin-top: 40px; line-height: 1.6; }
  @media (max-width: 640px) { .stats { grid-template-columns: repeat(2, 1fr); } h1 { font-size: 26px; } th:nth-child(5), td:nth-child(5) { display: none; } }
</style></head>
<body><div class="bar"></div><div class="wrap">
  <h1><span class="dot"></span>Wall of Shame</h1>
  <p class="sub">Businesses ranked by how many people bounced them for promotional WhatsApp messages, and how many different numbers they burned doing it. A business here sent promotions to the people who bounced it; it may send alerts others want, and Bouncer never ticks a business for you because of this list. Reported anonymously by people running <a href="${esc(repo)}">Bouncer</a>, a Chrome extension for WhatsApp Web that finds every promotional sender in your chats and opts out, STOPs, reports, blocks and deletes them in one click.</p>
  <div class="stats">
    <div class="stat"><div class="n">${data.totals.businesses}</div><div class="l">Businesses</div>${S ? spark(S.businesses.cumulative) : ''}</div>
    <div class="stat"><div class="n">${data.totals.numbers}</div><div class="l">Numbers burned</div>${S ? spark(S.numbers.cumulative) : ''}</div>
    <div class="stat"><div class="n">${data.totals.people}</div><div class="l">People reporting</div>${S ? spark(S.people.cumulative) : ''}</div>
    <div class="stat"><div class="n">${data.totals.reports}</div><div class="l">Reports</div>${S ? spark(S.reports.cumulative) : ''}</div>
  </div>
  ${S ? `<div class="activity"><div class="l"><span>Reports per day</span><span>last 30 days · lines above show growth over the same period</span></div>${columns(S.days, S.reports.daily)}</div>` : ''}
  <table>
    <thead><tr><th>#</th><th>Business</th><th class="num">People bounced for promos</th><th class="num">Numbers burned</th><th class="num">Last seen</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="cta">
    <div style="flex:1;min-width:240px"><b>Add yours.</b> Install Bouncer on WhatsApp Web, bounce the businesses spamming you, and tick "Add to the public list".</div>
    <a class="btn" href="${esc(repo)}">Get Bouncer</a>
  </div>
  <footer>
    <p><b>What's stored.</b> The business name exactly as WhatsApp shows it, a SHA-256 hash of each number it used, whether it's an official Business Platform account, the country code, and a random id per browser so one person can't be counted twice. No phone numbers, no message content, no identity of the person reporting.</p>
    <p><b>Counting.</b> The main count is people who bounced the business for promotional messages. A grey +N is people who bounced it for something else, such as alerts they didn't want. Only the promotional count ranks.</p>
    <p><b>Listed and think it's wrong?</b> <a href="${esc(repo)}/issues/new?title=Removal%20request">Open a removal request</a>. Entries come from users, not from us.</p>
    <p><a href="/privacy">Privacy</a> · <a href="${esc(repo)}">Source on GitHub</a> · <code>GET /list.json</code> is public if you want the data. Not affiliated with WhatsApp or Meta.</p>
  </footer>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
