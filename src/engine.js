/*
 * Bouncer — page engine. Runs in WhatsApp Web's own JS context next to wa-js.
 *
 * Flow: scan chats -> classify senders -> group by business -> user ticks ->
 * per number: WhatsApp's marketing opt-out -> STOP (button or text, latest live
 * number only) -> report -> block -> delete chat.
 *
 * Nothing leaves the browser except WhatsApp's own traffic and, only when the
 * user presses "Add to the Wall of Shame", business names plus hashed numbers.
 */
(() => {
  'use strict';
  if (window.__bouncerLoaded) return;
  window.__bouncerLoaded = true;

  const VERSION = '1.0.0';
  const STOP_TEXT = 'STOP';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowSec = () => Math.floor(Date.now() / 1000);

  // ------------------------------------------------------------------ state
  const state = {
    open: false,
    days: 7,                   // 0 = all time
    filter: 'promo',           // 'promo' | 'all'
    actions: { optout: true, stop: true, report: true, block: true, del: true },
    groups: [],
    scanned: false,
    scanning: false,
    scanError: null,
    running: false,
    progress: null,
    results: null,
    history: { seen: {}, runs: [] },
    historyLoaded: false,
    scanStats: null,
    scanProgress: null,
    community: null,           // { byKey, hashes, totals, url, updated }
    communityStatus: 'idle',   // 'idle' | 'ok' | 'error'
    reportSel: {},             // group key -> bool, for "add to the public list"
    reportStatus: null,        // null | 'sending' | { ok, totals } | { error }
    cancel: false,             // set by the Stop button during a run
    notice: null,              // transient one-line message under the toolbar
    view: 'list',              // 'list' | 'chart'
    expanded: false,           // wide mode: list on the left, dashboard on the right
    activeId: null,            // number currently being bounced
    armed: false,              // second-click confirm when the selection includes non-promotional rows
    inject: 'idle',           // 'idle' | 'requested' | 'done' | 'failed'
    injectError: null,
  };

  // ------------------------------------------------------------ bridge i/o
  const toExt = (type, payload) =>
    window.postMessage({ __bouncer: true, dir: 'to-ext', type, payload }, '*');

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || !ev.data.__bouncer || ev.data.dir !== 'to-page') return;
    const { type, payload } = ev.data;
    if (type === 'history') {
      state.historyLoaded = true;
      if (payload && typeof payload === 'object') {
        state.history = { seen: payload.seen || {}, runs: payload.runs || [], bounced: payload.bounced || {}, autoReport: !!payload.autoReport };
      }
      render();
    } else if (type === 'open') {
      openPanel();
    } else if (type === 'community') {
      if (payload && payload.ok && payload.data) {
        const d = payload.data;
        const byKey = {};
        for (const b of d.businesses || []) byKey[b.key] = b;
        state.community = { byKey, hashes: d.hashes || {}, totals: d.totals || {}, url: payload.url, updated: d.updated };
        state.communityStatus = 'ok';
      } else {
        state.communityStatus = 'error';
      }
      render();
    } else if (type === 'reported') {
      if (payload && payload.ok) {
        state.reportStatus = { ok: true, accepted: payload.accepted, totals: payload.totals, url: payload.url };
        toExt('community', { force: true });
      } else {
        state.reportStatus = { error: (payload && payload.error) || 'unknown' };
      }
      render();
    } else if (type === 'injected') {
      if (payload && payload.ok) { state.inject = 'done'; }
      else { state.inject = 'failed'; state.injectError = (payload && payload.error) || 'unknown'; }
      render();
    }
  });

  function requestHistory() {
    let tries = 0;
    const tick = () => {
      if (state.historyLoaded || tries++ > 6) return;
      toExt('ready');
      setTimeout(tick, 800 * tries);
    };
    tick();
  }

  function requestCommunity() {
    let tries = 0;
    const tick = () => {
      if (state.communityStatus !== 'idle' || tries++ > 5) return;
      toExt('community');
      setTimeout(tick, 1500 * tries);
    };
    tick();
  }

  async function sha256Hex(str) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) { return null; }
  }

  // Country code guess from the digits. Good enough for a leaderboard filter, never used for matching.
  const ccOf = (phone) => {
    if (!phone) return null;
    if (phone.length === 12 && phone.startsWith('91')) return '91';
    if (phone.length === 11 && phone.startsWith('1')) return '1';
    return phone.length >= 12 ? phone.slice(0, 2) : phone.slice(0, 1);
  };

  function saveHistory() { toExt('save', state.history); }
  function setBadge(text) { toExt('badge', text); }

  // ----------------------------------------------------------- wa-js status
  // WhatsApp Web logs in without a page reload, so we watch the DOM for the chat
  // list pane and only then ask the background worker to inject wa-js.
  function loggedInDom() {
    return !!(document.getElementById('pane-side')
      || document.querySelector('[aria-label="Chat list"], [data-tab="3"], #side'));
  }
  // The login screen is the one place the pill is noise. Only hide it when a QR
  // canvas is on screen and no chat pane is, so an unknown future layout keeps it.
  const loginScreen = () => !loggedInDom() && !!document.querySelector('canvas');

  function status() {
    const W = window.WPP;
    if (!W || !W.isInjected) {
      if (state.inject === 'failed') return 'inject-failed';
      return loggedInDom() ? 'loading' : 'unauthenticated';
    }
    if (!W.isReady) return 'loading';
    let auth = false;
    try { auth = !!(W.conn && W.conn.isAuthenticated && W.conn.isAuthenticated()); } catch (_) {}
    if (!auth) return 'unauthenticated';
    let main = !!W.isFullReady;
    if (!main) { try { main = !!(W.conn.isMainReady && W.conn.isMainReady()); } catch (_) {} }
    return main ? 'ready' : 'syncing';
  }

  // Polls until wa-js reports the main app ready. No timeout on purpose: the user
  // may sit on the QR screen for a while, and login happens without a page reload.
  function waitForReady() {
    return new Promise((resolve) => {
      let last = null;
      const tick = () => {
        const s = status();
        if (s !== last) { last = s; render(); }
        else if (pill) pill.hidden = state.open || loginScreen();   // the QR canvas appears after mount
        if (s === 'ready') return resolve(true);
        setTimeout(tick, 1000);
      };
      tick();
    });
  }

  // ---------------------------------------------------------------- helpers
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const normName = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

  function widStr(wid) {
    if (!wid) return '';
    if (typeof wid === 'string') return wid;
    if (wid._serialized) return wid._serialized;
    try { return String(wid.toString()); } catch (_) { return ''; }
  }

  function lastTs(chat) {
    if (typeof chat.t === 'number' && chat.t > 0) return chat.t;
    try {
      const arr = chat.msgs && chat.msgs.getModelsArray && chat.msgs.getModelsArray();
      if (arr && arr.length) return arr[arr.length - 1].t || 0;
    } catch (_) {}
    return 0;
  }

  function displayName(contact, chat) {
    return (contact && (contact.verifiedName || contact.pushname || contact.name || contact.formattedName))
      || (chat && (chat.formattedTitle || chat.name)) || null;
  }

  async function phoneFor(id, contact) {
    if (id.endsWith('@c.us')) return id.split('@')[0];
    try {
      const pn = contact && contact.phoneNumber;
      const s = widStr(pn);
      if (s && s.includes('@')) return s.split('@')[0];
    } catch (_) {}
    try {
      const e = await window.WPP.contact.getPnLidEntry(id);
      const pn = e && (e.pn || e.phoneNumber || e.pnWid);
      const s = widStr(pn);
      if (s && s.includes('@')) return s.split('@')[0];
    } catch (_) {}
    return null;
  }

  const TYPE_LABELS = {
    template: 'Marketing message', hsm: 'Marketing message', interactive: 'Marketing message', notification_template: 'Notification',
    image: 'Photo', video: 'Video', document: 'Document', audio: 'Voice message', ptt: 'Voice message', sticker: 'Sticker',
    location: 'Location', vcard: 'Contact card', product: 'Product', order: 'Order', list: 'Message with options',
    buttons_response: 'Reply', list_response: 'Reply', poll_creation: 'Poll', revoked: 'Deleted message', ciphertext: 'Message',
  };
  // Media messages keep their thumbnail as base64 in `body`; templates already have
  // their text converted into `body`. System notices are not content at all.
  const MEDIA_TYPES = new Set(['image', 'video', 'sticker', 'document', 'audio', 'ptt', 'gif']);
  const NON_CONTENT = new Set(['notification_template', 'e2e_notification', 'gp2', 'call_log', 'protocol', 'revoked', 'ciphertext', 'notification']);
  const looksLikeBlob = (t) => /^\/9j\//.test(t) || /^data:/.test(t) || (t.length > 80 && /^[A-Za-z0-9+/=\s]+$/.test(t));
  const isContent = (m) => !NON_CONTENT.has(String(attrOf(m, 'type') || ''));
  function msgText(m) {
    if (!m) return '';
    const type = String(attrOf(m, 'type') || '');
    const caption = String(attrOf(m, 'caption') || '');
    const body = String(attrOf(m, 'body') || '');
    let t = MEDIA_TYPES.has(type) ? caption : (body || caption);
    if (looksLikeBlob(t)) t = caption && !looksLikeBlob(caption) ? caption : '';
    return t.replace(/\s+/g, ' ').trim();
  }
  function previewOf(m) {
    if (!m) return { text: '', sys: false };
    const type = String(attrOf(m, 'type') || '');
    const text = msgText(m);
    if (text && !/^\[.*\]$/.test(text)) return { text: text.slice(0, 180), sys: false };
    return { text: TYPE_LABELS[type] || (type ? 'Message' : ''), sys: true };
  }

  const fmtPhone = (p) => {
    if (!p) return 'hidden number';
    const d = String(p).replace(/\D/g, '');
    if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
    if (d.length === 11 && d.startsWith('1')) return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
    return '+' + d;
  };
  const fmtAgo = (ts) => {
    if (!ts) return '';
    const d = Math.max(0, nowSec() - ts);
    if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
    return new Date(ts * 1000).toLocaleDateString();
  };

  function seenCount(group) {
    const e = state.history.seen[group.key];
    const fromHistory = e ? Object.keys(e.numbers || {}).length : 0;
    return Math.max(fromHistory, group.numbers.length);
  }

  // -------------------------------------------------------------------- scan
  // Business detection uses three signals, because WhatsApp Web populates the
  // contact flags lazily and unevenly:
  //   1. contact flags on the chat's contact and, for @lid chats, its phone-number twin
  //   2. business markers on inbound messages (templates, buttons, verified biz name)
  //   3. sender not in your address book -> listed separately as "unknown number"
  const BIZ_MSG_TYPES = new Set(['template', 'hsm', 'interactive', 'interactive_response', 'buttons_response',
    'template_button_reply', 'list', 'list_response', 'product', 'order', 'catalog', 'ptv']);

  function attrOf(model, key) {
    if (!model) return undefined;
    try { const v = model[key]; if (v !== undefined) return v; } catch (_) {}
    try { const a = model.attributes; if (a && a[key] !== undefined) return a[key]; } catch (_) {}
    return undefined;
  }

  function contactFlags(c) {
    const g = (k) => attrOf(c, k);
    const lvl = g('verifiedLevel');
    return {
      isBusiness: !!g('isBusiness'), isEnterprise: !!g('isEnterprise'), isSmb: !!g('isSmb'),
      verifiedName: g('verifiedName') || null, verifiedLevel: lvl == null ? null : lvl,
      isMyContact: g('isMyContact'), isPSA: !!g('isPSA'),
      marketingThread: !!g('isMarketingMessageThread'), optedOut: !!g('isContactOptedOut'),
      pushname: g('pushname') || null, name: g('name') || null, formattedName: g('formattedName') || null,
      phoneNumber: widStr(g('phoneNumber')) || null,
    };
  }

  function mergeFlags(a, b) {
    return {
      isBusiness: a.isBusiness || b.isBusiness, isEnterprise: a.isEnterprise || b.isEnterprise, isSmb: a.isSmb || b.isSmb,
      verifiedName: a.verifiedName || b.verifiedName, verifiedLevel: a.verifiedLevel != null ? a.verifiedLevel : b.verifiedLevel,
      isMyContact: a.isMyContact === undefined ? b.isMyContact : (a.isMyContact || b.isMyContact), isPSA: a.isPSA || b.isPSA,
      marketingThread: a.marketingThread || b.marketingThread, optedOut: a.optedOut || b.optedOut,
      pushname: a.pushname || b.pushname, name: a.name || b.name, formattedName: a.formattedName || b.formattedName,
      phoneNumber: a.phoneNumber || b.phoneNumber,
    };
  }

  function msgSignals(m) {
    if (!m) return { biz: false, name: null };
    const g = (k) => attrOf(m, k);
    const t = String(g('type') || ''); const st = String(g('subtype') || '');
    const name = g('verifiedBizName') || null;
    const biz = !!(name || g('bizPrivacyStatus') || g('isFromTemplate') || g('hydratedButtons') || g('templateButtons')
      || g('bizAttributeName') || g('interactiveMessage') || g('templateMessage')
      || BIZ_MSG_TYPES.has(t) || BIZ_MSG_TYPES.has(st)
      || (g('footer') && (g('buttons') || g('hydratedButtons') || g('nativeFlowButtons'))));
    return { biz, name };
  }

  const isInbound = (m) => !((attrOf(m, 'id') && attrOf(m, 'id').fromMe) || attrOf(m, 'fromMe'));

  // WhatsApp stamps every template message with the category the business declared
  // to Meta: marketing, utility or authentication. That is the promotional split.
  let HSM = null;
  function hsmEnum() {
    if (HSM) return HSM;
    try { const e = window.require && window.require('WAWebBusinessHSMTypes'); if (e && e.HSM_TAG_TYPE) HSM = e.HSM_TAG_TYPE; } catch (_) {}
    return HSM;
  }
  // Keyword lists live in src/keywords.js so they can be edited without touching
  // this file. Entries starting with "re:" are regular expressions, the rest are
  // literal phrases. A promo hit beats a utility tag on purpose: businesses
  // register ad templates as utility to dodge marketing pricing.
  const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const toSource = (entry) => (String(entry).startsWith('re:') ? String(entry).slice(3) : escapeRe(String(entry)));
  const listRe = (entries, flags) => new RegExp(`\\b(?:${entries.map(toSource).join('|')})\\b`, flags);
  const KW = (window.__bouncerKeywords && typeof window.__bouncerKeywords === 'object') ? window.__bouncerKeywords : {};
  const PROMO_RE = listRe(Array.isArray(KW.promotional) && KW.promotional.length ? KW.promotional : ['offer', 'loan', 'discount', 'apply now', 'buy now'], 'gi');
  const TXN_RE = listRe(Array.isArray(KW.transactional) && KW.transactional.length ? KW.transactional : ['otp', 'delivered', 'invoice', 'statement', 'bill'], 'gi');
  const OPT_OUT_TIERS = (KW.optOutButtons && typeof KW.optOutButtons === 'object') ? KW.optOutButtons : {};
  const optOutTier = (name, fallback) => { const l = Array.isArray(OPT_OUT_TIERS[name]) && OPT_OUT_TIERS[name].length ? OPT_OUT_TIERS[name] : fallback; return new RegExp(`(?:${l.map(toSource).join('|')})`, 'i'); };
  const OPT_STRONG = optOutTier('strong', ['disable all', 'stop all']);
  const OPT_MEDIUM = optOutTier('medium', ['unsubscribe', 're:opt[- ]?out']);
  const OPT_NORMAL = optOutTier('normal', ['re:stop (?:messages|promotions|offers|marketing)']);
  const OPT_SOFT = optOutTier('soft', ['not interested', 'no thanks']);
  const OPT_BARE = optOutTier('bare', ['re:^stop$']);

  function buttonsOf(m) {
    const hb = attrOf(m, 'hydratedButtons') || attrOf(m, 'templateButtons') || attrOf(m, 'nativeFlowButtons') || attrOf(m, 'buttons');
    if (!hb) return [];
    try { return Array.isArray(hb) ? hb : (hb.toArray ? hb.toArray() : (hb.getModelsArray ? hb.getModelsArray() : [])); } catch (_) { return []; }
  }
  function textOf(m) {
    const parts = [msgText(m), attrOf(m, 'footer'), attrOf(m, 'title'), attrOf(m, 'description')];
    for (const b of buttonsOf(m)) {
      try {
        const u = b.urlButton || b.callButton || b.quickReplyButton || b;
        parts.push(u.displayText || u.text || b.displayText || b.text || (b.nativeFlowInfo && b.nativeFlowInfo.name));
      } catch (_) {}
    }
    return parts.filter(Boolean).map(String).join(' ');
  }
  function hasCta(m) {
    return buttonsOf(m).some((b) => { try { return !!(b.urlButton || (b.nativeFlowInfo && /cta_url|cta_call|cta_copy/.test(String(b.nativeFlowInfo.name || '')))); } catch (_) { return false; } });
  }
  const countRe = (re, text) => { re.lastIndex = 0; let n = 0; while (re.exec(text)) n++; return n; };

  function msgCategory(m) {
    const E = hsmEnum();
    const norm = (v) => (v == null ? '' : String(v).toUpperCase());
    let tag = null;
    for (const v of [attrOf(m, 'hsmTag'), attrOf(m, 'hsmCategory')]) {
      if (v == null || v === '') continue;
      const n = norm(v);
      if ((E && v === E.MARKETING) || n.includes('MARKETING')) { tag = 'marketing'; break; }
      if ((E && v === E.UTILITY) || n.includes('UTILITY')) { tag = 'utility'; break; }
      if ((E && v === E.AUTHENTICATION) || n.includes('AUTH')) { tag = 'auth'; break; }
    }
    if (tag === 'marketing') return 'marketing';
    if (tag === 'auth') return 'auth';
    const text = textOf(m);
    const promo = countRe(PROMO_RE, text);
    const txn = countRe(TXN_RE, text);
    // Ties go to alerts: a statement that mentions a credit card is still a statement.
    if (promo >= 1 && promo > txn) return 'promo-guess';
    if (txn === 0 && hasCta(m)) return 'promo-guess';
    if (tag === 'utility' || txn >= 1) return 'utility';
    return null;
  }

  const ACTION_TIMEOUT_MS = 8000;
  const log = (...a) => { try { console.log('[Bouncer]', ...a); } catch (_) {} };

  // Every WhatsApp call gets a hard timeout. A hung internal promise must never
  // freeze the whole run; it becomes a 'timeout' result and we move on.
  function withTimeout(promise, ms, label) {
    let timer;
    const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout after ${ms}ms in ${label}`)), ms); });
    return Promise.race([promise, t]).finally(() => clearTimeout(timer));
  }

  async function step(n, key, label, fn, ms = ACTION_TIMEOUT_MS) {
    const started = Date.now();
    try {
      const r = await withTimeout(Promise.resolve().then(fn), ms, label);
      if (n.result[key] !== 'already') n.result[key] = true;
      log(label, 'ok', `${Date.now() - started}ms`, n.id, r === undefined ? '' : r);
      return true;
    } catch (e) {
      const msg = String((e && e.message) || e);
      n.result[key] = /^timeout/.test(msg) ? 'timeout' : false;
      n.errors = n.errors || {}; n.errors[key] = msg;
      log(label, 'FAILED', `${Date.now() - started}ms`, n.id, msg);
      return false;
    }
  }

  async function mapPool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; try { await fn(items[idx], idx); } catch (_) { /* per-item errors are non-fatal */ } }
    });
    await Promise.all(workers);
  }

  async function scan() {
    if (state.scanning || state.running) { log('scan skipped', { scanning: state.scanning, running: state.running }); return; }
    if (status() !== 'ready') { render(); return; }
    state.scanning = true; state.scanError = null; state.results = null;
    state.scanProgress = { done: 0, total: 0 };
    render();
    const daysAtStart = state.days;
    try {
      const W = window.WPP;
      const cutoff = state.days > 0 ? nowSec() - state.days * 86400 : 0;
      const list = (await W.chat.list({ onlyUsers: true }))
        .map((c) => ({ chat: c, id: widStr(c.id), ts: lastTs(c) }))
        .filter((x) => x.id.endsWith('@c.us') || x.id.endsWith('@lid'))
        .sort((a, b) => b.ts - a.ts);
      const stats = { chats: list.length, active: 0, biz: 0, byContact: 0, byMsg: 0, byList: 0, unknown: 0, msgFetches: 0 };
      const C = state.community;
      const MAX_MSG_FETCH = 400;
      const rows = [];

      // Phase 1: contact flags. In-memory, fast.
      const pre = [];
      for (const { chat, id, ts } of list) {
        let contact = null;
        try { contact = chat.contact; } catch (_) {}
        if (!contact) { try { contact = await W.contact.get(id); } catch (_) {} }
        let f = contactFlags(contact);
        if (id.endsWith('@lid') && f.phoneNumber && f.phoneNumber !== id) {
          try { f = mergeFlags(f, contactFlags(await W.contact.get(f.phoneNumber))); } catch (_) {}
        }
        const bizByContact = f.isBusiness || f.isEnterprise || f.isSmb || !!f.verifiedName || (typeof f.verifiedLevel === 'number' && f.verifiedLevel > 0);
        const maybeActive = cutoff === 0 || ts === 0 || ts >= cutoff;
        pre.push({ chat, id, ts, contact, f, bizByContact, maybeActive, msgs: [] });
      }

      // Phase 2: recent messages for chats that may be in the window, several at a time.
      const candidates = pre.filter((p) => p.maybeActive).slice(0, MAX_MSG_FETCH);
      stats.msgFetches = candidates.length;
      state.scanProgress = { done: 0, total: candidates.length };
      let done = 0;
      const keyOf = (m) => { const id = attrOf(m, 'id'); return id ? (id._serialized || String(id)) : ''; };
      await mapPool(candidates, 6, async (p) => {
        let raw = [];
        try { raw = (await withTimeout(W.chat.getMessages(p.id, { count: 12 }), 6000, 'getMessages')) || []; } catch (_) { raw = []; }
        // Live models carry every field, including the template category; DB rows may not.
        let models = [];
        try { const arr = p.chat.msgs.toArray ? p.chat.msgs.toArray() : p.chat.msgs.getModelsArray(); models = arr.slice(-12); } catch (_) {}
        const seen = new Set(models.map(keyOf));
        p.msgs = models.concat(raw.filter((m) => !seen.has(keyOf(m))));
        p.msgs.sort((a, b) => (attrOf(a, 't') || 0) - (attrOf(b, 't') || 0));
        done++;
        if (done % 8 === 0) { state.scanProgress.done = done; render(); }
      });

      // Phase 3: decide and build rows.
      for (const p of pre) {
        const { chat, id, ts, contact, f, bizByContact, msgs } = p;
        const realTs = ts || (msgs.length ? attrOf(msgs[msgs.length - 1], 't') || 0 : 0);
        const inWindow = cutoff === 0 ? true : realTs >= cutoff;
        if (inWindow) stats.active++;
        const inbound = msgs.filter((m) => isInbound(m) && isContent(m) && (cutoff === 0 || (attrOf(m, 't') || 0) >= cutoff));
        const inboundAll = msgs.filter((m) => isInbound(m) && isContent(m));
        const lastInbound = inbound[inbound.length - 1] || inboundAll[inboundAll.length - 1] || null;
        const lastWithText = inboundAll.slice().reverse().find((m) => msgText(m)) || lastInbound;
        const lastMsgId = lastInbound ? (attrOf(lastInbound, 'id') && (attrOf(lastInbound, 'id')._serialized || String(attrOf(lastInbound, 'id')))) : null;

        let bizByMsg = false, msgName = null;
        const cats = { marketing: 0, utility: 0, auth: 0, 'promo-guess': 0 };
        for (const m of inbound) {
          const sg = msgSignals(m); if (sg.biz) { bizByMsg = true; msgName = msgName || sg.name; }
          const c = msgCategory(m); if (c) cats[c]++;
        }
        let isBiz = bizByContact || bizByMsg;
        const unknown = !isBiz && inWindow && inbound.length > 0 && f.isMyContact === false && !f.isPSA;
        if (!isBiz && !unknown) continue;

        const phone = await phoneFor(id, contact) || (f.phoneNumber ? f.phoneNumber.split('@')[0] : null);
        let name = f.verifiedName || msgName || f.pushname || f.name || f.formattedName
          || attrOf(chat, 'formattedTitle') || attrOf(chat, 'name') || fmtPhone(phone);
        let isApi = f.isEnterprise || !!f.verifiedName || (bizByMsg && !f.isSmb);
        const hash = phone ? await sha256Hex(phone) : null;

        // Signal 4: the public list, matched by name or by number hash.
        let known = null;
        if (C) {
          known = C.byKey[normName(name)] || (hash && C.hashes[hash] ? C.byKey[C.hashes[hash]] : null) || null;
          if (known) {
            stats.byList++;
            if (!isBiz) { isBiz = true; name = known.name || name; }
            isApi = isApi || !!known.is_api;
          }
        }

        if (isBiz) { stats.biz++; if (bizByContact) stats.byContact++; if (bizByMsg) stats.byMsg++; }
        else stats.unknown++;

        let blocked = false;
        try { blocked = !!(await W.blocklist.isBlocked(id)); } catch (_) {}
        const pv = previewOf(lastWithText);
        // promo: WhatsApp-tagged marketing, or the contact carries the marketing-thread flag.
        // guess: no tag but the text reads like an ad. txn: utility/auth only. api: tagged nothing.
        // The public list never overrides what a business sends *you*: a sender whose
        // messages to you are alerts stays an alert sender however many people bounced
        // it. It only breaks a tie when your own messages carry no signal at all.
        const wallPromo = known && (known.promo_people != null ? known.promo_people : known.people) >= 3;
        const category = (cats.marketing || f.marketingThread) ? 'promo'
          : cats['promo-guess'] ? 'guess'
          : (cats.utility || cats.auth) ? 'txn'
          : isApi ? (wallPromo ? 'guess' : 'api') : isBiz ? 'smb' : 'unknown';
        rows.push({
          id, phone, hash, name, kind: isBiz ? 'biz' : 'unknown', isApi, verified: !!f.verifiedName, category,
          optedOut: !!f.optedOut,
          known: known ? { name: known.name, people: known.promo_people != null ? known.promo_people : known.people, numbers: known.numbers } : null,
          ts: realTs, blocked, archived: !!attrOf(chat, 'archive'), inWindow, lastMsgId,
          msgs: inbound.length, preview: pv.text, previewSys: pv.sys,
        });
      }
      state.scanStats = stats;
      state.groups = groupRows(rows);
      rememberSeen(rows.filter((r) => r.kind === 'biz'));
      state.scanned = true;
      const activeBiz = state.groups.filter((g) => g.kind === 'biz' && g.active.length).length;
      setBadge(activeBiz ? String(activeBiz) : '');
    } catch (e) {
      state.scanError = String((e && e.message) || e);
    }
    state.scanning = false;
    state.scanProgress = null;
    if (state.days !== daysAtStart) { state.scanned = false; return scan(); }   // period changed mid-scan
    render();
  }

  function groupRows(rows) {
    const map = new Map();
    for (const r of rows) {
      // Unknown numbers never merge with each other; businesses merge by name.
      const key = r.kind === 'biz' ? (normName(r.name) || r.id) : `unknown:${r.id}`;
      if (!map.has(key)) map.set(key, { key, name: r.name, kind: r.kind, numbers: [], isApi: false, verified: false });
      const g = map.get(key);
      g.numbers.push(r);
      g.isApi = g.isApi || r.isApi;
      g.verified = g.verified || r.verified;
    }
    const groups = [...map.values()].map((g) => {
      g.numbers.sort((a, b) => b.ts - a.ts);
      g.active = g.numbers.filter((n) => n.inWindow);
      g.msgs = g.active.reduce((s, n) => s + n.msgs, 0);
      g.blockedCount = g.numbers.filter((n) => n.blocked).length;
      const pr = g.active.find((n) => n.preview) || {};
      g.preview = pr.preview || '';
      g.previewSys = !!pr.previewSys;
      g.known = (g.numbers.find((n) => n.known) || {}).known || null;
      const order = ['promo', 'guess', 'txn', 'api', 'smb', 'unknown'];
      g.category = g.numbers.map((n) => n.category).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] || 'unknown';
      g.optedOut = g.numbers.some((n) => n.optedOut);
      g.promo = g.category === 'promo' || g.category === 'guess';
      g.checked = g.kind === 'biz' && g.active.length > 0 && g.promo;
      g.expanded = false;
      return g;
    });
    groups.sort((a, b) =>
      (b.active.length - a.active.length) || (b.msgs - a.msgs) || (b.numbers.length - a.numbers.length));
    return groups;
  }

  // Diagnostics: 30 most recent chats with the raw business-related fields, numbers masked.
  async function diag({ copy = true } = {}) {
    const W = window.WPP;
    const mask = (id) => String(id || '').replace(/^(\d{2})\d+(\d{4})@/, '$1…$2@');
    const out = { bouncer: VERSION, wa: (window.Debug && window.Debug.VERSION) || null, status: status(), stats: state.scanStats || null, sample: [] };
    try {
      const list = (await W.chat.list({ onlyUsers: true })).map((c) => ({ c, ts: lastTs(c) })).sort((a, b) => b.ts - a.ts).slice(0, 80);
      for (const { c, ts } of list) {
        if (out.sample.length >= 30) break;
        let contact = null; try { contact = c.contact; } catch (_) {}
        // Only senders that could be businesses: skip anyone saved in the address book.
        const fl = contactFlags(contact);
        if (fl.isMyContact === true && !fl.isBusiness && !fl.isEnterprise && !fl.verifiedName) continue;
        const attrs = {};
        try {
          const a = (contact && contact.attributes) || {};
          for (const k of Object.keys(a)) if (/biz|business|verified|enterprise|smb|psa|mycontact|pushname|marketing|optedout/i.test(k)) attrs[k] = a[k];
        } catch (_) {}
        let m = null, model = null;
        try { const ms = (await W.chat.getMessages(widStr(c.id), { count: 6 })) || []; m = ms.filter(isInbound).pop() || null; } catch (_) {}
        try { const arr = c.msgs.toArray ? c.msgs.toArray() : c.msgs.getModelsArray(); model = arr.filter(isInbound).pop() || null; } catch (_) {}
        const mk = {};
        if (m) { try { for (const k of Object.keys(m)) if (/biz|business|verified|template|hsm|interactive|button|footer|forward|^type$|subtype|^t$|marketing|^body$|caption/i.test(k)) mk[k] = String(JSON.stringify(m[k])).slice(0, 100); } catch (_) {} }
        if (model) { try { mk.model = { hsmTag: attrOf(model, 'hsmTag'), hsmCategory: attrOf(model, 'hsmCategory'), type: attrOf(model, 'type'), cta: hasCta(model), text: textOf(model).slice(0, 120), verdict: msgCategory(model) }; } catch (_) {} }
        if (m) { try { mk.rawVerdict = msgCategory(m); } catch (_) {} }
        out.sample.push({ id: mask(widStr(c.id)), ts, title: attrOf(c, 'formattedTitle') || attrOf(c, 'name') || null, flags: fl, attrs, msg: m ? mk : null });
      }
    } catch (e) { out.error = String((e && e.message) || e); }
    const text = JSON.stringify(out, null, 1);
    console.log('[Bouncer diag]\n' + text);
    if (copy) { try { await navigator.clipboard.writeText(text); } catch (_) {} }
    return out;
  }

  function rememberSeen(rows) {
    const seen = state.history.seen;
    for (const r of rows) {
      const key = normName(r.name) || r.id;
      const e = seen[key] || (seen[key] = { name: r.name, numbers: {}, isApi: r.isApi });
      if (!e.numbers) e.numbers = {};
      if (!e.numbers[r.id]) e.numbers[r.id] = { phone: r.phone, first: r.ts || nowSec() };
      e.isApi = e.isApi || r.isApi;
      if (!e.name) e.name = r.name;
    }
    saveHistory();
  }

  // WhatsApp's report job branches on whether a message is passed. Without one it
  // gathers the chat's recent messages itself, drops template types, and sends a
  // request with no sender and no messages, which the server never answers. That is
  // the hang behind wa-js's reportContact. We pass the latest inbound message.
  const REPORTABLE = new Set(['chat', 'image', 'video', 'document', 'audio', 'ptt', 'sticker', 'location', 'vcard']);
  async function reportNumber(id) {
    const W = window.WPP;
    const chat = await W.chat.get(id);
    if (!chat) throw new Error('chat not found');
    const models = () => { try { return (chat.msgs.toArray ? chat.msgs.toArray() : chat.msgs.getModelsArray()).slice(); } catch (_) { return []; } };
    let list = models();
    if (!list.length) { try { await W.chat.getMessages(id, { count: 12 }); } catch (_) {} list = models(); }
    const inbound = list.filter((m) => m && m.id && !m.id.fromMe).reverse();
    const msg = inbound.find((m) => REPORTABLE.has(String(m.type))) || inbound[0] || null;
    if (!msg) throw new Error('no message to report');
    const fn = W.whatsapp && W.whatsapp.functions && W.whatsapp.functions.reportSpam;
    if (typeof fn !== 'function') throw new Error('report function unavailable');
    const r = await fn(chat, 'ChatInfoReport', msg);
    if (r && r.errorCode != null) throw new Error(`${r.errorCode} ${r.errorText || ''}`.trim());
    const rid = r && r.reportIdMixin && r.reportIdMixin.reportId;
    return rid ? `reportId ${rid}` : 'ok';
  }

  // WhatsApp's own "Stop offers and announcements". Sends the optoutlist request
  // that Meta enforces on the business account, so it holds across number rotation.
  // The module lives in a lazy chunk; requireLazy pulls it in on demand.
  let optOutMod = null;
  async function loadOptOut() {
    if (optOutMod) return optOutMod;
    const tryReq = () => { try { const m = window.require && window.require('WAWebOptOutBizAction'); return m && typeof m.optOutContact === 'function' ? m : null; } catch (_) { return null; } };
    optOutMod = tryReq();
    if (optOutMod) return optOutMod;
    // Strategy 1: WhatsApp's own resource loader, the way its Stop dialog pulls the chunk in.
    for (const resName of ['WAWebMarketingMessagesFeedbackStopConfirmation.react', 'WAWebOptOutBizAction']) {
      if (optOutMod) break;
      try {
        const jsr = window.require('JSResourceForInteraction') || window.require('JSResource');
        if (typeof jsr === 'function') { await withTimeout(jsr(resName).load(), 10000, 'JSResource'); optOutMod = tryReq(); }
      } catch (_) {}
    }
    // Strategy 2: requireLazy.
    if (!optOutMod && typeof window.requireLazy === 'function') {
      await new Promise((res) => { const t = setTimeout(res, 8000); try { window.requireLazy(['WAWebOptOutBizAction'], () => { clearTimeout(t); res(); }); } catch (_) { clearTimeout(t); res(); } });
      optOutMod = tryReq();
    }
    if (!optOutMod) throw new Error('opt-out unavailable on this WhatsApp Web build');
    return optOutMod;
  }
  async function stopMarketing(id) {
    const W = window.WPP;
    const mod = await loadOptOut();
    const chat = await W.chat.get(id);
    let contact = null;
    try { contact = chat && chat.contact; } catch (_) {}
    if (!contact) contact = await W.contact.get(id);
    if (!contact) throw new Error('contact not found');
    if (attrOf(contact, 'isContactOptedOut')) return 'already';
    await mod.optOutContact(contact, 'marketing_messages', 'profile_view');
    return 'ok';
  }

  // STOP, done the way the vendor's bot expects. Many BSPs act on the quick-reply
  // button id, not on typed text, and the strong option is usually a button like
  // "Disable all communication". So: find the strongest opt-out button on a recent
  // inbound template, tap it, give the bot a moment to answer with a follow-up
  // menu and tap that too. Only type STOP when there is no button at all.
  function optOutScore(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return 0;
    if (OPT_STRONG.test(t)) return 5;
    if (OPT_MEDIUM.test(t)) return 4;
    if (OPT_NORMAL.test(t)) return 3;
    if (OPT_SOFT.test(t)) return 2;
    if (OPT_BARE.test(t)) return 1;
    return 0;
  }
  function chatModels(chat) {
    try { return (chat.msgs.toArray ? chat.msgs.toArray() : chat.msgs.getModelsArray()).slice(); } catch (_) { return []; }
  }
  function bestOptOutButton(models, minTs, minScore) {
    let best = null;
    for (const m of models.slice().reverse()) {
      if (!m || !m.id || m.id.fromMe) continue;
      if (minTs && (m.t || 0) < minTs) continue;
      const hb = m.hydratedButtons;
      if (!Array.isArray(hb)) continue;
      hb.forEach((b, i) => {
        const q = b && b.quickReplyButton;
        if (!q) return;
        const score = optOutScore(q.displayText);
        if (score >= (minScore || 1) && (!best || score > best.score)) best = { msg: m, index: typeof b.index === 'number' ? b.index : i, text: q.displayText, score };
      });
      if (best && best.score >= 4) break;
    }
    return best;
  }
  async function sendStop(id) {
    const W = window.WPP;
    const chat = await W.chat.get(id);
    if (!chat) throw new Error('chat not found');
    const before = nowSec();
    const btn = bestOptOutButton(chatModels(chat).slice(-25), 0, 1);
    let how = null;
    if (btn && typeof W.chat.replyToButtonMessage === 'function') {
      try { await W.chat.replyToButtonMessage(id, btn.msg.id, { buttonIndex: btn.index }); how = `tapped "${btn.text}"`; }
      catch (e) { log('button tap failed, typing STOP instead', String((e && e.message) || e)); }
    }
    if (!how) {
      await W.chat.sendTextMessage(id, STOP_TEXT, { waitForAck: false, linkPreview: false, markIsRead: true });
      how = 'typed STOP';
    }
    // A bot may answer with a menu. Take its strongest opt-out or confirm option.
    await sleep(3500);
    const follow = bestOptOutButton(chatModels(chat).slice(-10), before, 2)
      || (() => { const m = chatModels(chat).slice(-10).reverse().find((x) => x && x.id && !x.id.fromMe && (x.t || 0) >= before && Array.isArray(x.hydratedButtons));
        if (!m) return null; const i = m.hydratedButtons.findIndex((b) => b && b.quickReplyButton && /^(yes|confirm|ok|proceed)/i.test(String(b.quickReplyButton.displayText || '')));
        return i >= 0 ? { msg: m, index: typeof m.hydratedButtons[i].index === 'number' ? m.hydratedButtons[i].index : i, text: m.hydratedButtons[i].quickReplyButton.displayText, score: 2 } : null; })();
    if (follow && typeof W.chat.replyToButtonMessage === 'function') {
      try { await W.chat.replyToButtonMessage(id, follow.msg.id, { buttonIndex: follow.index }); how += ` → "${follow.text}"`; } catch (e) { how += ' (follow-up failed)'; }
    }
    return how;
  }

  // --------------------------------------------------------------------- run
  async function run() {
    if (state.running || state.scanning) { log('run refused', { running: state.running, scanning: state.scanning }); return; }
    const targets = state.groups.filter((g) => g.checked);
    if (!targets.length) { log('run refused: nothing selected'); return; }
    const A = state.actions;
    if (!A.optout && !A.stop && !A.report && !A.block && !A.del) { log('run refused: no actions'); return; }

    const W = window.WPP;
    log('run start', { businesses: targets.length, actions: { ...A } });
    state.running = true;
    const total = targets.reduce((s, g) => s + g.numbers.length, 0);
    state.progress = { done: 0, total, biz: '', phone: '', step: '' };
    const sum = { businesses: targets.length, numbers: total, optout: 0, stop: 0, report: 0, block: 0, del: 0, failed: 0, top: [] };
    let optoutDead = false;
    const STOP_CAP = 30;
    let stopsSent = 0;
    let reportDead = false;   // after the first report timeout, stop trying for this run
    state.cancel = false;
    sum.cancelled = 0;
    render();

    for (const g of targets) {
      // STOP only goes to a number that messaged in the last 30 days, and at most
      // STOP_CAP per run. A burst of texts to hundreds of dead numbers is the one
      // thing here that looks like spam from WhatsApp's side.
      const recent = nowSec() - 30 * 86400;
      const stopTarget = A.stop && stopsSent < STOP_CAP
        ? (g.numbers.find((n) => !n.blocked && n.ts >= recent) || null)
        : null;
      for (const n of g.numbers) {
        if (state.cancel) { n.result = { cancelled: true }; sum.cancelled++; continue; }
        n.result = {};
        state.activeId = n.id;
        render();

        const label = (what) => { state.progress.biz = g.name; state.progress.phone = fmtPhone(n.phone); state.progress.step = what; render(); };

        // Native opt-out first: it is the one that sticks, and it must run before block.
        if (A.optout && optoutDead) { n.result.optout = 'skipped'; }
        else if (A.optout) {
          label('stopping marketing');
          const r = await step(n, 'optout', 'opt-out', async () => { const v = await stopMarketing(n.id); if (v === 'already') n.result.optout = 'already'; return v; });
          if (r) { if (n.result.optout !== 'already') sum.optout++; }
          else { sum.failed++; if (/unavailable/.test((n.errors || {}).optout || '')) optoutDead = true; }
          await sleep(150);
        }
        if (A.stop && n === stopTarget) {
          label('opting out');
          if (await step(n, 'stop', 'STOP', () => sendStop(n.id), 20000)) { sum.stop++; stopsSent++; } else sum.failed++;
          await sleep(600 + Math.random() * 600);
        }
        if (A.report && reportDead) { n.result.report = 'skipped'; }
        else if (A.report) {
          label('reporting');
          if (await step(n, 'report', 'report', () => reportNumber(n.id))) sum.report++;
          else { sum.failed++; if (n.result.report === 'timeout') reportDead = true; }
          await sleep(150);
        }
        if (A.block) {
          if (n.blocked) { n.result.block = 'already'; }
          else {
            label('blocking');
            if (await step(n, 'block', 'block', async () => { await W.blocklist.blockContact(n.id); n.blocked = true; })) sum.block++; else sum.failed++;
            await sleep(150);
          }
        }
        if (A.del) {
          label('deleting chat');
          if (await step(n, 'del', 'delete', () => W.chat.delete(n.id))) sum.del++; else sum.failed++;
          await sleep(150);
        }
        state.progress.done++;
        render();
      }
      g.done = true;
    }

    sum.ts = nowSec();
    sum.days = state.days;
    sum.businessesDone = targets.filter((g) => g.numbers.some((n) => n.result && !n.result.cancelled)).length;
    sum.reportDead = reportDead;
    sum.optoutDead = optoutDead;
    sum.top = targets
      .map((g) => ({ name: g.name, seen: seenCount(g) }))
      .sort((a, b) => b.seen - a.seen)
      .slice(0, 5);
    state.history.runs.push({
      ts: sum.ts, businesses: sum.businessesDone, numbers: sum.numbers - (sum.cancelled || 0),
      optout: sum.optout, stop: sum.stop, report: sum.report, block: sum.block, del: sum.del,
    });
    const bd = state.history.bounced || (state.history.bounced = {});
    for (const g of targets) {
      const doneNums = g.numbers.filter((n) => n.result && !n.result.cancelled);
      if (!doneNums.length || g.kind !== 'biz') continue;
      const e = bd[g.key] || (bd[g.key] = { name: g.name, numbers: 0, runs: 0, msgs: 0, first: sum.ts, last: sum.ts });
      e.name = g.name; e.numbers = Math.max(e.numbers || 0, seenCount(g)); e.runs = (e.runs || 0) + 1; e.msgs = (e.msgs || 0) + g.msgs; e.last = sum.ts;
    }
    saveHistory();
    state.reportSel = {};
    state.reportStatus = null;
    for (const g of targets) state.reportSel[g.key] = g.kind === 'biz' && g.promo && g.numbers.some((n) => n.result && !n.result.cancelled);
    log('run done', sum);
    state.results = sum;
    state.running = false;
    state.progress = null;
    state.activeId = null;
    state.cancel = false;
    render();
    if (state.history.autoReport) submitReport();
  }

  function reportItems() {
    return state.groups.filter((g) => g.done && state.reportSel[g.key]).map((g) => ({
      name: g.name, is_api: !!g.isApi, category: g.category, cc: ccOf((g.numbers.find((n) => n.phone) || {}).phone),
      numbers: g.numbers.map((n) => n.hash).filter(Boolean).slice(0, 20),
    }));
  }
  function submitReport() {
    const items = reportItems();
    if (!items.length || state.reportStatus === 'sending' || (state.reportStatus && state.reportStatus.ok)) return;
    state.reportStatus = 'sending'; render();
    toExt('report', items);
  }

  async function unblock(id) {
    const W = window.WPP;
    for (const g of state.groups) for (const n of g.numbers) if (n.id === id && n.result) {
      try { await withTimeout(W.blocklist.unblockContact(id), ACTION_TIMEOUT_MS, 'unblock'); n.blocked = false; n.result.block = 'undone'; log('unblocked', id); }
      catch (e) { log('unblock failed', id, String((e && e.message) || e)); }
      render();
      return;
    }
  }

  // ------------------------------------------------------------- share card
  const FONT = '-apple-system, "SF Pro Display", Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  const CARD_DISPLAY = '"Avenir Next Condensed", "Helvetica Neue Condensed", "Roboto Condensed", "Arial Narrow", sans-serif';
  function drawCard(sum) {
    const W = 1200, H = 630;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#111b21'; x.fillRect(0, 0, W, H);

    // stamp
    x.save(); x.translate(88, 96); x.rotate(-7 * Math.PI / 180);
    x.font = `700 44px ${CARD_DISPLAY}`; x.textBaseline = 'middle';
    const label = 'B O U N C E D';
    const w = x.measureText(label).width + 44;
    x.lineWidth = 6; x.strokeStyle = '#e0332b'; x.strokeRect(0, -34, w, 68);
    x.fillStyle = '#e0332b'; x.fillText(label, 22, 2);
    x.restore();

    x.textBaseline = 'alphabetic';
    x.fillStyle = '#e9edef'; x.font = `700 200px ${CARD_DISPLAY}`;
    x.fillText(String(sum.numbers), 80, 330);
    x.font = `500 34px ${FONT}`;
    x.fillText(`numbers from ${sum.businesses} ${sum.businesses === 1 ? 'business' : 'businesses'}`, 88, 384);
    x.fillStyle = '#8696a0'; x.font = `500 26px ${FONT}`;
    x.fillText(`${sum.days > 0 ? `last ${sum.days} days` : 'all time'} · ${sum.optout || 0} marketing opt-outs · ${sum.stop} STOP · ${sum.report} reports · ${sum.block} blocks`, 88, 424);

    let y = 490;
    x.font = `600 15px ${CARD_DISPLAY}`; x.fillStyle = '#8696a0';
    x.fillText('N U M B E R S   B U R N E D   O N   M E', 88, y); y += 34;
    for (const t of sum.top.slice(0, 3)) {
      x.fillStyle = '#e9edef'; x.font = `500 26px ${FONT}`; x.textAlign = 'left';
      x.fillText(clip(t.name, 40), 88, y);
      x.fillStyle = '#e0332b'; x.font = `700 34px ${CARD_DISPLAY}`; x.textAlign = 'right';
      x.fillText(String(t.seen), 1112, y);
      x.textAlign = 'left'; y += 38;
    }
    x.fillStyle = '#2a3942'; x.fillRect(88, 596, 1024, 1);
    x.fillStyle = '#8696a0'; x.font = `600 14px ${CARD_DISPLAY}`; x.textAlign = 'right';
    x.fillText('B O U N C E R   F O R   W H A T S A P P   W E B', 1112, 622);
    x.textAlign = 'left';
    return c;
  }

  function shareText(sum) {
    const period = sum.days > 0 ? `In the last ${sum.days} days` : 'All time';
    const top = sum.top[0];
    const alone = top && top.seen > 1 ? ` ${top.name} alone has used ${top.seen} numbers on me.` : '';
    return `${period}, ${sum.businesses} businesses messaged me on WhatsApp from ${sum.numbers} numbers.${alone} Opted out of ${sum.optout || 0}, sent ${sum.stop} STOP, ${sum.report} reports, ${sum.block} blocks. One click.`;
  }

  function downloadCard() {
    if (!state.results) return;
    const c = drawCard(state.results);
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `bouncer-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  async function copyText(btn) {
    if (!state.results) return;
    try { await navigator.clipboard.writeText(shareText(state.results)); flash(btn, 'Copied'); }
    catch (_) { flash(btn, 'Copy failed'); }
  }

  function flash(btn, label) {
    if (!btn) return;
    const old = btn.textContent; btn.textContent = label;
    setTimeout(() => { btn.textContent = old; }, 1400);
  }

  // ------------------------------------------------------------------ styles
  // The door list. A ledger, not a dashboard: hairlines instead of cards, one red
  // used as ink for the tally and the stamp, condensed numerals like a door counter.
  // The sheet docks over WhatsApp's chat list, so a clicked row opens its
  // conversation in full view to the right. Expanded, it widens to add a dashboard.
  const DISPLAY = '"Avenir Next Condensed", "Helvetica Neue Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';
  const CSS = `
  #bouncer-root { all: initial; font-family: ${FONT}; font-size: 13px; line-height: 1.45; color: #e9edef; position: fixed; z-index: 2147483000; -webkit-font-smoothing: antialiased;
    --ground: #111b21; --paper: #e9edef; --muted: #8696a0; --line: #2a3942; --ink: #e0332b; --ink-soft: rgba(224,51,43,.10); --ok: #25d366; --display: ${DISPLAY}; }
  #bouncer-root *, #bouncer-root *::before, #bouncer-root *::after { box-sizing: border-box; }
  #bouncer-root button, #bouncer-root input { font: inherit; color: inherit; }
  #bouncer-root button { cursor: pointer; border: 0; background: none; padding: 0; margin: 0; text-align: inherit; }
  #bouncer-root button:disabled { cursor: default; }
  #bouncer-root :focus-visible { outline: 2px solid var(--paper); outline-offset: 2px; }
  #bouncer-root a { color: inherit; text-decoration: none; }
  #bouncer-root [hidden] { display: none !important; }
  #bouncer-root .caps { font-family: var(--display); text-transform: uppercase; letter-spacing: .12em; font-weight: 600; }

  /* pill */
  #bouncer-root .bz-pill { position: fixed; left: 16px; bottom: 16px; display: inline-flex; align-items: center; gap: 10px; height: 38px; padding: 0 14px; border-radius: 3px; background: var(--ground); color: var(--paper); border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(0,0,0,.45); font-family: var(--display); text-transform: uppercase; letter-spacing: .16em; font-weight: 600; font-size: 13px; transition: background .15s; }
  #bouncer-root .bz-pill:hover { background: #182229; }
  #bouncer-root .bz-mark { width: 8px; height: 8px; border-radius: 50%; background: var(--ink); flex: none; }
  #bouncer-root .bz-count { color: var(--ink); font-size: 15px; font-weight: 700; letter-spacing: 0; font-variant-numeric: tabular-nums; }

  /* sheet */
  #bouncer-root .bz-panel { position: fixed; top: 0; left: 0; height: 100vh; width: 420px; max-width: 100vw; background: var(--ground); border-right: 1px solid var(--line); box-shadow: 24px 0 60px rgba(0,0,0,.45); display: flex; flex-direction: column; transform: translateX(calc(-100% - 30px)); transition: transform .26s cubic-bezier(.2,.8,.2,1), width .22s ease; }
  #bouncer-root .bz-split { flex: 1; min-height: 0; display: grid; grid-template-columns: var(--list-w, 400px) minmax(0, 1fr); }
  #bouncer-root .bz-col { display: flex; flex-direction: column; min-height: 0; }
  #bouncer-root .bz-col.dash { border-left: 1px solid var(--line); background: #0e171c; }
  #bouncer-root .bz-dash-top { display: flex; align-items: center; gap: 12px; padding: 14px 20px 0; }
  #bouncer-root .bz-dash-top .sp { flex: 1; }
  #bouncer-root .bz-dash-top .bz-btn { width: auto; height: 34px; padding: 0 14px; font-size: 12px; }
  #bouncer-root .bz-wallrow { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 6px 20px 20px; }
  #bouncer-root .bz-wallrow .t { border: 1px solid var(--line); border-radius: 3px; padding: 10px 12px; }
  #bouncer-root .bz-wallrow .t b { display: block; font-family: var(--display); font-weight: 700; font-size: 26px; line-height: 1; color: var(--paper); font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-wallrow .t small { display: block; font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-size: 9px; color: var(--muted); margin-top: 5px; }
  #bouncer-root .bz-panel.open { transform: none; }
  #bouncer-root .bz-head { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 12px 0 20px; border-bottom: 1px solid var(--line); flex: none; }
  #bouncer-root .bz-word { font-family: var(--display); text-transform: uppercase; letter-spacing: .2em; font-weight: 700; font-size: 14px; }
  #bouncer-root .bz-wall { margin-left: auto; font-size: 11px; color: var(--muted); padding: 6px 8px; }
  #bouncer-root .bz-wall:hover { color: var(--paper); }
  #bouncer-root .bz-x { width: 30px; height: 30px; color: var(--muted); font-size: 20px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  #bouncer-root .bz-x:hover { color: var(--paper); }
  #bouncer-root .bz-body { flex: 1; overflow-y: auto; }
  #bouncer-root .bz-foot { flex: none; padding: 12px 20px 14px; border-top: 1px solid var(--line); background: var(--ground); position: relative; }

  /* hero */
  #bouncer-root .bz-hero { padding: 18px 20px 0; }
  #bouncer-root .bz-hero-row { display: flex; align-items: center; gap: 16px; }
  #bouncer-root .bz-big { font-family: var(--display); font-weight: 700; font-size: 64px; line-height: .86; letter-spacing: -.01em; color: var(--paper); font-variant-numeric: tabular-nums; flex: none; }
  #bouncer-root .bz-big.ink { color: var(--ink); }
  #bouncer-root .bz-lead { font-size: 14.5px; line-height: 1.35; color: var(--paper); min-width: 0; }
  #bouncer-root .bz-lead b { font-weight: 600; color: var(--paper); }
  #bouncer-root .bz-lead .m { color: var(--muted); }
  #bouncer-root .bz-tabs { display: flex; align-items: baseline; gap: 18px; margin-top: 16px; }
  #bouncer-root .bz-tabs > button { padding: 0 0 7px; color: var(--muted); border-bottom: 2px solid transparent; }
  #bouncer-root .bz-tabs > button.on { color: var(--paper); border-color: var(--ink); }
  #bouncer-root .bz-tabs .sp { flex: 1; }
  #bouncer-root .bz-seg { display: inline-flex; gap: 2px; align-self: center; padding-bottom: 5px; }
  #bouncer-root .bz-seg button { font-family: var(--display); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; font-size: 11px; color: var(--muted); padding: 3px 7px; border-radius: 2px; border: 1px solid transparent; }
  #bouncer-root .bz-seg button:hover { color: var(--paper); }
  #bouncer-root .bz-seg button.on { color: var(--paper); border-color: var(--line); background: #182229; }
  #bouncer-root .bz-toolbar { display: flex; align-items: center; gap: 10px; padding: 9px 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
  #bouncer-root .bz-toolbar .sp { flex: 1; }
  #bouncer-root .bz-toolbar button { color: var(--muted); }
  #bouncer-root .bz-toolbar button:hover { color: var(--paper); }

  /* ledger */
  #bouncer-root .bz-ledger { border-top: 1px solid var(--line); }
  #bouncer-root .bz-row { display: grid; grid-template-columns: 16px 24px minmax(0, 1fr) auto; gap: 3px 12px; align-items: start; padding: 12px 18px 12px 17px; border-bottom: 1px solid var(--line); border-left: 3px solid transparent; transition: background .12s; cursor: pointer; }
  #bouncer-root .bz-row:hover { background: #151f26; }
  #bouncer-root .bz-row.on { border-left-color: var(--ink); background: var(--ink-soft); }
  #bouncer-root .bz-row.on:hover { background: rgba(224,51,43,.14); }
  #bouncer-root .bz-row.active { border-left-color: var(--paper); }
  #bouncer-root .bz-row.done { border-left-color: var(--ok); background: transparent; }
  #bouncer-root .bz-check { appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 3px 0 0; border: 1.5px solid var(--muted); border-radius: 2px; background: transparent; cursor: pointer; position: relative; flex: none; }
  #bouncer-root .bz-check:checked { background: var(--ink); border-color: var(--ink); }
  #bouncer-root .bz-check:checked::after { content: ""; position: absolute; left: 4px; top: 1px; width: 5px; height: 9px; border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
  #bouncer-root .bz-check:disabled { opacity: .5; cursor: default; }
  #bouncer-root .bz-rank { font-family: var(--display); font-weight: 600; font-size: 14px; color: var(--muted); padding-top: 3px; font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-main { min-width: 0; }
  #bouncer-root .bz-row1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  #bouncer-root .bz-name { font-weight: 600; font-size: 14px; color: var(--paper); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #bouncer-root .bz-row:hover .bz-name { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--muted); }
  #bouncer-root .bz-auto { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; color: var(--muted); }
  #bouncer-root .bz-auto .bz-check { margin: 0; width: 14px; height: 14px; }
  #bouncer-root .bz-auto .bz-check:checked { background: var(--paper); border-color: var(--paper); }
  #bouncer-root .bz-auto .bz-check:checked::after { border-color: var(--ground); left: 3px; top: 0; width: 4px; height: 8px; }
  #bouncer-root .bz-notice { margin: 0 20px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 3px; color: var(--paper); font-size: 12px; }
  #bouncer-root .bz-lab { font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-weight: 600; font-size: 10.5px; color: var(--muted); white-space: nowrap; flex: none; }
  #bouncer-root .bz-lab.hot { color: var(--ink); }
  #bouncer-root .bz-lab.warn { color: #f5a623; }
  #bouncer-root .bz-msg { color: #cfd6da; font-size: 12.5px; line-height: 1.4; margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  #bouncer-root .bz-msg.sys { color: var(--muted); font-style: italic; }
  #bouncer-root .bz-meta { color: var(--muted); font-size: 12px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #bouncer-root .bz-meta button { color: var(--muted); }
  #bouncer-root .bz-meta button:hover { color: var(--paper); }
  #bouncer-root .bz-tally { text-align: right; padding-top: 2px; }
  #bouncer-root .bz-tally b { display: block; font-family: var(--display); font-weight: 700; font-size: 28px; line-height: .9; color: var(--ink); font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-tally small { display: block; font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-size: 8.5px; line-height: 1.2; color: var(--muted); margin-top: 4px; }
  #bouncer-root .bz-nums { grid-column: 2 / -1; display: grid; gap: 6px; margin-top: 6px; padding-top: 8px; border-top: 1px dashed var(--line); }
  #bouncer-root .bz-num { display: flex; align-items: baseline; gap: 10px; font-size: 12px; color: #aebac1; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
  #bouncer-root .bz-num > span:first-child { white-space: nowrap; }
  #bouncer-root .bz-num .when { color: var(--muted); white-space: nowrap; }
  #bouncer-root .bz-num .st { margin-left: auto; display: flex; gap: 8px; white-space: nowrap; align-items: baseline; }
  #bouncer-root .bz-st { font-family: var(--display); text-transform: uppercase; letter-spacing: .08em; font-size: 10.5px; font-weight: 600; color: var(--muted); }
  #bouncer-root .bz-st.ok { color: var(--ok); }
  #bouncer-root .bz-st.bad { color: var(--ink); }
  #bouncer-root .bz-undo { font-size: 11px; color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
  #bouncer-root .bz-undo:hover { color: var(--paper); }
  #bouncer-root .bz-section { padding: 14px 20px 0; }
  #bouncer-root .bz-link { color: var(--paper); font-size: 12px; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line); }
  #bouncer-root .bz-link:hover { text-decoration-color: var(--paper); }
  #bouncer-root .bz-link.muted { color: var(--muted); }
  #bouncer-root .bz-tip { padding: 14px 20px 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
  #bouncer-root .bz-tip b { color: #aebac1; font-weight: 600; }

  /* buttons */
  #bouncer-root .bz-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; height: 46px; border-radius: 3px; background: var(--ink); color: #fff; font-family: var(--display); text-transform: uppercase; letter-spacing: .12em; font-weight: 700; font-size: 15px; transition: background .12s, transform .08s; }
  #bouncer-root .bz-btn:hover:not(:disabled) { background: #f0453d; }
  #bouncer-root .bz-btn:active:not(:disabled) { transform: translateY(1px); }
  #bouncer-root .bz-btn:disabled { background: transparent; color: var(--muted); border: 1px solid var(--line); }
  #bouncer-root .bz-btn .n { opacity: .8; font-weight: 600; letter-spacing: .08em; }
  #bouncer-root .bz-btn.paper { background: var(--paper); color: var(--ground); }
  #bouncer-root .bz-btn.paper:hover:not(:disabled) { background: #fff; }
  #bouncer-root .bz-btn.ghost { background: transparent; color: var(--paper); border: 1px solid var(--line); }
  #bouncer-root .bz-btn.ghost:hover:not(:disabled) { border-color: var(--muted); }
  #bouncer-root .bz-btn.armed { background: #b8261f; }
  #bouncer-root .bz-hint { margin-top: 9px; text-align: center; color: var(--muted); font-size: 12px; line-height: 1.5; }
  #bouncer-root .bz-hint button { color: var(--paper); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line); }
  #bouncer-root .bz-opts { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; margin-top: 10px; }
  #bouncer-root .bz-chip { display: inline-flex; align-items: center; gap: 7px; font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-weight: 600; font-size: 11px; color: var(--muted); }
  #bouncer-root .bz-chip .dot { width: 9px; height: 9px; border: 1.5px solid var(--muted); border-radius: 1px; }
  #bouncer-root .bz-chip.on { color: var(--paper); }
  #bouncer-root .bz-chip.on .dot { background: var(--ink); border-color: var(--ink); }

  /* progress */
  #bouncer-root .bz-line { position: absolute; left: 0; top: -1px; height: 2px; width: 100%; background: var(--line); }
  #bouncer-root .bz-line > i { display: block; height: 100%; background: var(--ink); transition: width .25s ease; }
  #bouncer-root .bz-prog { display: grid; grid-template-columns: 1fr auto; gap: 2px 14px; align-items: center; padding-top: 2px; }
  #bouncer-root .bz-prog .t { font-family: var(--display); text-transform: uppercase; letter-spacing: .12em; font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #bouncer-root .bz-prog .s { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-prog .stop { grid-row: 1 / span 2; height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 3px; font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-weight: 600; font-size: 12px; color: var(--paper); }
  #bouncer-root .bz-prog .stop:hover:not(:disabled) { border-color: var(--muted); }
  #bouncer-root .bz-prog .stop:disabled { color: var(--muted); }

  /* states */
  #bouncer-root .bz-empty { padding: 48px 20px; color: var(--muted); line-height: 1.5; }
  #bouncer-root .bz-empty .h { font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-weight: 700; font-size: 20px; color: var(--paper); margin-bottom: 6px; }
  #bouncer-root .bz-scanline { height: 2px; background: var(--line); margin-top: 18px; max-width: 220px; }
  #bouncer-root .bz-scanline > i { display: block; height: 100%; background: var(--paper); transition: width .2s; }

  /* chart */
  #bouncer-root .bz-chart { padding: 6px 20px 18px; display: grid; gap: 6px; }
  #bouncer-root .bz-bar-row { display: grid; grid-template-columns: 22px 118px minmax(0, 1fr) 30px; align-items: center; gap: 10px; position: relative; padding: 3px 0; }
  #bouncer-root .bz-bar-rank { font-family: var(--display); font-weight: 600; font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-bar-name { font-size: 13px; color: var(--paper); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #bouncer-root .bz-bar-track { height: 10px; background: #182229; border-radius: 0 4px 4px 0; overflow: hidden; }
  #bouncer-root .bz-bar-track i { display: block; height: 100%; background: var(--ink); border-radius: 0 4px 4px 0; transition: width .3s ease; }
  #bouncer-root .bz-bar-row:hover .bz-bar-track i { background: #f0453d; }
  #bouncer-root .bz-bar-val { font-size: 12px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-tt { display: none; position: absolute; left: 32px; right: 0; top: calc(100% + 2px); z-index: 2; background: #202c33; border: 1px solid var(--line); border-radius: 3px; padding: 6px 9px; font-size: 11px; line-height: 1.4; color: var(--paper); white-space: normal; pointer-events: none; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
  #bouncer-root .bz-bar-row:hover .bz-tt, #bouncer-root .bz-run:hover .bz-tt { display: block; }
  #bouncer-root .bz-runs-head { padding: 10px 20px 8px; font-size: 10.5px; color: var(--muted); border-top: 1px solid var(--line); }
  #bouncer-root .bz-runs { display: flex; align-items: flex-end; gap: 3px; height: 56px; padding: 0 20px 18px; position: relative; }
  #bouncer-root .bz-run { flex: 1; max-width: 28px; background: var(--ink); border-radius: 3px 3px 0 0; position: static; opacity: .85; }
  #bouncer-root .bz-run:hover { opacity: 1; }
  #bouncer-root .bz-run .bz-tt { left: 20px; right: 20px; top: auto; bottom: calc(100% - 12px); }
  #bouncer-root .bz-warn { color: var(--muted); }

  /* results */
  #bouncer-root .bz-done { padding: 26px 20px 8px; }
  #bouncer-root .bz-stamp { display: inline-block; padding: 5px 12px 4px; border: 3px solid var(--ink); border-radius: 4px; color: var(--ink); font-family: var(--display); text-transform: uppercase; letter-spacing: .22em; font-weight: 700; font-size: 26px; line-height: 1; transform: rotate(-7deg); transform-origin: 30% 60%; animation: bz-slam .32s cubic-bezier(.2,.9,.2,1.2) both; margin: 0 0 14px 4px; }
  #bouncer-root .bz-stats { margin-top: 12px; color: var(--muted); font-size: 12px; line-height: 1.7; }
  #bouncer-root .bz-stats b { color: var(--paper); font-weight: 600; font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-actions { display: grid; gap: 8px; padding: 18px 20px 0; }
  #bouncer-root .bz-note { margin: 16px 20px 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 3px; color: #aebac1; font-size: 13px; line-height: 1.45; }
  #bouncer-root .bz-note b { color: var(--paper); font-weight: 600; }
  #bouncer-root .bz-rep { display: flex; align-items: center; gap: 10px; font-size: 13px; padding: 6px 0; cursor: pointer; }
  #bouncer-root .bz-rep .bz-check { margin: 0; }
  #bouncer-root .bz-rep .bz-check:checked { background: var(--paper); border-color: var(--paper); }
  #bouncer-root .bz-rep .bz-check:checked::after { border-color: var(--ground); }
  #bouncer-root .bz-rep .m { margin-left: auto; color: var(--muted); font-size: 12px; }
  @keyframes bz-slam { from { transform: rotate(-7deg) scale(1.7); opacity: 0; } to { transform: rotate(-7deg) scale(1); opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { #bouncer-root * { transition: none !important; animation: none !important; } }
  `;

  function installStyles() {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return;
    } catch (_) { /* fall through */ }
    const st = document.createElement('style');
    st.id = 'bouncer-style';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- render
  let root, pill, panel;
  const PERIODS = [[7, '7d', 'this week'], [14, '14d', 'in the last 14 days'], [30, '30d', 'in the last 30 days'], [0, 'All', 'ever']];
  const NOT_READY = {
    loading: ['Connecting', 'A few seconds once your chats are showing. If it never clears, reload this tab.'],
    unauthenticated: ['Link your phone', 'Scan the QR code and wait for your chats to appear.'],
    syncing: ['Syncing', 'WhatsApp is still loading your chats. Give it a moment.'],
    'inject-failed': ['Couldn\'t connect', 'Reload this tab and try again.'],
  };
  const TAG_WORDS = { optout: ['Opted out', 'Opt-out'], stop: ['STOP', 'STOP'], report: ['Reported', 'Report'], block: ['Blocked', 'Block'], del: ['Deleted', 'Delete'] };
  const CAT_LABEL = { promo: ['Promotional', 'hot'], guess: ['Looks promotional', 'hot'], txn: ['Alerts only', ''], api: ['', ''], smb: ['Small business', ''], unknown: ['Not in contacts', ''] };

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const bizWord = (n) => (n === 1 ? 'business' : 'businesses');
  const periodWord = () => (PERIODS.find(([v]) => v === state.days) || PERIODS[0])[2];

  function mount() {
    if (root) return;
    installStyles();
    root = document.createElement('div');
    root.id = 'bouncer-root';
    root.innerHTML = `
      <button class="bz-pill" data-act="toggle" title="Bouncer"><span class="bz-mark"></span>Bouncer<span class="bz-count" hidden></span></button>
      <aside class="bz-panel" role="dialog" aria-label="Bouncer"></aside>`;
    document.body.appendChild(root);
    pill = root.querySelector('.bz-pill');
    panel = root.querySelector('.bz-panel');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) closePanel(); });
    window.addEventListener('resize', () => { if (state.open) dockPanel(); });
    render();
  }

  // Size and place the sheet over WhatsApp's chat-list column. Expanded, it takes
  // the rest of the window up to a sane width.
  function dockPanel() {
    let left = 0, listW = 420;
    try {
      const pane = document.getElementById('pane-side');
      if (pane) {
        const r = pane.getBoundingClientRect();
        if (r.width > 240) { left = Math.max(0, Math.round(r.left)); listW = Math.round(Math.min(Math.max(r.width, 380), 480)); }
      }
    } catch (_) {}
    const room = window.innerWidth - left;
    const canSplit = state.expanded && room >= 900;
    panel.style.left = left + 'px';
    panel.style.width = (canSplit ? Math.min(room - 16, 1160) : listW) + 'px';
    panel.style.setProperty('--list-w', listW + 'px');
    return canSplit;
  }

  function openPanel() { state.open = true; dockPanel(); render(); if (!state.scanned && !state.scanning) scan(); }
  function closePanel() { state.open = false; state.armed = false; state.view = 'list'; state.expanded = false; render(); }
  const findGroup = (key) => state.groups.find((g) => g.key === key);

  // Open the conversation, scrolled to the last message they sent. Three ways in,
  // because WhatsApp Web's own navigation functions come and go between builds.
  let noticeTimer = null;
  function notice(text) {
    state.notice = text; render();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { state.notice = null; render(); }, 3500);
  }
  async function openChat(key) {
    const g = findGroup(key); if (!g) return;
    const n = g.active[0] || g.numbers[0]; if (!n) return;
    if (state.expanded) { state.expanded = false; dockPanel(); render(); }
    const W = window.WPP;
    const attempts = [
      ['openChatAt', () => n.lastMsgId && W.chat.openChatAt ? W.chat.openChatAt(n.id, n.lastMsgId) : Promise.reject(new Error('no message id'))],
      ['openChatBottom', () => W.chat.openChatBottom ? W.chat.openChatBottom(n.id) : Promise.reject(new Error('unavailable'))],
      ['openChatFromUnread', () => W.chat.openChatFromUnread ? W.chat.openChatFromUnread(n.id) : Promise.reject(new Error('unavailable'))],
    ];
    for (const [name, fn] of attempts) {
      try { await withTimeout(Promise.resolve().then(fn), 5000, name); log('opened chat via', name, n.id); return; }
      catch (e) { log(name, 'failed', n.id, String((e && e.message) || e)); }
    }
    notice(`Couldn't open ${g.name}'s chat. It may already be deleted.`);
  }

  function onClick(e) {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    const act = t.dataset.act;
    if (act === 'toggle') { if (state.open) closePanel(); else openPanel(); }
    else if (act === 'close') closePanel();
    else if (act === 'scan') scan();
    else if (act === 'run') {
      const targets = state.groups.filter((g) => g.checked);
      const risky = targets.filter((g) => !g.promo);
      if (risky.length && !state.armed) { state.armed = true; render(); setTimeout(() => { if (state.armed) { state.armed = false; render(); } }, 6000); return; }
      state.armed = false;
      run();
    }
    else if (act === 'cancel') { state.cancel = true; render(); }
    else if (act === 'chart') { state.view = 'chart'; render(); }
    else if (act === 'chart-close') { state.view = 'list'; render(); }
    else if (act === 'expand') {
      // Wide enough: split view. Otherwise the chart takes the panel over.
      const left = parseInt(panel.style.left || '0', 10) || 0;
      if (!state.expanded && window.innerWidth - left < 900) { state.view = 'chart'; render(); return; }
      state.expanded = !state.expanded; state.view = 'list'; render();
    }
    else if (act === 'chart-card') downloadChartCard();
    else if (act === 'noop') { /* checkbox: handled by onChange */ }
    else if (act === 'open') openChat(t.dataset.key);
    else if (act === 'opts') { state.showOpts = !state.showOpts; render(); }
    else if (act === 'filter') { state.filter = t.dataset.v === 'all' ? 'all' : 'promo'; state.armed = false; render(); }
    else if (act === 'period') { const d = Number(t.dataset.v); if (d !== state.days) { state.days = d; state.scanned = false; scan(); } }
    else if (act === 'chip') { state.actions[t.dataset.key] = !state.actions[t.dataset.key]; render(); }
    else if (act === 'expand') { const g = findGroup(t.dataset.key); if (g) { g.expanded = !g.expanded; render(); } }
    else if (act === 'all') { state.groups.forEach((g) => { if (g.kind === 'biz' && g.active.length && (state.filter === 'all' || g.promo)) g.checked = true; }); render(); }
    else if (act === 'none') { state.groups.forEach((g) => { g.checked = false; }); state.armed = false; render(); }
    else if (act === 'unknown') { state.showUnknown = !state.showUnknown; render(); }
    else if (act === 'unblock') unblock(t.dataset.id);
    else if (act === 'card') downloadCard();
    else if (act === 'copy') copyText(t);
    else if (act === 'back') { state.results = null; state.reportStatus = null; state.showRep = false; scan(); }
    else if (act === 'rep-toggle') { state.showRep = !state.showRep; render(); }
    else if (act === 'report') submitReport();
    else if (act === 'auto-report') { state.history.autoReport = !state.history.autoReport; saveHistory(); render(); if (state.history.autoReport) submitReport(); }
    else if (act === 'diag') { flash(t, 'Collecting…'); diag().then(() => flash(t, 'Copied')); }
  }

  function onChange(e) {
    const t = e.target;
    if (t.dataset.auto) { state.history.autoReport = t.checked; saveHistory(); render(); if (t.checked) submitReport(); }
    else if (t.classList.contains('bz-rep-check')) { state.reportSel[t.dataset.key] = t.checked; render(); }
    else if (t.classList.contains('bz-check')) { const g = findGroup(t.dataset.key); if (g) g.checked = t.checked; state.armed = false; render(); }
  }

  function render() {
    if (!root) return;
    const activeBiz = state.groups.filter((g) => g.kind === 'biz' && g.active.length && g.promo);
    pill.hidden = state.open || (loginScreen() && !state.open);
    const countEl = pill.querySelector('.bz-count');
    if (state.scanned && activeBiz.length) { countEl.textContent = String(activeBiz.length); countEl.hidden = false; }
    else countEl.hidden = true;
    panel.classList.toggle('open', state.open);
    if (!state.open) return;
    const bodyEl = panel.querySelector('.bz-body');
    const scrollTop = bodyEl ? bodyEl.scrollTop : 0;
    const wall = state.community && state.community.url;
    const split = dockPanel();
    const chart = !split && state.view === 'chart';
    const head = `
      <div class="bz-head"><span class="bz-mark"></span><span class="bz-word">Bouncer</span>
        <span style="margin-left:auto"></span>
        ${chart ? `<button class="bz-wall caps" data-act="chart-close">← Back</button>` : `<button class="bz-wall caps" data-act="expand" title="${split ? 'Back to the list only' : 'Show everything you have bounced beside the list'}">${split ? 'Collapse ⇤' : 'Expand ⇥'}</button>`}
        ${wall && !chart ? `<a class="bz-wall caps" style="margin-left:0" href="${esc(wall)}" target="_blank" rel="noopener">Wall of Shame ↗</a>` : ''}
        <button class="bz-x" data-act="close" aria-label="Close">×</button></div>`;
    const listCol = `<div class="bz-body">${state.results ? renderDone() : renderList()}</div>${renderFoot()}`;
    panel.innerHTML = split
      ? `${head}<div class="bz-split"><div class="bz-col">${listCol}</div><div class="bz-col dash"><div class="bz-body">${renderDashboard()}</div></div></div>`
      : `${head}<div class="bz-body">${chart ? renderChart() : state.results ? renderDone() : renderList()}</div>${chart ? renderChartFoot() : renderFoot()}`;
    const nb = panel.querySelector('.bz-body');
    if (nb && scrollTop) nb.scrollTop = scrollTop;
    if (state.running) { const el = panel.querySelector('.bz-row.active'); if (el) el.scrollIntoView({ block: 'nearest' }); }
  }

  const rankSort = (a, b) => (seenCount(b) - seenCount(a)) || (b.msgs - a.msgs) || (b.active.length - a.active.length);

  function renderList() {
    const s = status();
    if (s !== 'ready') { const c = NOT_READY[s] || ['One moment', '']; return `<div class="bz-empty"><div class="h">${esc(c[0])}</div>${esc(c[1])}</div>`; }
    if (state.scanError) return `<div class="bz-empty"><div class="h">Couldn't read your chats</div>${esc(state.scanError)}<div style="margin-top:10px"><button class="bz-link" data-act="scan">Try again</button></div></div>`;
    if (state.scanning) {
      const p = state.scanProgress || {};
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      return `<div class="bz-empty"><div class="h">Reading the list</div>${p.total ? `${p.done} of ${p.total} chats` : 'Nothing is sent or changed.'}<div class="bz-scanline"><i style="width:${pct}%"></i></div></div>`;
    }
    if (!state.scanned) return `<div class="bz-empty"><div class="h">Ready</div><button class="bz-link" data-act="scan">Look for businesses</button></div>`;

    const allBiz = state.groups.filter((g) => g.kind === 'biz' && g.active.length);
    const promoOnly = state.filter === 'promo';
    const biz = (promoOnly ? allBiz.filter((g) => g.promo) : allBiz).slice().sort(rankSort);
    const hiddenN = allBiz.length - biz.length;
    const unknown = promoOnly ? [] : state.groups.filter((g) => g.kind === 'unknown' && g.active.length);
    const burned = biz.reduce((n, g) => n + seenCount(g), 0);
    const sel = biz.filter((g) => g.checked).length;
    const seg = `<span class="bz-seg">${PERIODS.map(([v, l]) => `<button class="${state.days === v ? 'on' : ''}" data-act="period" data-v="${v}">${l}</button>`).join('')}</span>`;
    const tabs = `<div class="bz-tabs caps">
        <button class="${promoOnly ? 'on' : ''}" data-act="filter" data-v="promo">Promotional</button>
        <button class="${promoOnly ? '' : 'on'}" data-act="filter" data-v="all">All</button>
        <span class="sp"></span>${seg}
      </div>`;
    const firstRun = !(state.history.runs && state.history.runs.length);

    if (!biz.length) {
      return `
        <div class="bz-hero">
          <div class="bz-hero-row"><div class="bz-big">0</div>
            <div class="bz-lead">${promoOnly ? 'promotions' : 'businesses'} ${esc(periodWord())}.<br><span class="m">${promoOnly && hiddenN ? `${hiddenN} ${bizWord(hiddenN)} messaged you without looking promotional.` : 'Enjoy the silence.'}</span></div></div>
          ${tabs}
        </div>
        <div class="bz-toolbar"><span class="sp"></span><button data-act="scan">Rescan</button></div>
        ${renderUnknown(unknown)}
        ${state.scanStats && state.scanStats.chats ? `<div class="bz-tip">Missing something that's clearly an ad? <button class="bz-link muted" data-act="diag">Copy diagnostics</button> and send them over.</div>` : ''}`;
    }
    return `
      <div class="bz-hero">
        <div class="bz-hero-row"><div class="bz-big">${biz.length}</div>
          <div class="bz-lead">${bizWord(biz.length)} ${promoOnly ? 'sent you promotions' : 'messaged you'} ${esc(periodWord())}, burning <b>${burned}</b> ${burned === 1 ? 'number' : 'numbers'} on you.<br><span class="m">Ranked by numbers burned.</span></div></div>
        ${tabs}
      </div>
      <div class="bz-toolbar"><span>${sel} of ${biz.length} selected</span><span>·</span><button data-act="all">Select all</button><span>·</span><button data-act="none">None</button><span class="sp"></span><button data-act="scan">Rescan</button></div>
      ${state.notice ? `<div class="bz-notice" style="margin-top:12px">${esc(state.notice)}</div>` : ''}
      ${firstRun ? `<div class="bz-tip" style="padding-top:12px;padding-bottom:12px">Ticked rows are promotional senders. Click a row to open the conversation and check first. Deleted chats can't be recovered.</div>` : ''}
      <div class="bz-ledger">${biz.map((g, i) => renderRow(g, i + 1)).join('')}</div>
      ${promoOnly && hiddenN ? `<div class="bz-tip">${hiddenN} more ${bizWord(hiddenN)} messaged you without looking promotional. <button class="bz-link" data-act="filter" data-v="all">Show all</button></div>` : ''}
      ${renderUnknown(unknown)}`;
  }

  function renderRow(g, rank) {
    const seen = seenCount(g);
    const allBlocked = g.numbers.length > 0 && g.blockedCount === g.numbers.length;
    const [catText, catCls] = CAT_LABEL[g.category] || ['', ''];
    const showCat = state.filter === 'all' || state.results;   // inside the Promotional tab the label is redundant
    const labels = [
      g.known ? `<span class="bz-lab warn">On the Wall · ${g.known.people}</span>` : '',
      showCat && catText && !(g.known && catCls === 'hot') ? `<span class="bz-lab ${catCls}">${catText}</span>` : '',
      g.optedOut ? '<span class="bz-lab">Opted out</span>' : '',
      allBlocked && !g.done ? '<span class="bz-lab">Blocked</span>' : '',
    ].join('');
    const single = g.numbers.length === 1;
    const locked = state.running || g.done;
    const showNums = g.expanded || locked;
    const last = g.numbers[0];
    const isActive = state.running && g.numbers.some((n) => n.id === state.activeId);
    const meta = [
      plural(g.msgs, 'message'),
      esc(fmtAgo(last.ts)),
      single ? esc(fmtPhone(last.phone)) : (!locked ? `<button data-act="expand" data-key="${esc(g.key)}">${g.expanded ? 'Hide numbers' : `${plural(g.numbers.length, 'number')} ›`}</button>` : plural(g.numbers.length, 'number')),
    ].join(' · ');
    return `
      <div class="bz-row ${g.checked ? 'on' : ''} ${g.done ? 'done' : ''} ${isActive ? 'active' : ''}" data-act="open" data-key="${esc(g.key)}" title="Open the conversation at their last message">
        <input type="checkbox" class="bz-check" data-act="noop" data-key="${esc(g.key)}" ${g.checked ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="Select ${esc(g.name)}">
        <span class="bz-rank">${rank ? String(rank).padStart(2, '0') : ''}</span>
        <div class="bz-main">
          <div class="bz-row1"><span class="bz-name">${esc(g.name)}</span>${labels}</div>
          ${g.preview ? `<div class="bz-msg ${g.previewSys ? 'sys' : ''}">${esc(g.preview)}</div>` : ''}
          <div class="bz-meta">${meta}</div>
        </div>
        ${seen >= 2 ? `<div class="bz-tally"><b>${seen}</b><small>numbers<br>burned</small></div>` : '<span></span>'}
        ${showNums ? renderNums(g) : ''}
      </div>`;
  }

  function renderNums(g) {
    return `<div class="bz-nums">${g.numbers.map((n) => `
      <div class="bz-num"><span>${esc(fmtPhone(n.phone))}</span><span class="when">${esc(fmtAgo(n.ts))}${n.blocked && !n.result ? ' · blocked' : ''}</span><span class="st">${renderResultTags(n)}</span></div>`).join('')}</div>`;
  }

  function renderResultTags(n) {
    if (!n.result) return '';
    if (n.result.cancelled) return '<span class="bz-st">Not bounced</span>';
    const tags = Object.keys(TAG_WORDS).map((k) => {
      const v = n.result[k];
      if (v === undefined || v === 'skipped') return '';
      const [ok, fail] = TAG_WORDS[k];
      if (v === 'already') return `<span class="bz-st">${ok}</span>`;
      if (v === 'undone') return `<span class="bz-st">Unblocked</span>`;
      if (v === true) return `<span class="bz-st ok">${ok}</span>`;
      return `<span class="bz-st bad" title="${esc((n.errors || {})[k] || '')}">${fail} ✕</span>`;
    }).join('');
    const undo = !state.running && n.result.block === true ? `<button class="bz-undo" data-act="unblock" data-id="${esc(n.id)}">Unblock</button>` : '';
    return tags + undo;
  }

  function renderUnknown(list) {
    if (!list.length) return '';
    return `<div class="bz-section">
      <button class="bz-link muted" data-act="unknown">${plural(list.length, 'unknown number')} also messaged you ${state.showUnknown ? '‹' : '›'}</button></div>
      ${state.showUnknown ? `<div class="bz-ledger" style="margin-top:10px">${list.map((g) => renderRow(g, 0)).join('')}</div>` : ''}`;
  }

  function renderFoot() {
    if (state.results) return `<div class="bz-foot"><button class="bz-btn ghost" data-act="back">Done</button></div>`;
    if (state.running && state.progress) {
      const p = state.progress;
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      return `<div class="bz-foot"><div class="bz-line"><i style="width:${pct}%"></i></div>
        <div class="bz-prog"><div class="t">Bouncing ${esc(p.biz || '')}</div><button class="stop" data-act="cancel" ${state.cancel ? 'disabled' : ''}>${state.cancel ? 'Stopping…' : 'Stop'}</button><div class="s">${p.done} of ${plural(p.total, 'number')}${p.step ? ` · ${esc(p.step)}` : ''}</div></div></div>`;
    }
    if (status() !== 'ready' || !state.scanned || state.scanning || state.scanError) return '';
    const targets = state.groups.filter((g) => g.checked);
    const risky = targets.filter((g) => !g.promo);
    const n = targets.reduce((s, g) => s + g.numbers.length, 0);
    const A = state.actions;
    const parts = [A.optout && 'opt out', A.stop && 'STOP', A.report && 'report', A.block && 'block', A.del && 'delete'].filter(Boolean);
    const what = parts.length ? parts.join(' · ') : 'No actions selected';
    let label = !targets.length ? 'Select a business' : targets.length === 1 ? `Bounce ${clip(targets[0].name, 22)}` : `Bounce ${targets.length} businesses`;
    if (state.armed) label = `Sure? Bounce ${targets.length === 1 ? clip(targets[0].name, 18) : `${targets.length} businesses`}`;
    const chip = (key, l) => `<button class="bz-chip ${A[key] ? 'on' : ''}" data-act="chip" data-key="${key}"><span class="dot"></span>${l}</button>`;
    const hint = state.armed
      ? `${risky.length === 1 ? `<b>${esc(risky[0].name)}</b> doesn't` : `${risky.length} of these don't`} look promotional. Click again to bounce anyway.${A.del ? ' Deleted chats can\'t be recovered.' : ''}`
      : `${esc(what)} · <button data-act="opts">${state.showOpts ? 'Hide' : 'Change'}</button>${A.del || A.report ? `<br><span class="bz-warn">${A.del ? 'Deleted chats can\'t be recovered' : ''}${A.del && A.report ? ', and ' : ''}${A.report ? 'reports can\'t be withdrawn' : ''}. Blocks can be undone afterwards.</span>` : ''}`;
    return `<div class="bz-foot">
      <button class="bz-btn ${state.armed ? 'armed' : ''}" data-act="run" ${targets.length && parts.length ? '' : 'disabled'}>${esc(label)}${n > targets.length && !state.armed ? `<span class="n">${plural(n, 'number')}</span>` : ''}</button>
      <div class="bz-hint">${hint}</div>
      ${state.showOpts && !state.armed ? `<div class="bz-opts">${chip('optout', 'Stop marketing')}${chip('stop', 'Send STOP')}${chip('report', 'Report')}${chip('block', 'Block')}${chip('del', 'Delete chat')}</div><div class="bz-hint" style="margin-top:8px">Stop marketing is WhatsApp's own opt-out for the whole business. Delete removes the chat on all your devices, for good.</div>` : ''}
    </div>`;
  }

  function renderDone() {
    const s = state.results;
    const A = state.actions;
    const top = s.top[0];
    const bounced = state.groups.filter((g) => g.done).slice().sort(rankSort);
    const softFails = bounced.reduce((c, g) => c + g.numbers.filter((n) => n.result && ['report', 'optout'].some((k) => n.result[k] === false || n.result[k] === 'timeout')).length, 0);
    const otherFails = Math.max(0, s.failed - softFails);
    const doneNumbers = s.numbers - (s.cancelled || 0);
    const stats = [
      A.optout && !s.optoutDead ? `<b>${s.optout}</b> marketing stopped` : '', A.stop ? `<b>${s.stop}</b> STOP sent` : '',
      A.report && !s.reportDead ? `<b>${s.report}</b> reported` : '', A.block ? `<b>${s.block}</b> blocked` : '', A.del ? `<b>${s.del}</b> ${s.del === 1 ? 'chat' : 'chats'} deleted` : '',
    ].filter(Boolean).join(' · ');
    const rs = state.reportStatus;
    const selN = bounced.filter((g) => state.reportSel[g.key]).length;
    return `
      <div class="bz-done">
        <div class="bz-stamp">Bounced</div>
        <div class="bz-hero-row"><div class="bz-big ink">${doneNumbers}</div>
          <div class="bz-lead">${doneNumbers === 1 ? 'number' : 'numbers'} from ${s.businessesDone != null ? s.businessesDone : s.businesses} ${bizWord(s.businessesDone != null ? s.businessesDone : s.businesses)}.${top && top.seen >= 2 ? ` <span class="m">${esc(top.name)} alone had burned ${top.seen} on you.</span>` : ''}</div></div>
        <div class="bz-stats">${stats}</div>
      </div>
      ${s.cancelled ? `<div class="bz-tip">Stopped early. ${plural(s.cancelled, 'number')} not bounced.</div>` : ''}
      ${s.optoutDead ? `<div class="bz-tip">WhatsApp's marketing opt-out isn't available on this build yet.</div>` : ''}
      ${s.reportDead ? `<div class="bz-tip">Reporting didn't go through on this WhatsApp Web version. Everything else did.</div>` : ''}
      ${otherFails > 0 ? `<div class="bz-tip">${plural(otherFails, 'action')} didn't go through. See the marks below.</div>` : ''}
      <div class="bz-actions">
        ${rs && rs.ok
          ? `<a class="bz-btn paper" href="${esc(rs.url || '#')}" target="_blank" rel="noopener">Added · Open the Wall of Shame ↗</a>`
          : `<button class="bz-btn paper" data-act="report" ${selN && rs !== 'sending' ? '' : 'disabled'}>${rs === 'sending' ? 'Adding…' : `Add ${selN} to the Wall of Shame`}</button>`}
        <button class="bz-btn ghost" data-act="card">Save share card</button>
      </div>
      <div class="bz-hint"><button data-act="expand">See everything you've bounced</button></div>
      <div class="bz-hint">${rs && rs.error ? `Couldn't add: ${esc(rs.error)} · ` : rs && rs.ok ? '' : 'Promotional senders only, names and hashed numbers · '}${rs && rs.ok ? '' : `<button data-act="rep-toggle">${state.showRep ? 'Hide' : 'Choose which'}</button> · `}<button data-act="copy">Copy as text</button></div>
      <div class="bz-hint" style="margin-top:6px"><label class="bz-auto"><input type="checkbox" class="bz-check" data-act="noop" data-auto="1" ${state.history.autoReport ? 'checked' : ''}> Add to the Wall automatically after every run</label></div>
      ${state.showRep ? renderRepList(bounced) : ''}
      ${!A.optout || s.optoutDead ? `<div class="bz-tip">To make it stick, open their chat on your phone and tap <b>Stop</b> on a marketing message.</div>` : ''}
      ${state.notice ? `<div class="bz-notice" style="margin-top:14px">${esc(state.notice)}</div>` : ''}
      <div class="bz-ledger" style="margin-top:18px">${bounced.map((g, i) => renderRow(g, i + 1)).join('')}</div>`;
  }

  function bouncedRows() {
    return Object.entries(state.history.bounced || {})
      .map(([key, e]) => ({ key, name: e.name || key, numbers: e.numbers || 0, runs: e.runs || 0, msgs: e.msgs || 0, last: e.last || 0 }))
      .sort((a, b) => (b.numbers - a.numbers) || (b.last - a.last));
  }

  // One series, so the bars carry the ink and the text stays in text tokens.
  function renderChart() {
    const rows = bouncedRows();
    const runs = (state.history.runs || []).slice(-24);
    if (!rows.length) return `<div class="bz-empty"><div class="h">Nothing bounced yet</div>Run a bounce and every business you throw out shows up here, ranked by the numbers it burned.</div>`;
    const totalNumbers = rows.reduce((n, r) => n + r.numbers, 0);
    const max = Math.max(1, ...rows.map((r) => r.numbers));
    const shown = rows.slice(0, 25);
    const runMax = Math.max(1, ...runs.map((r) => r.numbers || 0));
    return `
      <div class="bz-hero"><div class="bz-hero-row"><div class="bz-big ink">${rows.length}</div>
        <div class="bz-lead">${bizWord(rows.length)} bounced so far, <b>${totalNumbers}</b> ${totalNumbers === 1 ? 'number' : 'numbers'} between them, over ${plural(runs.length, 'run')}.<br><span class="m">Numbers burned per business.</span></div></div></div>
      <div class="bz-chart">
        ${shown.map((r, i) => `
          <div class="bz-bar-row">
            <span class="bz-bar-rank">${String(i + 1).padStart(2, '0')}</span>
            <span class="bz-bar-name">${esc(r.name)}</span>
            <span class="bz-bar-track"><i style="width:${Math.max(2, Math.round((r.numbers / max) * 100))}%"></i></span>
            <span class="bz-bar-val">${r.numbers}</span>
            <span class="bz-tt">${esc(r.name)} · ${plural(r.numbers, 'number')} · ${plural(r.msgs, 'message')} · bounced ${r.runs === 1 ? 'once' : `${r.runs} times`} · last ${esc(fmtAgo(r.last))}</span>
          </div>`).join('')}
        ${rows.length > shown.length ? `<div class="bz-tip" style="padding-left:0">and ${rows.length - shown.length} more</div>` : ''}
      </div>
      ${runs.length > 1 ? `
      <div class="bz-runs-head caps">Numbers per run</div>
      <div class="bz-runs">${runs.map((r) => `<span class="bz-run" style="height:${Math.max(6, Math.round(((r.numbers || 0) / runMax) * 100))}%"><span class="bz-tt">${new Date((r.ts || 0) * 1000).toLocaleDateString()} · ${plural(r.numbers || 0, 'number')} · ${plural(r.businesses || 0, 'business').replace('businesss', 'businesses')}</span></span>`).join('')}</div>` : ''}`;
  }

  function renderDashboard() {
    const C = state.community;
    const rows = bouncedRows();
    const wall = C ? `
      <div class="bz-wallrow">
        <div class="t"><b>${C.totals.businesses || 0}</b><small>on the Wall</small></div>
        <div class="t"><b>${C.totals.numbers || 0}</b><small>numbers burned</small></div>
        <div class="t"><b>${C.totals.people || 0}</b><small>people reporting</small></div>
      </div>` : '';
    return `
      <div class="bz-dash-top"><span class="caps" style="color:var(--muted);font-size:11px">Everything you've bounced</span><span class="sp"></span>${rows.length ? `<button class="bz-btn paper" data-act="chart-card">Save chart</button>` : ''}</div>
      ${renderChart()}
      ${wall ? `<div class="bz-dash-top" style="padding-top:4px"><span class="caps" style="color:var(--muted);font-size:11px">Wall of Shame, everyone</span><span class="sp"></span>${C && C.url ? `<a class="bz-link muted" href="${esc(C.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}</div>${wall}` : ''}`;
  }

  function renderChartFoot() {
    if (!bouncedRows().length) return '';
    return `<div class="bz-foot"><button class="bz-btn paper" data-act="chart-card">Save chart</button><div class="bz-hint">A 1200px image of this list, for sharing.</div></div>`;
  }

  function drawChartCard(rows) {
    const shown = rows.slice(0, 12);
    const W = 1200, rowH = 44, top = 250, H = top + shown.length * rowH + 90;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#111b21'; x.fillRect(0, 0, W, H);
    x.save(); x.translate(88, 86); x.rotate(-7 * Math.PI / 180);
    x.font = `700 40px ${CARD_DISPLAY}`; x.textBaseline = 'middle';
    const label = 'B O U N C E D'; const lw = x.measureText(label).width + 40;
    x.lineWidth = 6; x.strokeStyle = '#e0332b'; x.strokeRect(0, -31, lw, 62);
    x.fillStyle = '#e0332b'; x.fillText(label, 20, 2); x.restore();
    x.textBaseline = 'alphabetic';
    const totalNumbers = rows.reduce((n, r) => n + r.numbers, 0);
    x.fillStyle = '#e9edef'; x.font = `700 96px ${CARD_DISPLAY}`; x.fillText(String(rows.length), 84, 205);
    x.font = `500 30px ${FONT}`; x.fillText(`businesses bounced · ${totalNumbers} numbers burned on me`, 84 + x.measureText('').width + (String(rows.length).length * 52) + 24, 200);
    const max = Math.max(1, ...shown.map((r) => r.numbers));
    const nameX = 84, barX = 420, barW = 620, valX = 1112;
    shown.forEach((r, i) => {
      const y = top + i * rowH;
      x.fillStyle = '#8696a0'; x.font = `600 18px ${CARD_DISPLAY}`; x.textAlign = 'left'; x.fillText(String(i + 1).padStart(2, '0'), nameX, y + 20);
      x.fillStyle = '#e9edef'; x.font = `600 22px ${FONT}`; x.fillText(clip(r.name, 26), nameX + 40, y + 21);
      x.fillStyle = '#182229'; x.fillRect(barX, y + 6, barW, 16);
      const w = Math.max(4, Math.round((r.numbers / max) * barW));
      x.fillStyle = '#e0332b'; x.beginPath(); x.roundRect(barX, y + 6, w, 16, [0, 4, 4, 0]); x.fill();
      x.fillStyle = '#8696a0'; x.font = `700 22px ${CARD_DISPLAY}`; x.textAlign = 'right'; x.fillText(String(r.numbers), valX, y + 22); x.textAlign = 'left';
    });
    x.fillStyle = '#2a3942'; x.fillRect(84, H - 56, 1028, 1);
    x.fillStyle = '#8696a0'; x.font = `600 14px ${CARD_DISPLAY}`; x.textAlign = 'right';
    x.fillText('B O U N C E R   ·   B O U N C E R . K A N I S H K D A N . C O M', 1112, H - 28); x.textAlign = 'left';
    return c;
  }
  function downloadChartCard() {
    const rows = bouncedRows(); if (!rows.length) return;
    const c = drawChartCard(rows);
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `bouncer-bounced-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function renderRepList(bounced) {
    return `<div class="bz-note">${bounced.map((g) => `
      <label class="bz-rep"><input type="checkbox" class="bz-check bz-rep-check" data-key="${esc(g.key)}" ${state.reportSel[g.key] ? 'checked' : ''}><span>${esc(g.name)}</span><span class="m">${g.promo ? 'promotional' : (CAT_LABEL[g.category] || [''])[0].toLowerCase() || 'business'}${g.known ? ` · on the Wall` : ''}</span></label>`).join('')}</div>`;
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    const start = () => {
      if (!document.body) return setTimeout(start, 200);
      mount();
      requestHistory();
      requestCommunity();
    };
    start();
    const bootAt = Date.now();
    const requestInject = () => {
      if (window.WPP || state.inject !== 'idle') return;
      const assumeLoggedIn = !loginScreen() && Date.now() - bootAt > 20000;   // selectors drifted, but no QR either
      if (!loggedInDom() && !assumeLoggedIn) return setTimeout(requestInject, 1000);
      state.inject = 'requested';
      toExt('inject');
      render();
      setTimeout(() => { if (state.inject === 'requested' && !window.WPP) { state.inject = 'idle'; requestInject(); } }, 8000);
    };
    requestInject();
    await waitForReady();
    render();
    await sleep(4000);            // let the chat list settle after main ready
    if (!state.scanned && !state.scanning) scan();   // read-only; paints the badge
  }

  window.__bouncer = { state, scan, run, diag, requestCommunity, version: VERSION };
  boot();
})();
