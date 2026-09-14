/*
 * dear-customer — the public list behind Dear Customer, a Chrome extension for WhatsApp Web.
 *
 *   POST /report     extension sends { install, items:[{ name, is_api, cc, numbers:[sha256…] }] }
 *   GET  /list.json  aggregated list the extension pulls daily
 *   GET  /           the Wall of Shame page
 *
 * Stores business display names as WhatsApp shows them, SHA-256 hashes of numbers,
 * and a random per-install id. No user identity, no message content.
 */

const ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1024 1024\"><rect width=\"1024\" height=\"1024\" rx=\"230\" fill=\"#1c1c1e\"/><path d=\"M192 300a96 96 0 0 1 96-96h448a96 96 0 0 1 96 96v260a96 96 0 0 1-96 96H424L300 820V656h-12a96 96 0 0 1-96-96z\" fill=\"#fff\"/><rect x=\"262\" y=\"372\" width=\"196\" height=\"132\" rx=\"48\" fill=\"#1c1c1e\"/><rect x=\"566\" y=\"372\" width=\"196\" height=\"132\" rx=\"48\" fill=\"#1c1c1e\"/><rect x=\"452\" y=\"418\" width=\"120\" height=\"34\" rx=\"17\" fill=\"#1c1c1e\"/></svg>";

const DEFAULT_MIN_REPORTERS = 3;
const minReporters = (env) => {
  const n = parseInt(env.MIN_REPORTERS, 10);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MIN_REPORTERS;
};

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
      if (url.pathname === '/' && request.method === 'GET') return await cached(request, ctx, () => landingPage(env));
      if ((url.pathname === '/wall' || url.pathname === '/wall/') && request.method === 'GET') return await cached(request, ctx, () => wallPage(env));
      if (url.pathname === '/privacy' && request.method === 'GET') return privacyPage(env);
      if (url.pathname === '/favicon.svg' || url.pathname === '/icon.svg') return new Response(ICON_SVG, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' } });
      if (url.pathname === '/favicon.ico') return Response.redirect(url.origin + '/favicon.svg', 302);
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
  ctx.waitUntil(Promise.all(['/', '/wall', '/list.json'].map((p) => cache.delete(new Request(origin + p, { method: 'GET' })).catch(() => {}))));
}

// ------------------------------------------------------------------ report
// ------------------------------------------------------------ network key
// The Wall counts reporters by the network a contribution came from, not only by the
// random install id a browser makes up, so one person can't pose as three. Only a keyed
// hash of the network part of the address is stored: IPv4 /24, IPv6 /48. Many people
// share a mobile network address, so the Wall fills slower. That is the safe direction
// to be wrong in.
function networkPrefix(ip) {
  if (!ip || ip === 'unknown') return null;
  if (ip.includes('.')) {
    const v4 = ip.slice(ip.lastIndexOf(':') + 1).split('.');
    return v4.length === 4 ? `${v4[0]}.${v4[1]}.${v4[2]}.0/24` : null;
  }
  if (!ip.includes(':')) return null;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? null : (tail ? tail.split(':') : []);
  const groups = t === null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 3).map((g) => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/48';
}

async function networkHash(env, ip) {
  const prefix = networkPrefix(ip);
  // Without a salt or an address, every contribution shares one bucket, so nothing
  // unverifiable can ever reach the threshold.
  if (!prefix || !env.IP_SALT) return 'unkeyed';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.IP_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(prefix));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Shared by every threshold check. Rows from before network hashing count together as one
// network. Suppressed businesses, hidden after a removal request, never appear.
const PROMO_ROW = "(category IS NULL OR category IN ('promo', 'guess'))";
const NOT_SUPPRESSED = 'name_key NOT IN (SELECT name_key FROM suppressed)';

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
  const net = await networkHash(env, ip);

  const now = Math.floor(Date.now() / 1000);
  const stmts = [];
  const insReport = env.DB.prepare(`
    INSERT INTO reports (install_id, name_key, name, is_api, cc, created_at, updated_at, count, category, net_hash)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 1, ?7, ?8)
    ON CONFLICT(install_id, name_key) DO UPDATE SET
      updated_at = excluded.updated_at,
      count = count + 1,
      name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE name END,
      is_api = MAX(is_api, excluded.is_api),
      cc = COALESCE(excluded.cc, cc),
      category = COALESCE(excluded.category, category),
      net_hash = COALESCE(net_hash, excluded.net_hash)`);
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
    // Only official WhatsApp business accounts go on the Wall, never individuals running a
    // shop on the Business app.
    if (!raw.is_api) { rejected.push(name); continue; }
    const isApi = raw.is_api ? 1 : 0;
    const cc = /^\d{1,3}$/.test(String(raw.cc || '')) ? String(raw.cc) : null;
    const category = ['promo', 'guess', 'txn', 'api', 'smb'].includes(raw.category) ? raw.category : null;
    stmts.push(insReport.bind(install, key, name, isApi, cc, now, category, net));
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
  const min = minReporters(env);
  const t = await env.DB.prepare(`
    WITH promo AS (
      SELECT name_key,
        COUNT(DISTINCT install_id) AS installs,
        COUNT(DISTINCT COALESCE(net_hash, 'legacy')) AS nets
      FROM reports
      WHERE ${PROMO_ROW} AND ${NOT_SUPPRESSED}
      GROUP BY name_key
    ), listed AS (
      SELECT name_key FROM promo WHERE installs >= ?1 AND nets >= ?1
    )
    SELECT
      (SELECT COUNT(DISTINCT install_id) FROM reports) AS people,
      (SELECT COUNT(*) FROM listed) AS businesses,
      (SELECT COUNT(DISTINCT name_key) FROM reports) - (SELECT COUNT(*) FROM listed) AS pending,
      (SELECT COUNT(DISTINCT number_hash) FROM numbers WHERE name_key IN (SELECT name_key FROM listed)) AS numbers,
      (SELECT COALESCE(SUM(count), 0) FROM reports) AS reports`).bind(min).first();
  return { people: t.people || 0, businesses: t.businesses || 0, pending: Math.max(0, t.pending || 0), numbers: t.numbers || 0, reports: t.reports || 0, min };
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
        COUNT(DISTINCT install_id) AS people,
        MIN(
          COUNT(DISTINCT CASE WHEN ${PROMO_ROW} THEN install_id END),
          COUNT(DISTINCT CASE WHEN ${PROMO_ROW} THEN COALESCE(net_hash, 'legacy') END)
        ) AS promo_people,
        SUM(count) AS reports,
        MAX(is_api) AS is_api,
        MIN(created_at) AS first_seen,
        MAX(updated_at) AS last_seen,
        (SELECT COUNT(DISTINCT number_hash) FROM numbers n WHERE n.name_key = r.name_key) AS numbers
      FROM reports r
      WHERE r.${NOT_SUPPRESSED}
      GROUP BY r.name_key
      HAVING promo_people >= ?1
      ORDER BY promo_people DESC, people DESC, numbers DESC, reports DESC
      LIMIT 1000`).bind(minReporters(env)).all(),
    totalsRow(env),
    env.DB.prepare(`
      SELECT DISTINCT n.number_hash, n.name_key FROM numbers n
      WHERE n.name_key IN (
        SELECT name_key FROM reports
        WHERE ${PROMO_ROW} AND ${NOT_SUPPRESSED}
        GROUP BY name_key
        HAVING COUNT(DISTINCT install_id) >= ?1 AND COUNT(DISTINCT COALESCE(net_hash, 'legacy')) >= ?1
      ) LIMIT 20000`).bind(minReporters(env)).all(),
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

// ------------------------------------------------------------------ shell
const BASE_CSS = `
  :root { color-scheme: dark; --ground:#0b141a; --surface:#111b21; --line:#223038; --paper:#e9edef;
    --muted:#8696a0; --ink:#e0332b; --ok:#25d366;
    --display:"Avenir Next Condensed","Helvetica Neue Condensed","Roboto Condensed","Arial Narrow",system-ui,sans-serif;
    --body:-apple-system,"SF Pro Text",Inter,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  *,*::before,*::after { box-sizing: border-box; }
  body { margin:0; background:var(--ground); color:var(--paper); font:16px/1.6 var(--body); -webkit-font-smoothing:antialiased; }
  a { color:var(--paper); text-decoration:none; }
  .wrap { max-width:760px; margin:0 auto; padding:0 22px; }
  .topbar { border-bottom:1px solid var(--line); }
  .topbar .wrap { display:flex; align-items:center; gap:14px; height:62px; }
  .brand { display:flex; align-items:center; gap:11px; font-family:var(--display); text-transform:uppercase; letter-spacing:.16em; font-weight:700; font-size:15px; }
  .brand img { width:26px; height:26px; border-radius:7px; display:block; }
  .nav { margin-left:auto; display:flex; gap:20px; font-size:13px; color:var(--muted); }
  .nav a:hover { color:var(--paper); }
  .nav a.on { color:var(--paper); }
  footer { border-top:1px solid var(--line); margin-top:72px; padding:28px 0 56px; color:var(--muted); font-size:13px; line-height:1.7; }
  footer a { color:var(--muted); text-decoration:underline; text-underline-offset:3px; text-decoration-color:var(--line); }
  footer a:hover { color:var(--paper); }
  @media (max-width:600px){
    .brand { font-size:13px; letter-spacing:.1em; }
    .brand img { width:22px; height:22px; }
    .nav { gap:16px; font-size:12px; }
    .nav a[href="/privacy"] { display:none; }
    .wrap { padding:0 18px; }
  }
  .btn { display:inline-flex; align-items:center; justify-content:center; gap:9px; height:48px; padding:0 22px; border-radius:4px;
    background:var(--ink); color:#fff; font-family:var(--display); text-transform:uppercase; letter-spacing:.12em; font-weight:700; font-size:15px; }
  .btn:hover { background:#f0453d; }
  .btn.ghost { background:transparent; color:var(--paper); border:1px solid var(--line); }
  .btn.ghost:hover { border-color:var(--muted); }
  h2 { font-family:var(--display); text-transform:uppercase; letter-spacing:.1em; font-weight:700; font-size:13px; color:var(--muted); margin:0 0 18px; }
`;

const head = (title, desc, extraCss) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="https://dearcustomer.kanishkdan.com/launch-thumbnail.jpg">
<meta property="og:image:width" content="1280"><meta property="og:image:height" content="720">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://dearcustomer.kanishkdan.com/launch-thumbnail.jpg">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${BASE_CSS}${extraCss || ''}</style></head><body>`;

const topbar = (here) => `<div class="topbar"><div class="wrap">
  <a class="brand" href="/"><img src="/favicon.svg" alt="">Dear Customer</a>
  <nav class="nav">
    <a href="/wall" class="${here === 'wall' ? 'on' : ''}">Wall of Shame</a>
    <a href="/privacy" class="${here === 'privacy' ? 'on' : ''}">Privacy</a>
    <a href="${esc(REPO)}">GitHub</a>
  </nav></div></div>`;

const foot = () => `<footer><div class="wrap">
  <p>Dear Customer is open source. <a href="${esc(REPO)}">Read the code</a>, or <a href="${esc(REPO)}/issues">open an issue</a>.
  Not affiliated with WhatsApp or Meta. WhatsApp is a trademark of WhatsApp LLC.</p>
  <p><a href="/privacy">Privacy</a> · <a href="/wall">Wall of Shame</a> · <a href="/list.json">list.json</a></p>
</div></footer></body></html>`;

let REPO = 'https://github.com/kanishkdan/dear-customer';

// ----------------------------------------------------------------- landing
const ACTIONS = [
  ['M6 9a6 6 0 0 1 12 0v4l2 3H4l2-3z|M10 19a2 2 0 0 0 4 0|M4 4l16 16', 'Opt out',
   "WhatsApp's own stop-marketing setting, plus a STOP sent to the business. Two systems, one click."],
  ['M5 21V4|M5 4h12l-2 3.5 2 3.5H5', 'Report',
   "Reports the selected sender to WhatsApp with message context. WhatsApp decides what action to take."],
  ['M6 6l12 12|', 'Block', 'Stops messages from that number, including useful updates. Review the sender first.'],
  ['M3 4h18v4H3z|M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8|M10 12h4', 'Archive',
   'Out of your chat list. Unarchive any time.'],
];
const actionIcon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths.split('|').filter(Boolean).map((d) => d === 'M6 6l12 12' ? `<circle cx="12" cy="12" r="8.5"/><path d="${d}"/>` : `<path d="${d}"/>`).join('')}</svg>`;

async function landingPage(env) {
  REPO = env.REPO_URL || REPO;
  const store = env.STORE_URL || '';
  const videoId = /^[A-Za-z0-9_-]{11}$/.test(env.YOUTUBE_VIDEO_ID || '') ? env.YOUTUBE_VIDEO_ID : '';
  let totals = { businesses: 0, numbers: 0, people: 0, min: 3 };
  try { totals = await totalsRow(env); } catch (_) {}
  const css = `
  .hero { padding:78px 0 8px; }
  .kicker { font-family:var(--display); text-transform:uppercase; letter-spacing:.16em; font-size:12px; color:var(--muted); margin-bottom:20px; }
  .hero h1 { font-family:var(--display); font-weight:700; font-size:clamp(56px,12vw,104px); line-height:.92; letter-spacing:-.01em; margin:0; }
  .hero h1 .no { color:var(--ink); }
  .hero p.lead { font-size:19px; line-height:1.5; color:var(--paper); max-width:33em; margin:24px 0 0; }
  .cta { display:flex; gap:12px; flex-wrap:wrap; margin:30px 0 0; align-items:center; }
  .cta .note { font-size:13px; color:var(--muted); }
  .launch-film { margin:44px 0 0; }
  .film-frame { aspect-ratio:16/9; background:var(--surface); border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  .film-trigger { position:relative; display:block; width:100%; height:100%; border:0; padding:0; background:var(--surface); cursor:pointer; color:var(--paper); }
  .film-trigger img { display:block; width:100%; height:100%; object-fit:cover; }
  .film-play { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:grid; place-items:center; width:64px; height:64px; border-radius:50%; background:var(--paper); color:var(--ground); box-shadow:0 2px 20px #0006; }
  .film-play svg { width:24px; height:24px; margin-left:4px; }
  .film-trigger:hover .film-play { background:var(--ink); color:white; }
  .film-trigger:focus-visible { outline:3px solid var(--ok); outline-offset:-4px; }
  .film-frame iframe { display:block; width:100%; height:100%; border:0; }
  .launch-film figcaption { display:flex; flex-wrap:wrap; justify-content:space-between; gap:6px 20px; margin-top:10px; color:var(--muted); font-size:12px; }
  .launch-film figcaption a { color:var(--muted); text-decoration:underline; text-underline-offset:3px; }
  .faq { border-top:1px solid var(--line); }
  .faq details { border-bottom:1px solid var(--line); padding:18px 0; }
  .faq summary { cursor:pointer; font-size:15px; font-weight:600; }
  .faq summary:focus-visible { outline:2px solid var(--ok); outline-offset:5px; }
  .faq p { font-size:14px; line-height:1.65; color:#cfd6da; margin:12px 0 0; max-width:65ch; }
  .thread { margin:52px 0 0; display:grid; gap:9px; }
  .bub { max-width:81%; padding:12px 15px; border-radius:10px 10px 10px 3px; background:var(--surface); border:1px solid var(--line);
    font-size:14.5px; line-height:1.45; color:#cfd6da; }
  .bub b { color:var(--paper); font-weight:600; }
  .bub .who { display:block; font-size:11px; font-family:var(--display); text-transform:uppercase; letter-spacing:.1em; color:var(--muted); margin-bottom:5px; }
  .bub.me { max-width:none; width:max-content; border-radius:10px 10px 3px 10px; background:#0b2a20; border-color:#14503a; color:#d7f5e6; font-size:16px; font-weight:600; }
  .reply { display:flex; align-items:center; justify-content:flex-end; gap:20px; margin-top:5px; }
  .stamp { transform:rotate(-8deg); border:3px solid var(--ink); border-radius:5px; color:var(--ink);
    font-family:var(--display); text-transform:uppercase; letter-spacing:.2em; font-weight:700; font-size:22px; padding:5px 13px 4px; }
  .counts { display:flex; gap:30px; flex-wrap:wrap; margin:64px 0 0; padding:20px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
  .counts div b { font-family:var(--display); font-weight:700; font-size:30px; display:block; line-height:1; font-variant-numeric:tabular-nums; }
  .counts div span { font-size:12px; color:var(--muted); font-family:var(--display); text-transform:uppercase; letter-spacing:.1em; }
  section { margin-top:64px; }
  .acts { display:grid; gap:1px; background:var(--line); border:1px solid var(--line); border-radius:6px; overflow:hidden; }
  .act { background:var(--ground); padding:18px 20px; display:grid; grid-template-columns:26px 1fr; gap:16px; align-items:start; }
  .act svg { width:22px; height:22px; color:var(--muted); margin-top:2px; }
  .act h3 { margin:0 0 3px; font-size:15px; font-weight:600; }
  .act p { margin:0; font-size:14px; color:var(--muted); line-height:1.5; }
  .points { display:grid; gap:14px; }
  .point { display:grid; grid-template-columns:20px 1fr; gap:14px; font-size:15px; line-height:1.55; color:#cfd6da; }
  .point i { font-family:var(--display); font-weight:700; color:var(--ink); font-style:normal; font-size:14px; padding-top:2px; }
  .point b { color:var(--paper); font-weight:600; }
  @media (max-width:560px){ .stamp{ font-size:17px; letter-spacing:.14em; } .reply{ gap:12px; } .counts{ gap:22px; } }
  `;
  const b = (who, text) => `<div class="bub"><span class="who">${esc(who)}</span>${text}</div>`;
  return new Response(head('Dear Customer — WhatsApp spam, out in one click',
    'Find promotional senders on WhatsApp Web. Review the businesses, choose your actions, and take back your inbox. Free and open source.', css)
    + topbar('home') + `
<div class="wrap">
  <div class="hero">
    <div class="kicker">Chrome extension for WhatsApp Web</div>
    <h1>Dear&nbsp;Customer.<br><span class="no">No.</span></h1>
    <p class="lead">Same business. Another number. Another offer you never asked for. Find promotional senders on WhatsApp Web, see the numbers each business has used, and choose who gets bounced.</p>
    <div class="cta">
      ${store ? `<a class="btn" href="${esc(store)}">Add to Chrome</a>` : `<a class="btn" href="${esc(REPO)}">Get it on GitHub</a>`}
      <a class="btn ghost" href="/wall">See the Wall of Shame</a>
      ${store ? '' : '<span class="note">Chrome Web Store release coming soon.</span>'}
    </div>
    ${videoId ? `<figure class="launch-film" id="launch-video">
      <div class="film-frame">
        <button class="film-trigger" type="button" data-video-id="${videoId}" aria-label="Play the Dear Customer launch video on YouTube">
          <img src="/launch-thumbnail.jpg" width="1280" height="720" alt="Dear Customer. No. WhatsApp spam, bounced." decoding="async">
          <span class="film-play" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3l15 9-15 9z"/></svg></span>
        </button>
      </div>
      <figcaption><span>An unnecessarily dramatic introduction.</span><a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a></figcaption>
    </figure>
    <script>
      document.querySelector('.film-trigger').addEventListener('click', function () {
        const frame = document.createElement('iframe');
        frame.src = 'https://www.youtube-nocookie.com/embed/' + this.dataset.videoId + '?autoplay=1&rel=0&playsinline=1';
        frame.title = 'Dear Customer launch video';
        frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        frame.allowFullscreen = true;
        frame.referrerPolicy = 'strict-origin-when-cross-origin';
        this.replaceWith(frame);
        frame.focus();
      }, { once: true });
    </script>` : `<div class="thread">
      ${b('Finance Buddha', '<b>Dear Customer,</b> an exclusive loan offer has been unlocked for you. Apply now, T&amp;C apply.')}
      ${b('KreditBee', '<b>Dear Customer,</b> your pre-approved credit line of ₹2,00,000 is waiting. Zero fee, lifetime free.')}
      ${b('Finance Buddha', '<b>Dear Customer,</b> an exclusive loan offer has been unlocked for you. Apply now, T&amp;C apply.')}
      <div class="reply"><span class="stamp">Bounced</span><span class="bub me">No.</span></div>
    </div>`}
    ${totals.businesses ? `<div class="counts">
      <div><b>${totals.businesses}</b><span>on the wall</span></div>
      <div><b>${totals.numbers}</b><span>numbers burned</span></div>
      <div><b>${totals.people}</b><span>${totals.people === 1 ? 'person' : 'people'} reporting</span></div>
    </div>` : ''}
  </div>

  <section>
    <h2>What one click does</h2>
    <div class="acts">
      ${ACTIONS.map(([paths, name, body]) => `<div class="act">${actionIcon(paths)}<div><h3>${name}</h3><p>${body}</p></div></div>`).join('')}
    </div>
  </section>

  <section>
    <h2>How it knows what is an ad</h2>
    <div class="points">
      <div class="point"><i>01</i><div><b>Message labels.</b> Uses marketing, utility and authentication categories when WhatsApp makes them available.</div></div>
      <div class="point"><i>02</i><div><b>Words and buttons.</b> Looks for promotional language and calls to action. Transactional signals help distinguish order updates, OTPs and bills. These are clues, not a guarantee.</div></div>
      <div class="point"><i>03</i><div><b>You, always.</b> Nothing is acted on until you press Bounce. Review the conversation first. Untick or ignore businesses whose updates you still need; ignored senders can be restored.</div></div>
    </div>
  </section>

  <section>
    <h2>Before you bounce</h2>
    <div class="faq">
      <details open><summary>What about bookings, tickets and order updates?</summary>
        <p>Dear Customer sorts each number by everything it has sent you. A number that only sends orders, bookings or OTPs is left alone. A number that sends both offers and updates only gets WhatsApp's own marketing opt-out and, where the business offers one, a "stop promotions" button. It is never blocked or reported, and no typed STOP is sent to it, so your updates keep coming. Numbers that only send promotions get the full treatment.</p>
        <p>Version 1.0.2 and earlier blocked every number of a ticked business. If you are on one of those, leave a business you still buy from unticked or choose Ignore; your copy updates on its own within a few hours of the new version going live.</p>
      </details>
      <details><summary>Does this cost spammers money?</summary>
        <p>Dear Customer makes no promise about a business's marketing budget. It brings together opt-out requests, reporting, blocking and optional public reports of repeat spam. WhatsApp decides how to enforce reports; the Wall makes the pattern visible.</p>
      </details>
    </div>
  </section>

  <section>
    <h2>What it will not do</h2>
    <div class="points">
      <div class="point"><i>—</i><div><b>Upload private chats to Dear Customer.</b> Analysis runs in your browser. Choosing Report can send message context to WhatsApp. Wall contributions contain business names and hashed sender numbers; sharing is optional.</div></div>
      <div class="point"><i>—</i><div><b>Run an outreach campaign.</b> Opt-out requests and STOP replies go to selected existing senders. STOP replies are capped and can be switched off.</div></div>
      <div class="point"><i>—</i><div><b>Name a business on one person's say-so.</b> The Wall needs ${totals.min} separate users on different networks before a business is listed, and only official WhatsApp business accounts can be added.</div></div>
    </div>
  </section>
</div>` + foot(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// ----------------------------------------------------------------- privacy
function privacyPage(env) {
  const repo = env.REPO_URL || '#';
  const html = head('Dear Customer · Privacy', 'What Dear Customer stores, what it sends, and when.', `
  .wrap { padding-top: 44px; padding-bottom: 20px; max-width: 700px; }
  h1 { font-family: var(--display); text-transform: uppercase; letter-spacing: .04em; font-size: 38px; font-weight: 700; margin: 0 0 8px; }
  h2 { font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-size: 12px; color: var(--muted); margin: 38px 0 10px; }
  p, li { color: #cfd6da; font-size: 15.5px; }
  li { margin-bottom: 6px; }
  b { color: var(--paper); font-weight: 600; }
  a { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line); }
  .muted { color: var(--muted); font-size: 13px; }
`) + topbar('privacy') + `<div class="wrap">
  <h1>Privacy</h1>
  <p class="muted">The Chrome extension and this website. Last updated 14 September 2026.</p>

  <h2>The short version</h2>
  <p>Dear Customer runs inside your browser. It processes recent WhatsApp Web messages, sender names, phone numbers and chat metadata locally to identify business senders and promotional messages. Message text can include personal communications and sensitive information already present in those chats; it is not uploaded to the Dear Customer service. You choose which senders and actions to run, whether to contribute business names and hashed numbers to the Wall, open an X draft containing aggregate results, or save an image card to share yourself.</p>

  <h2>Actions through WhatsApp</h2>
  <p>Selected actions use your existing WhatsApp Web session. Opt-out requests and STOP replies are sent through WhatsApp to the selected business. Choosing Report uses WhatsApp's reporting feature and can send the selected sender's message context to WhatsApp. Block and archive requests, and delete requests from versions before 1.0.3, are also handled by WhatsApp. These actions are separate from contributing to the Wall and are subject to WhatsApp's own privacy policy.</p>

  <h2>What the extension stores on your computer</h2>
  <ul>
    <li>A list of business and unknown senders it has seen, with their names, phone numbers, chat identifiers and first-seen times, so it can group senders and count how many numbers they have used across weeks.</li>
    <li>A random identifier, generated once, used only so the public list can count one person once.</li>
    <li>A cached copy of the public list.</li>
    <li>Your action choices, ignored businesses, run history, and automatic Wall contribution preference.</li>
  </ul>
  <p>All of this lives in Chrome's extension storage on your device. Removing the extension deletes it.</p>

  <h2>What is sent to this website, and when</h2>
  <p>When you press <b>Add to the Wall</b>, or enable automatic contribution after future runs, the extension sends the following for the eligible businesses you select:</p>
  <ul>
    <li>The business name exactly as WhatsApp shows it.</li>
    <li>A SHA-256 hash of the digits of each number that business used. The number itself is never sent.</li>
    <li>Whether WhatsApp marks it as an official Business Platform account, its promotional-message category, and a country-code guess based on the business sender's number.</li>
    <li>Your random identifier.</li>
  </ul>
  <p>Wall contributions do not upload your own account name or phone number, your address book, message content, or businesses you did not choose to contribute. Submitted sender display names are shared as shown in WhatsApp and may identify an individual operating a business. The extension also downloads the public list, cached for six hours, and refreshes it after a contribution.</p>

  <h2>Sharing results</h2>
  <p><b>Post to X</b> opens X with aggregate results from your run and the Dear Customer website link. It does not include message content, phone numbers, or business names in the draft. You review and publish the post yourself. X receives the draft text when you open it, and its own privacy policy applies.</p>
  <p><b>Save share card</b> and <b>Save chart</b> create image files locally. They can include business names and counts, but no message content or phone numbers. Dear Customer does not upload these files. You choose where to share them.</p>

  <h2>What this website keeps</h2>
  <p>The reports above, including contribution counts and timestamps, are stored in a database for as long as the list exists. A business is only named on the public page once at least three separate installations, on different networks, have reported it for promotional messages, and only official WhatsApp business accounts can be listed; below that its reports are stored but never published, and the numbers it used are not published either. The public page shows business names and counts. Hashes are published in <code>list.json</code> so the extension can match numbers. Hashing does not guarantee anonymity: someone can hash a candidate phone number and compare it with the published value. Our hosting provider, Cloudflare, processes request metadata, including IP addresses, for delivery, logs, abuse prevention and rate limiting. To tell networks apart, each contribution also stores a keyed hash of the network part of the IP address it came from; the address itself is not stored. Businesses can be hidden after a removal request.</p>

  <h2>Limited Use</h2>
  <p>Dear Customer's use of information received through Chrome extension permissions complies with the Chrome Web Store User Data Policy, including its Limited Use requirements. Data is used only to provide the extension's disclosed spam-management, history and optional sharing features. It is not sold, used for advertising or unrelated profiling, or used to determine creditworthiness or for lending. Transfers occur only as needed for these disclosed features, with the user's choices described above, or when required for security or by law. The developer does not receive or read private message content through the extension.</p>

  <h2>Removal</h2>
  <p>If a business is listed and you believe that is wrong, or you run that business, <a href="${esc(repo)}/issues/new?title=Removal%20request">open a removal request</a>. Entries come from users, not from the site operator.</p>

  <h2>Third parties</h2>
  <p>Dear Customer does not add analytics or advertising trackers. The site runs on Cloudflare. Where a launch video is available, its preview image is served by this site. YouTube is contacted only when you choose to play the video or open its link. Playback uses YouTube's privacy-enhanced embedded player; YouTube receives request and playback information and its own privacy policy applies. The extension uses <a href="https://github.com/wppconnect-team/wa-js">wa-js</a>, an open-source library, bundled locally. Dear Customer is not affiliated with WhatsApp or Meta.</p>

  <h2>Contact</h2>
  <p>Questions go to the <a href="${esc(repo)}/issues">issue tracker</a>.</p>
</div>` + foot();
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

// -------------------------------------------------------------------- page
async function wallPage(env) {
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
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="#aebac1" stroke-width="1.5" vector-effect="non-scaling-stroke"/><path d="M${last[0].toFixed(1)},${last[1].toFixed(1)} h0.01" stroke="#e9edef" stroke-width="5" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
  };
  const columns = (days, values) => {
    if (!values || !values.length) return '';
    const n = values.length, max = Math.max(1, ...values);
    const bars = values.map((v, i) => {
      const pct = v ? Math.max(4, Math.round((v / max) * 100)) : 0;
      return `<span class="col${v ? '' : ' zero'}" style="height:${pct}%" title="${esc(days[i])} · ${v} ${v === 1 ? 'report' : 'reports'}"></span>`;
    }).join('');
    return `<div class="cols" role="img" aria-label="Reports per day, last 30 days">${bars}</div>
      <div class="axis"><span>${esc(days[0])}</span><span>peak ${max} in a day</span><span>${esc(days[n - 1])}</span></div>`;
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
    : `<tr><td colspan="5" class="empty">Nothing listed yet.${data.totals.pending ? ` ${data.totals.pending} ${data.totals.pending === 1 ? 'business has' : 'businesses have'} been reported but ${data.totals.pending === 1 ? 'has' : 'have'} not reached ${data.totals.min} people yet.` : ' Be the first to bounce someone.'}</td></tr>`;

  const html = head('Dear Customer · Wall of Shame',
    'Businesses that spam WhatsApp, ranked by how many people bounced them for promotions and how many numbers they burned.', `
  .wrap { padding-top: 44px; padding-bottom: 20px; max-width: 880px; }
  h1 { font-family: var(--display); text-transform: uppercase; letter-spacing: .04em; font-size: 40px; font-weight: 700; margin: 0 0 10px; }
  .sub { color: var(--muted); margin: 0 0 30px; max-width: 60ch; font-size: 15px; }
  .sub b { color: var(--paper); font-weight: 600; }
  .sub a { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line); }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px; }
  .stat .n { font-family: var(--display); font-size: 32px; font-weight: 700; line-height: 1; color: var(--paper); font-variant-numeric: tabular-nums; }
  .stat .l { font-family: var(--display); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); margin-top: 7px; }
  .stat .spark { display: block; width: 100%; height: 28px; margin-top: 10px; }
  .activity { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 14px 16px 12px; margin-bottom: 24px; }
  .activity .l { font-family: var(--display); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); margin-bottom: 10px; display: flex; justify-content: space-between; }
  .activity .cols { display: flex; align-items: flex-end; gap: 3px; height: 92px; border-bottom: 1px solid var(--line); }
  .activity .col { flex: 1; min-width: 0; background: var(--ink); border-radius: 3px 3px 0 0; }
  .activity .col.zero { background: #1a2730; height: 2px !important; }
  .activity .axis { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-top: 8px; font-variant-numeric: tabular-nums; }
  .tbl { overflow-x: auto; border: 1px solid var(--line); border-radius: 6px; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); }
  th, td { padding: 13px 15px; text-align: left; border-bottom: 1px solid var(--line); }
  th { font-family: var(--display); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); font-weight: 700; background: #0e171d; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  td.rank { font-family: var(--display); color: var(--muted); font-weight: 700; width: 46px; }
  td.name { font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th.num { text-align: right; }
  td.burned { font-family: var(--display); font-size: 19px; color: var(--ink); font-weight: 700; }
  td.people { font-family: var(--display); font-size: 19px; color: var(--ok); font-weight: 700; }
  .muted { color: var(--muted); }
  .tag { font-family: var(--display); font-size: 10px; font-weight: 700; letter-spacing: .08em; padding: 2px 6px; border-radius: 3px; background: rgba(224,51,43,.16); color: #ff6b62; vertical-align: middle; }
  .empty { color: var(--muted); text-align: center; padding: 44px 16px !important; }
  .cta { margin: 26px 0 0; padding: 18px 20px; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; display: flex; gap: 18px; align-items: center; flex-wrap: wrap; font-size: 14px; color: var(--muted); }
  .cta b { color: var(--paper); font-weight: 600; }
  .cta .btn { height: 40px; padding: 0 18px; font-size: 13px; }
  .smallprint { color: var(--muted); font-size: 13px; margin-top: 26px; line-height: 1.65; }
  .smallprint b { color: #aebac1; font-weight: 600; }
  .smallprint a { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line); }
  @media (max-width: 640px) { .stats { grid-template-columns: repeat(2, 1fr); } h1 { font-size: 30px; } }
`) + topbar('wall')
 + `<div class="wrap">
  <h1>Wall of Shame</h1>
  <p class="sub">Ranked by how many people bounced them for promotional WhatsApp messages, and how many different numbers they burned doing it. <b>A business is named here only once ${data.totals.min} separate users, on different networks, have bounced it</b>, and only official WhatsApp business accounts can be listed. Reported anonymously by people running <a href="/">Dear Customer</a>.</p>
  <div class="stats">
    <div class="stat"><div class="n">${data.totals.businesses}</div><div class="l">Listed</div>${S ? spark(S.businesses.cumulative) : ''}</div>
    <div class="stat"><div class="n">${data.totals.numbers}</div><div class="l">Numbers burned</div>${S ? spark(S.numbers.cumulative) : ''}</div>
    <div class="stat"><div class="n">${data.totals.people}</div><div class="l">People reporting</div>${S ? spark(S.people.cumulative) : ''}</div>
    <div class="stat"><div class="n">${data.totals.pending}</div><div class="l">Below ${data.totals.min}, not shown</div>${S ? spark(S.reports.cumulative) : ''}</div>
  </div>
  ${S ? `<div class="activity"><div class="l"><span>Reports per day</span><span>last 30 days</span></div>${columns(S.days, S.reports.daily)}</div>` : ''}
  <div class="tbl"><table>
    <thead><tr><th>#</th><th>Business</th><th class="num">People bounced for promos</th><th class="num">Numbers burned</th><th class="num">Last seen</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table></div>
  <div class="cta">
    <div style="flex:1;min-width:240px"><b>Add yours.</b> Install Dear Customer on WhatsApp Web, bounce the businesses spamming you, and press "Add to the Wall of Shame".</div>
    <a class="btn" href="/">How it works</a>
  </div>
  <div class="smallprint">
    <p><b>What's stored.</b> The business name exactly as WhatsApp shows it, a SHA-256 hash of each number it used, whether it's an official Business Platform account, the country code, a random id per browser, and a keyed hash of the network part of the reporter's IP address, so one person can't be counted three times. No phone numbers, no message content, no identity of the person reporting.</p>
    <p><b>Counting.</b> The main count is people who bounced the business for promotional messages, and it has to reach ${data.totals.min} before the business appears at all. A grey +N is people who bounced it for something else, such as alerts they didn't want. Only the promotional count ranks. Reports below the threshold are stored but never published, and the numbers they used are not published either.</p>
    <p><b>Listed and think it's wrong?</b> <a href="${esc(repo)}/issues/new?title=Removal%20request">Open a removal request</a>. Entries come from users, not from us.</p>
    <p><a href="/privacy">Privacy</a> · <a href="${esc(repo)}">Source on GitHub</a> · <code>GET /list.json</code> is public if you want the data. Not affiliated with WhatsApp or Meta.</p>
  </div>
</div>` + foot();
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
