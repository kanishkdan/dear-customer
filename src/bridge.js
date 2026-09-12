// Bouncer — isolated-world bridge. The engine runs in the page's MAIN world so it
// can reach wa-js, but only this script can touch chrome.* APIs. They talk over
// window.postMessage with a __bouncer marker.
(() => {
  const KEY = 'bouncer.history';
  const send = (type, payload) =>
    window.postMessage({ __bouncer: true, dir: 'to-page', type, payload }, '*');

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__bouncer || ev.data.dir !== 'to-ext') return;
    const { type, payload } = ev.data;
    try {
      if (type === 'ready') {
        const r = await chrome.storage.local.get(KEY);
        send('history', r[KEY] || null);
      } else if (type === 'save') {
        await chrome.storage.local.set({ [KEY]: payload });
      } else if (type === 'badge') {
        await chrome.runtime.sendMessage({ type: 'badge', text: payload });
      } else if (type === 'inject') {
        const r = await chrome.runtime.sendMessage({ type: 'inject' });
        send('injected', r || { ok: false, error: 'no reply' });
      } else if (type === 'community') {
        const r = await chrome.runtime.sendMessage({ type: 'community', force: !!(payload && payload.force) });
        send('community', r || { ok: false, error: 'no reply' });
      } else if (type === 'report') {
        const r = await chrome.runtime.sendMessage({ type: 'report', items: payload });
        send('reported', r || { ok: false, error: 'no reply' });
      }
    } catch (_) {
      // Extension was reloaded under a live tab; the page will retry on next load.
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'open') send('open');
  });
})();
