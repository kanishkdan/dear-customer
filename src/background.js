// Dear Customer — service worker. Only two jobs: open the panel when the toolbar icon
// is clicked, and paint the badge count the page reports.
const WA = 'https://web.whatsapp.com/';
const LIST_URL = 'https://dearcustomer.kanishkdan.com';
const LIST_TTL_MS = 6 * 60 * 60 * 1000;

// Random id per browser so the public list can count people without knowing who they are.
async function getInstallId() {
  const r = await chrome.storage.local.get('bouncer.install');
  if (r['bouncer.install']) return r['bouncer.install'];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ 'bouncer.install': id });
  return id;
}

async function getCommunity(force) {
  const r = await chrome.storage.local.get('bouncer.community');
  const c = r['bouncer.community'];
  if (!force && c && c.data && Date.now() - c.fetchedAt < LIST_TTL_MS) return c.data;
  const res = await fetch(LIST_URL + '/list.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('list fetch failed: ' + res.status);
  const data = await res.json();
  await chrome.storage.local.set({ 'bouncer.community': { fetchedAt: Date.now(), data } });
  return data;
}

async function postReport(items) {
  const install = await getInstallId();
  const res = await fetch(LIST_URL + '/report', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ install, items }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || ('report failed: ' + res.status));
  return body;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab && tab.id != null && tab.url && tab.url.startsWith(WA)) {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'open' }); } catch (_) { /* content script not there yet */ }
    return;
  }
  chrome.tabs.create({ url: WA });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !sender.tab || sender.tab.id == null) return;
  const tabId = sender.tab.id;
  const handlers = {
    // wa-js is injected only once the chat list exists. Injecting on the QR page
    // makes wa-js cache WhatsApp's lazily loaded core modules as missing.
    inject: () => chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/wppconnect-wa.js'] }).then(() => ({ ok: true })),
    badge: async () => {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ff3b30' });
      await chrome.action.setBadgeText({ tabId, text: msg.text ? String(msg.text) : '' });
      return { ok: true };
    },
    community: () => getCommunity(!!msg.force).then((data) => ({ ok: true, data, url: LIST_URL })),
    report: () => postReport(msg.items).then((r) => ({ ok: true, ...r, url: LIST_URL })),
  };
  const h = handlers[msg.type];
  if (!h) return;
  h().then(reply).catch((e) => reply({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
