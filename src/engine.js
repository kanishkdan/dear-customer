/*
 * Dear Customer — page engine. Runs in WhatsApp Web's own JS context next to wa-js.
 *
 * Flow: scan chats -> classify senders -> group by business -> user ticks ->
 * per number: WhatsApp's marketing opt-out -> STOP (button or text, latest live
 * number only) -> report -> block -> archive. Numbers that also send updates get
 * marketing-only actions; numbers that only send updates are left alone.
 *
 * Nothing leaves the browser except WhatsApp's own traffic and, only when the
 * user presses "Add to the Wall of Shame", business names plus hashed numbers.
 */
(() => {
  'use strict';
  if (window.__bouncerLoaded) return;
  window.__bouncerLoaded = true;

  const VERSION = '1.0.3';
  const SITE_URL = 'https://dearcustomer.kanishkdan.com';
  const LOGO = '<svg class="bz-logo" viewBox="0 0 1024 1024" aria-hidden="true"><rect width="1024" height="1024" rx="230" fill="#1c1c1e"/><path d="M192 300a96 96 0 0 1 96-96h448a96 96 0 0 1 96 96v260a96 96 0 0 1-96 96H424L300 820V656h-12a96 96 0 0 1-96-96z" fill="#fff"/><rect x="262" y="372" width="196" height="132" rx="48" fill="#1c1c1e"/><rect x="566" y="372" width="196" height="132" rx="48" fill="#1c1c1e"/><rect x="452" y="418" width="120" height="34" rx="17" fill="#1c1c1e"/></svg>';
  const STOP_TEXT = 'STOP';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowSec = () => Math.floor(Date.now() / 1000);

  // ------------------------------------------------------------------ state
  const state = {
    open: false,
    days: 7,                   // 0 = all time
    filter: 'promo',           // 'promo' | 'all'
    actions: { optout: true, stop: true, report: true, block: true, archive: true },
    onboarded: false,          // has the user answered "what do you want to do with these messages?"
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
    showIgnored: false,
    view: 'list',              // 'list' | 'chart' | 'setup'
    expanded: false,           // wide mode: list on the left, dashboard on the right
    activeId: null,            // number currently being bounced
    runActions: null,
    runKeys: [],
    undoIgnore: null,
    noticeAction: null,
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
      const pre = { onboarded: state.onboarded, actions: { ...state.actions } };
      state.historyLoaded = true;
      if (payload && typeof payload === 'object') {
        state.history = { seen: payload.seen || {}, runs: payload.runs || [], bounced: payload.bounced || {}, ignored: payload.ignored || {}, autoReport: !!payload.autoReport, actions: payload.actions || null, onboarded: !!payload.onboarded, stopDay: payload.stopDay || null, stopCount: payload.stopCount || 0, reportDay: payload.reportDay || null, reportCount: payload.reportCount || 0 };
        if (payload.actions && typeof payload.actions === 'object') state.actions = { ...state.actions, ...payload.actions };
        state.onboarded = !!payload.onboarded;
      }
      // Delete was removed in 1.0.3. A choice saved by an older version must never run it.
      delete state.actions.del;
      if (state.history.actions) delete state.history.actions.del;
      // Answered the setup question before stored history arrived: keep that answer.
      if (pre.onboarded && !state.onboarded) {
        state.onboarded = true; state.history.onboarded = true;
        state.actions = { ...pre.actions }; state.history.actions = { ...pre.actions };
        deferredSave = true;
      }
      if (deferredSave) {
        deferredSave = false;
        const rows = state.groups.filter((g) => g.kind === 'biz').flatMap((g) => g.numbers);
        if (rows.length) rememberSeen(rows); else saveHistory();
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

  // Never write before stored history has loaded: an empty copy would overwrite the
  // ignore list, saved choices and past runs.
  let deferredSave = false;
  function saveHistory() {
    if (!state.historyLoaded) { deferredSave = true; return; }
    toExt('save', state.history);
  }

  // Businesses you never want bounced. Matched by the same name key the groups use,
  // so a new number from an ignored business stays ignored.
  const ignoredMap = () => state.history.ignored || (state.history.ignored = {});
  const isIgnored = (key) => !!ignoredMap()[key];
  const selectableGroups = () => state.groups.filter((g) => !g.done && !isIgnored(g.key) && g.active.length &&
    (g.kind === 'biz' ? state.filter === 'all' || g.promo : state.filter === 'all' && state.showUnknown));
  const selectedGroups = () => selectableGroups().filter((g) => g.checked);
  function refreshBadge() {
    const n = state.groups.filter((g) => g.kind === 'biz' && g.promo && g.active.length && !g.done && !isIgnored(g.key)).length;
    setBadge(n ? String(n) : '');
  }
  function ignoreKeys(keys) {
    const m = ignoredMap();
    const names = [];
    for (const key of keys) {
      const g = state.groups.find((x) => x.key === key);
      if (!g || m[key]) continue;
      state.undoIgnore = { key, checked: g.checked };
      m[key] = { name: g.name, ts: nowSec() };
      g.checked = false;
      names.push(g.name);
    }
    if (names.length) {
      saveHistory();
      refreshBadge();
      notice(`Ignoring ${names[0]} in future scans.`, 'undo-ignore');
    }
    render();
  }
  function unignore(key) {
    delete ignoredMap()[key];
    const g = state.groups.find((x) => x.key === key);
    if (g) g.checked = false;
    saveHistory(); refreshBadge(); render();
  }
  function restoreIgnored() {
    const n = Object.keys(ignoredMap()).length;
    for (const g of state.groups) if (isIgnored(g.key)) g.checked = false;
    state.history.ignored = {}; state.undoIgnore = null;
    saveHistory(); refreshBadge();
    notice(`Restored ${n} ${n === 1 ? 'business' : 'businesses'}. Select any you want to bounce.`);
  }
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
        placePill();
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
    n.result[key] = 'running';
    updateRunUI();
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
    } finally {
      updateRunUI();
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
        // Someone saved in your contacts who uses the WhatsApp Business app is a person you
        // know. Their plain messages never count as promotions; only a real marketing
        // template from WhatsApp does.
        const saved = f.isMyContact === true && !f.isEnterprise && !f.verifiedName;
        if (saved) cats['promo-guess'] = 0;
        // What this number sends you across every loaded message, not just this period.
        // It decides which actions are safe for the number during a run.
        let sendsPromo = cats.marketing > 0 || cats['promo-guess'] > 0 || !!f.marketingThread;
        let sendsUpdates = false;
        for (const m of inboundAll) {
          const c = msgCategory(m);
          if (c === 'marketing' || (c === 'promo-guess' && !saved)) sendsPromo = true;
          if (c === 'utility' || c === 'auth') sendsUpdates = true;
        }
        const cls = sendsPromo && sendsUpdates ? 'mixed' : sendsUpdates ? 'updates' : sendsPromo ? 'promo' : 'none';
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
          enterprise: !!f.isEnterprise, saved, cls,
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
      const activeBiz = state.groups.filter((g) => g.kind === 'biz' && g.active.length && g.promo && !isIgnored(g.key)).length;
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
      g.saved = g.numbers.some((n) => n.saved);
      g.enterprise = g.numbers.some((n) => n.enterprise);
      g.sendsUpdates = g.numbers.some((n) => n.cls === 'mixed' || n.cls === 'updates');
      g.promo = g.category === 'promo' || g.category === 'guess';
      // Never pre-tick someone saved in your contacts, whatever their account type.
      g.checked = g.kind === 'biz' && g.active.length > 0 && g.promo && !g.saved && !isIgnored(g.key);
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
  // WhatsApp only shows "Stop offers and announcements" where it has switched the feature
  // on for the account. Honour that switch when WhatsApp says no. When the switch can't
  // be found, WhatsApp's own loader decides, as before.
  function optOutAllowed() {
    try {
      const gate = window.require && window.require('WAWebMarketingMessagesUserFeedbackGatingUtils');
      if (gate && typeof gate.isMMOptOutEnabled === 'function') return gate.isMMOptOutEnabled() !== false;
    } catch (_) {}
    return true;
  }
  async function stopMarketing(id) {
    if (!optOutAllowed()) throw new Error('opt-out unavailable for this WhatsApp account');
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
  function bestOptOutButton(models, minTs, minScore, promoOnly = false) {
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
        // For a number that also sends updates, only buttons that stop promotions: never
        // "disable all", a generic "unsubscribe" or a bare "stop".
        if (promoOnly && score !== 3 && score !== 2) return;
        if (score >= (minScore || 1) && (!best || score > best.score)) best = { msg: m, index: typeof b.index === 'number' ? b.index : i, text: q.displayText, score };
      });
      if (best && best.score >= (promoOnly ? 3 : 4)) break;
    }
    return best;
  }
  async function hasPromoOnlyButton(id) {
    try { const chat = await window.WPP.chat.get(id); return !!(chat && bestOptOutButton(chatModels(chat).slice(-25), 0, 2, true)); }
    catch (_) { return false; }
  }
  async function sendStop(id, { promoOnly = false } = {}) {
    const W = window.WPP;
    const chat = await W.chat.get(id);
    if (!chat) throw new Error('chat not found');
    const before = nowSec();
    const btn = bestOptOutButton(chatModels(chat).slice(-25), 0, promoOnly ? 2 : 1, promoOnly);
    let how = null;
    if (btn && typeof W.chat.replyToButtonMessage === 'function') {
      try { await W.chat.replyToButtonMessage(id, btn.msg.id, { buttonIndex: btn.index }); how = `tapped "${btn.text}"`; }
      catch (e) { log('button tap failed', String((e && e.message) || e)); }
    }
    if (!how) {
      // A typed STOP can unsubscribe from everything, so never for a number that also sends updates.
      if (promoOnly) throw new Error('no promotions-only button');
      await W.chat.sendTextMessage(id, STOP_TEXT, { waitForAck: false, linkPreview: false, markIsRead: true });
      how = 'typed STOP';
    }
    // A bot may answer with a menu. Take its strongest allowed opt-out, or a plain
    // confirmation, but never a generic confirmation for a number that sends updates.
    await sleep(3500);
    const follow = bestOptOutButton(chatModels(chat).slice(-10), before, 2, promoOnly)
      || (promoOnly ? null : (() => { const m = chatModels(chat).slice(-10).reverse().find((x) => x && x.id && !x.id.fromMe && (x.t || 0) >= before && Array.isArray(x.hydratedButtons));
        if (!m) return null; const i = m.hydratedButtons.findIndex((b) => b && b.quickReplyButton && /^(yes|confirm|ok|proceed)/i.test(String(b.quickReplyButton.displayText || '')));
        return i >= 0 ? { msg: m, index: typeof m.hydratedButtons[i].index === 'number' ? m.hydratedButtons[i].index : i, text: m.hydratedButtons[i].quickReplyButton.displayText, score: 2 } : null; })());
    if (follow && typeof W.chat.replyToButtonMessage === 'function') {
      try { await W.chat.replyToButtonMessage(id, follow.msg.id, { buttonIndex: follow.index }); how += ` then "${follow.text}"`; } catch (e) { how += ' (follow-up failed)'; }
    }
    return how;
  }

  // --------------------------------------------------------------------- run
  const actionSucceeded = (v) => v === true || v === 'already';
  const numberSucceeded = (n) => !!n.result && resultKeys.some((k) => actionSucceeded(n.result[k]));
  const resultKeys = ['optout', 'stop', 'report', 'block', 'archive'];
  function outcome(g) {
    const values = g.numbers.flatMap((n) => resultKeys.map((k) => (n.result || {})[k]).filter((v) => v !== undefined));
    const good = values.filter(actionSucceeded).length;
    const failed = values.some((v) => v === false || v === 'timeout');
    const incomplete = values.some((v) => ['skipped', 'cancelled', 'undone'].includes(v));
    if (!g.done) return { key: g.numbers.some((n) => n.id === state.activeId) ? 'running' : 'queued', label: g.numbers.some((n) => n.id === state.activeId) ? `${state.progress?.step || 'Working'}…` : 'Queued' };
    if (!values.length && g.numbers.some((n) => n.result && n.result.kept)) return { key: 'stopped', label: 'Left alone' };
    if (good) return { key: failed || incomplete ? 'partial' : 'complete', label: failed || incomplete ? 'Partly completed' : 'Completed' };
    if (failed) return { key: 'failed', label: 'Failed' };
    if (values.includes('undone')) return { key: 'stopped', label: 'Undone' };
    return { key: 'stopped', label: values.includes('cancelled') ? 'Not completed' : 'Unavailable' };
  }

  async function run() {
    if (state.running || state.scanning) return;
    const targets = selectedGroups().slice().sort(rankSort);
    if (!targets.length) return;
    const A = { ...state.actions };
    delete A.del;
    // WhatsApp's own opt-out is only used where WhatsApp itself offers it to this account.
    const optoutUnavailable = !!A.optout && !optOutAllowed();
    if (optoutUnavailable) A.optout = false;
    if (!resultKeys.some((k) => A[k])) {
      if (optoutUnavailable) notice("WhatsApp hasn't turned on its own opt-out for your account. Pick another action under Change.");
      return;
    }
    const W = window.WPP;
    state.runActions = A;
    state.runKeys = targets.map((g) => g.key);
    state.running = true;
    state.results = null;
    state.cancel = false;
    state.notice = null;
    const today = new Date().toISOString().slice(0, 10);
    const dayStops = state.history.stopDay === today ? (state.history.stopCount || 0) : 0;
    const STOP_CAP = Math.max(0, Math.min(20, 40 - dayStops));
    const dayReports = state.history.reportDay === today ? (state.history.reportCount || 0) : 0;
    const REPORT_CAP = Math.max(0, Math.min(25, 50 - dayReports));
    let stopsSent = 0, reportsSent = 0, optoutDead = false, reportDead = false;

    // Plan each number before touching anything. A number that only sends updates is left
    // alone. A number that sends both promotions and updates only gets actions that stop
    // marketing, so orders, bookings and OTPs keep coming. Every number the business used
    // is blocked and archived; only numbers active in the chosen period are reported.
    for (const g of targets) {
      g.done = false; g.expanded = false; g.stopId = null;
      for (const n of g.numbers) {
        n.result = {}; n.errors = {};
        n.plan = n.cls === 'updates' ? 'keep' : n.cls === 'mixed' ? 'marketing' : 'full';
        if (n.plan === 'keep') { n.result.kept = 'updates'; continue; }
        for (const k of resultKeys) {
          if (!A[k] || k === 'stop') continue;
          if (n.plan === 'marketing' && k !== 'optout') continue;
          if (k === 'report' && !n.inWindow) continue;
          n.result[k] = 'pending';
        }
      }
      if (A.stop) {
        const eligible = g.numbers.filter((n) => n.plan === 'full' || n.plan === 'marketing');
        const recent = eligible.find((n) => !n.blocked && n.ts >= nowSec() - 30 * 86400);
        if (recent) { g.stopId = recent.id; recent.result.stop = 'pending'; }
      }
      for (const n of g.numbers) {
        if (n.plan === 'keep' || resultKeys.some((k) => n.result[k] !== undefined)) continue;
        n.result.kept = n.plan === 'marketing' ? 'mixed' : 'old'; n.plan = 'keep';
      }
    }
    const total = targets.reduce((c, g) => c + g.numbers.filter((n) => n.plan === 'full' || n.plan === 'marketing').length, 0);
    state.progress = { done: 0, total, biz: '', phone: '', step: '' };
    const sum = { businesses: targets.length, numbers: total, optout: 0, stop: 0, report: 0, block: 0, archive: 0, failed: 0, cancelled: 0, top: [], actions: A, optoutUnavailable };
    render(true);
    log('run start', { businesses: targets.length, numbers: total, actions: A });
    for (const g of targets) {
      for (const n of g.numbers) {
        if (n.plan !== 'full' && n.plan !== 'marketing') continue;
        if (!state.cancel) state.activeId = n.id;
        const label = (what) => { state.progress.biz = g.name; state.progress.phone = fmtPhone(n.phone); state.progress.step = what; updateRunUI(); };
        const skip = (key, reason) => { n.result[key] = 'skipped'; n.errors[key] = reason; updateRunUI(); };
        const act = async (key, what, fn, ms) => {
          if (state.cancel) return false;
          label(what);
          const ok = await step(n, key, what, fn, ms);
          if (ok) { if (n.result[key] !== 'already') sum[key]++; }
          else sum.failed++;
          await sleep(150);
          return ok;
        };
        if (!state.cancel && n.result.optout === 'pending') {
          if (optoutDead) skip('optout', "WhatsApp's opt-out stopped responding earlier in this run.");
          else {
            const ok = await act('optout', 'Opting out', async () => { const v = await stopMarketing(n.id); if (v === 'already') n.result.optout = 'already'; return v; });
            if (!ok && /unavailable|timeout/.test(n.errors.optout || '')) optoutDead = true;
          }
        }
        if (!state.cancel && n.result.stop === 'pending' && n.id === g.stopId) {
          const promoOnly = n.plan === 'marketing';
          if (stopsSent >= STOP_CAP) skip('stop', 'The daily STOP limit was reached. Other actions still ran.');
          else if (promoOnly && !(await hasPromoOnlyButton(n.id))) skip('stop', 'This number also sends you updates and has no promotions-only unsubscribe button, so no STOP was sent.');
          else {
            const ok = await act('stop', 'Sending STOP', () => sendStop(n.id, { promoOnly }), 20000);
            if (ok) stopsSent++;
            state.history.stopDay = today; state.history.stopCount = dayStops + stopsSent;
            saveHistory();
            if (!state.cancel) {
              label('Waiting before the next action');
              // Check Stop during the pacing delay as well as between actions.
              const until = Date.now() + 2500 + Math.random() * 3000;
              while (!state.cancel && Date.now() < until) await sleep(200);
            }
          }
        }
        if (!state.cancel && n.result.report === 'pending') {
          if (reportDead) skip('report', 'Skipped after an earlier report timed out.');
          else if (reportsSent >= REPORT_CAP) skip('report', 'The daily report limit was reached. Other actions still ran.');
          else {
            const ok = await act('report', 'Reporting', () => reportNumber(n.id));
            if (ok) { reportsSent++; state.history.reportDay = today; state.history.reportCount = dayReports + reportsSent; }
            if (n.result.report === 'timeout') reportDead = true;
          }
        }
        if (!state.cancel && n.result.block === 'pending') {
          if (n.blocked) n.result.block = 'already';
          else await act('block', 'Blocking', async () => { await W.blocklist.blockContact(n.id); n.blocked = true; });
        }
        if (!state.cancel && n.result.archive === 'pending') {
          await act('archive', 'Archiving', async () => {
            try { await W.chat.archive(n.id); }
            catch (e) { if (/already/i.test(String(e?.message || e))) { n.result.archive = 'already'; return; } throw e; }
          });
        }
        const unstarted = !resultKeys.some((k) => actionSucceeded(n.result[k]) || n.result[k] === false || n.result[k] === 'timeout');
        if (state.cancel) {
          for (const k of resultKeys) if (n.result[k] === 'pending') n.result[k] = 'cancelled';
          if (unstarted) { n.result.cancelled = true; sum.cancelled++; }
        }
        state.progress.done++;
        updateRunUI();
      }
      g.done = true;
      state.activeId = null;
      updateRunUI();
    }
    sum.ts = nowSec(); sum.days = state.days;
    sum.stopped = state.cancel;
    sum.numbersDone = targets.reduce((c, g) => c + g.numbers.filter(numberSucceeded).length, 0);
    const successful = targets.filter((g) => g.numbers.some(numberSucceeded));
    sum.businessesDone = successful.length;
    sum.completed = targets.filter((g) => outcome(g).key === 'complete').length;
    sum.partial = targets.filter((g) => outcome(g).key === 'partial').length;
    sum.failedBusinesses = targets.filter((g) => outcome(g).key === 'failed').length;
    sum.reportDead = reportDead; sum.optoutDead = optoutDead;
    sum.top = successful.filter((g) => g.kind === 'biz').map((g) => ({ name: g.name, seen: seenCount(g) })).sort((a, b) => b.seen - a.seen).slice(0, 5);
    if (sum.numbersDone) state.history.runs.push({ ts: sum.ts, businesses: sum.businessesDone, numbers: sum.numbersDone,
      optout: sum.optout, stop: sum.stop, report: sum.report, block: sum.block, archive: sum.archive });
    const bd = state.history.bounced || (state.history.bounced = {});
    for (const g of successful) {
      if (g.kind !== 'biz') continue;
      const doneNums = g.numbers.filter(numberSucceeded);
      const e = bd[g.key] || (bd[g.key] = { name: g.name, numbers: 0, runs: 0, msgs: 0, first: sum.ts, last: sum.ts, numberIds: [] });
      e.numberIds = [...new Set([...(e.numberIds || []), ...doneNums.map((n) => n.id)])];
      e.name = g.name; e.numbers = Math.max(e.numbers || 0, e.numberIds.length); e.runs++; e.msgs += doneNums.reduce((c, n) => c + (n.msgs || 0), 0); e.last = sum.ts;
    }
    saveHistory();
    state.reportSel = {}; state.reportStatus = null;
    for (const g of successful) state.reportSel[g.key] = wallEligible(g);
    state.results = sum; state.running = false; state.progress = null; state.activeId = null; state.cancel = false; state.view = 'list';
    refreshBadge();
    render(true);
    const body = panel?.querySelector('.bz-body'); if (body) body.scrollTop = 0;
    log('run done', sum);
    if (state.history.autoReport) submitReport();
  }

  // Only official WhatsApp business accounts, never someone in your contacts, and only when
  // a number that purely sends promotions was actually handled, can go to the public Wall.
  const wallEligible = (g) => g.kind === 'biz' && g.promo && !g.saved && (g.verified || g.enterprise)
    && g.numbers.some((n) => n.plan === 'full' && numberSucceeded(n));
  function reportItems() {
    return state.groups.filter((g) => g.done && wallEligible(g) && state.reportSel[g.key]).map((g) => ({
      name: g.name, is_api: true, category: g.category, cc: ccOf((g.numbers.find((n) => n.phone) || {}).phone),
      numbers: g.numbers.filter((n) => n.plan === 'full' && numberSucceeded(n)).map((n) => n.hash).filter(Boolean).slice(0, 20),
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
  function resultTitle(sum) {
    if (sum.stopped) return 'Stopped';
    if (!sum.numbersDone) return 'Not completed';
    return sum.completed === sum.businesses ? 'Bounced' : 'Partly done';
  }
  function drawCard(sum) {
    const c = document.createElement('canvas'); c.width = 1200; c.height = 630;
    const x = c.getContext('2d');
    x.fillStyle = '#111b21'; x.fillRect(0, 0, 1200, 630);
    x.save(); x.translate(88, 84); x.rotate(-7 * Math.PI / 180);
    x.font = `700 38px ${CARD_DISPLAY}`; x.textBaseline = 'middle';
    const label = resultTitle(sum).toUpperCase(); const w = x.measureText(label).width + 44;
    x.lineWidth = 5; x.strokeStyle = '#e0332b'; x.strokeRect(0, -30, w, 60);
    x.fillStyle = '#e0332b'; x.fillText(label, 22, 2); x.restore();
    x.textBaseline = 'alphabetic';
    x.fillStyle = '#e9edef'; x.font = `700 166px ${CARD_DISPLAY}`; x.fillText(String(sum.numbersDone || 0), 80, 280);
    x.font = `500 32px ${FONT}`; x.fillText(`numbers handled across ${sum.businessesDone || 0} ${sum.businessesDone === 1 ? 'business' : 'businesses'}`, 88, 328);
    x.fillStyle = '#8696a0'; x.font = `500 24px ${FONT}`;
    const stats = [['optout', 'opt-outs'], ['stop', 'STOP replies'], ['report', 'reports'], ['block', 'blocks'], ['archive', 'archived']].filter(([k]) => sum[k]).map(([k, name]) => `${sum[k]} ${name}`).join(' · ');
    x.fillText(stats || 'No actions completed', 88, 371, 1024);
    if (sum.stopped) { x.font = `500 20px ${FONT}`; x.fillText('Stopped early. Only completed actions are counted.', 88, 405); }
    x.font = `600 14px ${CARD_DISPLAY}`; x.fillText('NUMBERS THESE BUSINESSES HAVE USED ON ME', 88, 450);
    for (const [i, t] of sum.top.slice(0, 3).entries()) {
      const y = 486 + i * 34;
      x.fillStyle = '#e9edef'; x.font = `500 24px ${FONT}`; x.fillText(clip(t.name, 40), 88, y, 850);
      x.fillStyle = '#e0332b'; x.font = `700 30px ${CARD_DISPLAY}`; x.textAlign = 'right'; x.fillText(String(t.seen), 1112, y); x.textAlign = 'left';
    }
    x.fillStyle = '#2a3942'; x.fillRect(88, 581, 1024, 1);
    x.fillStyle = '#e9edef'; x.font = `600 19px ${CARD_DISPLAY}`; x.fillText('DEAR CUSTOMER. NO.', 88, 613);
    x.fillStyle = '#8696a0'; x.font = `500 18px ${FONT}`; x.textAlign = 'right'; x.fillText('dearcustomer.kanishkdan.com', 1112, 613);
    return c;
  }
  function shareText(sum) {
    const n = sum.numbersDone || 0, b = sum.businessesDone || 0;
    return `Dear Customer. No.\n\nI cleaned up ${n} WhatsApp ${n === 1 ? 'number' : 'numbers'} from ${b} ${b === 1 ? 'business' : 'businesses'} with Dear Customer.${sum.stopped ? ' Stopped early; these are the numbers handled.' : sum.completed !== sum.businesses ? ' Some actions need attention.' : ''}`;
  }
  function postToX() {
    if (!state.results?.numbersDone) return;
    const params = new URLSearchParams({ text: shareText(state.results), url: SITE_URL });
    window.open(`https://x.com/intent/tweet?${params}`, '_blank', 'noopener,noreferrer');
  }
  function downloadCard() {
    if (!state.results?.numbersDone) return;
    const a = document.createElement('a'); a.href = drawCard(state.results).toDataURL('image/png');
    a.download = `dear-customer-${new Date().toISOString().slice(0, 10)}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    notice('Card saved. Attach it to your post on X.');
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

  /* launcher: an icon in WhatsApp's left rail, in the first free slot above Settings and
     your profile picture. Without a rail it is a pill in the bottom-left corner. */
  #bouncer-root .bz-pill { position: fixed; left: 10px; bottom: 120px; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 12px; background: transparent; color: var(--paper); transition: background .15s; }
  #bouncer-root .bz-pill:hover { background: rgba(134,150,160,.18); }
  #bouncer-root .bz-pill .bz-logo { width: 30px; height: 30px; border-radius: 8px; box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 6px 18px rgba(0,0,0,.35); }
  #bouncer-root .bz-pill .bz-pill-t { display: none; }
  #bouncer-root .bz-count { position: absolute; top: 0; right: 0; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--ink); color: #fff; font-family: var(--display); font-size: 11px; font-weight: 700; letter-spacing: 0; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-pill.wide { left: 16px; bottom: 16px; width: auto; height: 38px; gap: 10px; padding: 0 14px; border-radius: 3px; background: var(--ground); border: 1px solid var(--line); box-shadow: 0 10px 30px rgba(0,0,0,.45); font-family: var(--display); text-transform: uppercase; letter-spacing: .12em; font-weight: 600; font-size: 13px; white-space: nowrap; }
  #bouncer-root .bz-pill.wide:hover { background: #182229; }
  #bouncer-root .bz-pill.wide .bz-logo { width: 20px; height: 20px; border-radius: 5px; box-shadow: 0 0 0 1px rgba(255,255,255,.08); }
  #bouncer-root .bz-pill.wide .bz-pill-t { display: inline; }
  #bouncer-root .bz-pill.wide .bz-count { position: static; min-width: 0; height: auto; padding: 0; border-radius: 0; background: none; color: var(--ink); font-size: 15px; line-height: 1; }
  #bouncer-root .bz-mark { width: 8px; height: 8px; border-radius: 50%; background: var(--ink); flex: none; }
  #bouncer-root .bz-logo { width: 22px; height: 22px; flex: none; border-radius: 5px; box-shadow: 0 0 0 1px rgba(255,255,255,.08); }

  /* sheet */
  #bouncer-root .bz-panel { position: fixed; top: 0; left: 0; height: 100vh; width: 420px; max-width: 100vw; background: var(--ground); border-right: 1px solid var(--line); box-shadow: 24px 0 60px rgba(0,0,0,.45); display: flex; flex-direction: column; transform: translateX(calc(-100% - 120px)); visibility: hidden; transition: transform .26s cubic-bezier(.2,.8,.2,1), width .22s ease, visibility 0s linear .26s; }
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
  #bouncer-root .bz-panel.open { transform: none; visibility: visible; transition: transform .26s cubic-bezier(.2,.8,.2,1), width .22s ease, visibility 0s; }
  #bouncer-root .bz-head { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 12px 0 20px; border-bottom: 1px solid var(--line); flex: none; }
  #bouncer-root .bz-word { font-family: var(--display); text-transform: uppercase; letter-spacing: .14em; font-weight: 700; font-size: 14px; white-space: nowrap; }
  #bouncer-root .bz-wall { white-space: nowrap; margin-left: auto; font-size: 11px; color: var(--muted); padding: 6px 8px; }
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
  #bouncer-root .bz-row.done { background: transparent; }
  #bouncer-root .bz-row.outcome-complete { border-left-color: var(--ok); }
  #bouncer-root .bz-row.outcome-partial { border-left-color: #e7b45a; }
  #bouncer-root .bz-row.outcome-failed { border-left-color: var(--ink); }
  #bouncer-root .bz-row.outcome-stopped { border-left-color: var(--muted); }
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
  #bouncer-root .bz-ignore { color: var(--muted); }
  #bouncer-root .bz-ignore:hover { color: var(--paper); text-decoration: underline; text-underline-offset: 2px; }
  #bouncer-root .bz-ign { display: grid; gap: 2px; margin-top: 8px; }
  #bouncer-root .bz-ign-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13px; color: #cfd6da; }
  #bouncer-root .bz-ign-row button { margin-left: auto; color: var(--muted); font-size: 12px; }
  #bouncer-root .bz-ign-row button:hover { color: var(--paper); text-decoration: underline; text-underline-offset: 2px; }
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
  #bouncer-root .bz-num .st { display: grid; gap: 7px; width: 100%; }
  #bouncer-root .bz-st { font-size: 12px; font-weight: 500; color: var(--muted); }
  #bouncer-root .bz-st.ok { color: var(--ok); }
  #bouncer-root .bz-st.bad { color: var(--ink); }
  #bouncer-root .bz-detail-content { grid-column: 2 / -1; min-width: 0; }
  #bouncer-root .bz-action-status { display: grid; grid-template-columns: 1fr auto auto; gap: 4px 8px; }
  #bouncer-root .bz-action-status small { grid-column: 1 / -1; color: var(--muted); font-size: 11.5px; overflow-wrap: anywhere; }
  #bouncer-root .bz-plan-note { display: block; color: var(--muted); font-size: 11.5px; margin-top: 2px; }
  #bouncer-root .bz-row-status { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 10px; margin-top: 8px; }
  #bouncer-root .bz-state-mark { font-size: 15px; font-weight: 600; color: var(--muted); }
  #bouncer-root .bz-state-mark.complete { color: var(--ok); }
  #bouncer-root .bz-state-mark.partial { color: #e7b45a; }
  #bouncer-root .bz-state-mark.failed { color: #ff776f; }
  #bouncer-root .bz-outcome { font-size: 13px; font-weight: 600; color: var(--muted); }
  #bouncer-root .bz-outcome.running { color: var(--paper); }
  #bouncer-root .bz-outcome.complete { color: var(--ok); }
  #bouncer-root .bz-outcome.partial { color: #e7b45a; }
  #bouncer-root .bz-outcome.failed { color: #ff776f; }
  #bouncer-root .bz-status-note { font-size: 12px; color: var(--muted); }
  #bouncer-root .bz-detail-toggle { margin-top: 5px; padding: 3px 0; }
  #bouncer-root .bz-ign-head, #bouncer-root .bz-results-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
  #bouncer-root .bz-ignored { padding-top: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
  #bouncer-root .bz-tools { border: 0; padding-top: 0; padding-bottom: 2px; }
  #bouncer-root .bz-tools:has(:only-child) { display: none; }
  #bouncer-root .bz-notice { margin-top: 12px; }
  #bouncer-root .bz-notice button { margin-left: 5px; }
  #bouncer-root .bz-share-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 16px 20px 0; }
  #bouncer-root .bz-share-actions .bz-btn { font-size: 13px; letter-spacing: .08em; }
  #bouncer-root .bz-result-note { color: var(--muted); font-size: 12.5px; line-height: 1.5; margin-top: 8px; }
  #bouncer-root .bz-wall-contribute { margin: 20px 20px 0; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  #bouncer-root .bz-wall-title { font-size: 13px; color: var(--paper); font-weight: 600; }
  #bouncer-root .bz-wall-buttons { display: flex; gap: 16px; margin: 10px 0; }
  #bouncer-root .bz-wall-contribute .bz-auto { margin-top: 12px; font-size: 12px; }
  #bouncer-root .bz-wall-contribute .bz-note { margin: 10px 0 0; padding: 8px 10px; }
  #bouncer-root .bz-results-head { padding: 18px 20px 12px; }
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

  /* progress */
  #bouncer-root .bz-line { position: absolute; left: 0; top: -1px; height: 2px; width: 100%; background: var(--line); }
  #bouncer-root .bz-line > i { display: block; height: 100%; background: var(--ink); transition: width .25s ease; }
  #bouncer-root .bz-prog { display: grid; grid-template-columns: 1fr auto; gap: 2px 14px; align-items: center; padding-top: 2px; }
  #bouncer-root .bz-prog .t { grid-column: 1; font-family: var(--display); text-transform: uppercase; letter-spacing: .12em; font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #bouncer-root .bz-prog .s { grid-column: 1; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  #bouncer-root .bz-prog .stop { grid-column: 2; grid-row: 1 / span 2; height: 36px; padding: 0 14px; border: 1px solid var(--line); border-radius: 3px; font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-weight: 600; font-size: 12px; color: var(--paper); }
  #bouncer-root .bz-prog .stop:hover:not(:disabled) { border-color: var(--muted); }
  #bouncer-root .bz-prog .stop:disabled { color: var(--muted); }

  /* states */
  #bouncer-root .bz-empty { padding: 48px 20px; color: var(--muted); line-height: 1.5; }
  #bouncer-root .bz-empty .h { font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-weight: 700; font-size: 20px; color: var(--paper); margin-bottom: 6px; }
  #bouncer-root .bz-start { text-align: center; padding: 52px 24px 40px; }
  #bouncer-root .bz-start-ic { width: 72px; height: 72px; margin: 0 auto 18px; border-radius: 50%; background: var(--ink-soft); color: var(--ink); display: flex; align-items: center; justify-content: center; }
  #bouncer-root .bz-start-ic .bz-ic { width: 34px; height: 34px; }
  #bouncer-root .bz-start p { margin: 0 auto 24px; max-width: 290px; font-size: 13.5px; }
  #bouncer-root .bz-start .bz-btn { height: 54px; font-size: 15px; }
  #bouncer-root .bz-start .bz-btn .bz-ic { width: 20px; height: 20px; flex: none; }
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

  /* setup */
  #bouncer-root .bz-setup { padding: 28px 24px 12px; max-width: 600px; }
  #bouncer-root .bz-setup-h { font-family: var(--display); font-weight: 700; font-size: 30px; line-height: 1.08; color: var(--paper); text-wrap: balance; }
  #bouncer-root .bz-setup-s { color: var(--muted); font-size: 13px; margin: 10px 0 20px; }
  #bouncer-root .bz-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  #bouncer-root .bz-tile { display: grid; gap: 6px; align-content: start; text-align: left; padding: 16px 16px 14px; min-height: 132px; border: 1px solid var(--line); border-radius: 6px; background: #141e24; color: var(--muted); transition: border-color .12s, background .12s, color .12s; }
  #bouncer-root .bz-tile:hover { border-color: var(--muted); }
  #bouncer-root .bz-tile.on { border-color: var(--paper); background: #1a252c; color: var(--paper); }
  #bouncer-root .bz-tile-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  #bouncer-root .bz-ic { width: 26px; height: 26px; }
  #bouncer-root .bz-tile-check { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--line); position: relative; }
  #bouncer-root .bz-tile.on .bz-tile-check { background: var(--paper); border-color: var(--paper); }
  #bouncer-root .bz-tile.on .bz-tile-check::after { content: ""; position: absolute; left: 5.5px; top: 2px; width: 4px; height: 8px; border: solid var(--ground); border-width: 0 2px 2px 0; transform: rotate(45deg); }
  #bouncer-root .bz-tile-t { font-weight: 600; font-size: 15px; color: var(--paper); }
  #bouncer-root .bz-tile-b { font-size: 12.5px; line-height: 1.4; color: var(--muted); }
  #bouncer-root .bz-tile-n { font-family: var(--display); text-transform: uppercase; letter-spacing: .1em; font-size: 10px; color: var(--muted); margin-top: 2px; }
  #bouncer-root .bz-tile-n.good { color: var(--ok); }
  #bouncer-root .bz-tile-n.warn { color: var(--ink); }

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
  let shiftHeld = false;      // set on mousedown so the change handler can see it
  let rowOrder = [];          // keys in the order they are on screen, for range select
  let lastPicked = null;
  const PERIODS = [[7, '7d', 'this week'], [14, '14d', 'in the last 14 days'], [30, '30d', 'in the last 30 days'], [0, 'All', 'ever']];
  const NOT_READY = {
    loading: ['Connecting', 'A few seconds once your chats are showing. If it never clears, reload this tab.'],
    unauthenticated: ['Link your phone', 'Scan the QR code and wait for your chats to appear.'],
    syncing: ['Syncing', 'WhatsApp is still loading your chats. Give it a moment.'],
    'inject-failed': ['Couldn\'t connect', 'Reload this tab and try again.'],
  };
  const TAG_WORDS = { optout: ['WA opt-out', 'WA opt-out'], stop: ['STOP', 'STOP'], report: ['Reported', 'Report'], block: ['Blocked', 'Block'], archive: ['Archived', 'Archive'] };
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
      <button class="bz-pill" data-act="toggle" title="Dear Customer">${LOGO}<span class="bz-pill-t">Dear Customer</span><span class="bz-count" hidden></span></button>
      <aside class="bz-panel" role="dialog" aria-label="Dear Customer"></aside>`;
    document.body.appendChild(root);
    pill = root.querySelector('.bz-pill');
    panel = root.querySelector('.bz-panel');
    root.addEventListener('mousedown', (e) => { shiftHeld = !!e.shiftKey; }, true);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.open) closePanel(); });
    window.addEventListener('resize', () => { if (state.open) dockPanel(); placePill(); });
    render();
    // WhatsApp finishes laying out its rail a moment after the chat list shows.
    for (const ms of [1500, 4000, 10000]) setTimeout(placePill, ms);
  }

  // WhatsApp's left rail holds Chats, Status, Settings and your profile picture. The
  // launcher lives in that rail, in the first free slot above whatever sits at the
  // bottom, so it never covers your profile. Without a rail it is a pill in the corner.
  function placePill() {
    if (!pill || pill.hidden) return;
    let railW = 0;
    try { const pane = document.getElementById('pane-side'); if (pane) railW = Math.round(pane.getBoundingClientRect().left); } catch (_) {}
    const rail = railW >= 48 && railW <= 96;
    pill.classList.toggle('wide', !rail);
    if (!rail) { pill.style.left = ''; pill.style.bottom = ''; return; }
    const size = 44, cx = Math.round(railW / 2);
    const busy = (y) => { try { return document.elementsFromPoint(cx, y).some((el) => !root.contains(el) && el.closest('button, [role="button"], a, img')); } catch (_) { return false; } };
    let bottom = 120;
    for (let k = 0; k < 8; k++) {
      const b = 16 + k * 52, yc = window.innerHeight - b - size / 2;
      if (yc < 80) break;
      if (![yc - 26, yc, yc + 26].some(busy)) { bottom = b; break; }
    }
    pill.style.left = Math.round((railW - size) / 2) + 'px';
    pill.style.bottom = bottom + 'px';
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
    const setupW = Math.min(room - 16, 640);
    panel.style.width = (state.view === 'setup' ? Math.max(listW, setupW) : canSplit ? Math.min(room - 16, 1160) : listW) + 'px';
    panel.style.setProperty('--list-w', listW + 'px');
    return canSplit;
  }

  function openPanel() {
    state.open = true;
    if (!state.onboarded) state.view = 'setup';
    dockPanel(); render(true);
    if (!state.scanned && !state.scanning) scan();   // read-only, runs while they choose
  }
  function saveActions() {
    state.history.actions = { ...state.actions };
    state.history.onboarded = true;
    state.onboarded = true;
    saveHistory();
  }
  function closePanel() { state.open = false; state.armed = false; state.view = state.onboarded ? 'list' : 'setup'; state.expanded = false; render(); }
  const findGroup = (key) => state.groups.find((g) => g.key === key);

  // Open the conversation, scrolled to the last message they sent. Three ways in,
  // because WhatsApp Web's own navigation functions come and go between builds.
  let noticeTimer = null;
  function notice(text, action = null) {
    state.notice = text; state.noticeAction = action; render();
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { state.notice = null; state.noticeAction = null; render(); }, 8000);
  }
  async function openChat(key) {
    const g = findGroup(key); if (!g) return;
    const n = g.active[0] || g.numbers[0]; if (!n) return;
    if (state.expanded) { state.expanded = false; dockPanel(); render(true); }
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
    if (state.running && !['close', 'toggle', 'cancel', 'expand', 'expand-row', 'open', 'noop'].includes(act)) return;
    if (act === 'toggle') { if (state.open) closePanel(); else openPanel(); }
    else if (act === 'close') closePanel();
    else if (act === 'scan') scan();
    else if (act === 'run') {
      const targets = selectedGroups();
      const risky = targets.filter((g) => !g.promo || g.saved);
      if (risky.length && !state.armed) { state.armed = true; render(); setTimeout(() => { if (state.armed) { state.armed = false; render(); } }, 6000); return; }
      state.armed = false;
      run();
    }
    else if (act === 'cancel') { state.cancel = true; updateRunUI(); }
    else if (act === 'opt') { setChoice(t.dataset.key, !choiceOn(t.dataset.key)); render(); }
    else if (act === 'setup') { state.view = 'setup'; render(); }
    else if (act === 'setup-done') { saveActions(); state.view = 'list'; state.expanded = false; state.armed = false; dockPanel(); render(); }
    else if (act === 'chart') { state.view = 'chart'; render(); }
    else if (act === 'chart-close') { state.view = 'list'; render(true); }
    else if (act === 'expand') {
      // Wide enough: split view. Otherwise the chart takes the panel over.
      const left = parseInt(panel.style.left || '0', 10) || 0;
      if (!state.expanded && window.innerWidth - left < 900) { state.view = 'chart'; render(true); return; }
      state.expanded = !state.expanded; state.view = 'list'; render(true);
    }
    else if (act === 'chart-card') downloadChartCard();
    else if (act === 'noop') { /* checkbox: handled by onChange */ }
    else if (act === 'open') openChat(t.dataset.key);
    else if (act === 'filter') { state.filter = t.dataset.v === 'all' ? 'all' : 'promo'; const visible = new Set(selectableGroups()); state.groups.forEach((g) => { if (!visible.has(g)) g.checked = false; }); state.armed = false; render(); }
    else if (act === 'period') { const d = Number(t.dataset.v); if (d !== state.days) { state.days = d; state.scanned = false; scan(); } }
    else if (act === 'chip') { state.actions[t.dataset.key] = !state.actions[t.dataset.key]; saveActions(); render(); }
    else if (act === 'expand-row') { const g = findGroup(t.dataset.key); if (g) { g.expanded = !g.expanded; if (state.running) updateRunUI(); else render(); } }
    else if (act === 'all') { selectableGroups().filter((g) => g.kind === 'biz').forEach((g) => { g.checked = true; }); state.armed = false; render(); }
    else if (act === 'none') { state.groups.forEach((g) => { g.checked = false; }); state.armed = false; render(); }
    else if (act === 'unknown') { state.showUnknown = !state.showUnknown; if (!state.showUnknown) state.groups.filter((g) => g.kind === 'unknown').forEach((g) => { g.checked = false; }); state.armed = false; render(); }
    else if (act === 'ignore') ignoreKeys([t.dataset.key]);
    else if (act === 'unignore') unignore(t.dataset.key);
    else if (act === 'restore-ignored') restoreIgnored();
    else if (act === 'undo-ignore' && state.undoIgnore) { const old = state.undoIgnore; unignore(old.key); const g = findGroup(old.key); if (g && selectableGroups().includes(g)) g.checked = old.checked; state.undoIgnore = null; state.notice = null; state.noticeAction = null; render(); }
    else if (act === 'show-ignored') { state.showIgnored = !state.showIgnored; render(); }
    else if (act === 'unblock') unblock(t.dataset.id);
    else if (act === 'card') downloadCard();
    else if (act === 'post-x') postToX();
    else if (act === 'back') { state.results = null; state.reportStatus = null; state.showRep = false; scan(); }
    else if (act === 'rep-toggle') { state.showRep = !state.showRep; render(); }
    else if (act === 'report') submitReport();
    else if (act === 'auto-report') { state.history.autoReport = !state.history.autoReport; saveHistory(); render(); if (state.history.autoReport) submitReport(); }
    else if (act === 'diag') { flash(t, 'Collecting…'); diag().then(() => flash(t, 'Copied')); }
  }

  function onChange(e) {
    const t = e.target;
    if (state.running) return;
    if (t.dataset.auto) { state.history.autoReport = t.checked; saveHistory(); render(); if (t.checked) submitReport(); }
    else if (t.classList.contains('bz-rep-check')) { state.reportSel[t.dataset.key] = t.checked; render(); }
    else if (t.classList.contains('bz-check')) {
      const key = t.dataset.key;
      const g = findGroup(key);
      if (g && selectableGroups().includes(g)) g.checked = t.checked;
      // Shift-click extends the selection from the last row you picked.
      if (shiftHeld && lastPicked && lastPicked !== key) {
        const a = rowOrder.indexOf(lastPicked), b = rowOrder.indexOf(key);
        if (a !== -1 && b !== -1) {
          for (const k of rowOrder.slice(Math.min(a, b), Math.max(a, b) + 1)) {
            const x = findGroup(k); if (x && selectableGroups().includes(x)) x.checked = t.checked;
          }
        }
      }
      lastPicked = key;
      shiftHeld = false;
      state.armed = false;
      render();
    }
  }

  function render(full = false) {
    if (!root) return;
    const activeBiz = state.groups.filter((g) => g.kind === 'biz' && g.active.length && g.promo && !g.done && !isIgnored(g.key));
    pill.hidden = state.open || (loginScreen() && !state.open);
    const countEl = pill.querySelector('.bz-count');
    if (state.scanned && activeBiz.length) { countEl.textContent = String(activeBiz.length); countEl.hidden = false; }
    else countEl.hidden = true;
    placePill();
    panel.classList.toggle('open', state.open);
    if (!state.open) return;
    if (state.running && !full && panel.querySelector('.bz-run-list')) { updateRunUI(); return; }
    const bodyEl = panel.querySelector('.bz-body');
    const scrollTop = bodyEl ? bodyEl.scrollTop : 0;
    const wall = state.community && state.community.url;
    if (!state.onboarded && state.view !== 'setup') state.view = 'setup';   // the question can't be skipped
    const setup = state.view === 'setup';
    const split = dockPanel() && !setup;
    const chart = !split && state.view === 'chart';
    const head = `
      <div class="bz-head">${LOGO}<span class="bz-word">Dear Customer</span>
        <span style="margin-left:auto"></span>
        ${setup ? (state.onboarded ? `<button class="bz-wall caps" data-act="setup-done">← Back</button>` : '') : chart ? `<button class="bz-wall caps" data-act="chart-close">← Back</button>` : `<button class="bz-wall caps" data-act="expand" title="${split ? 'Back to the list only' : 'Show everything you have bounced beside the list'}">${split ? 'Hide history' : 'History'}</button>`}
        ${wall && !chart && !setup ? `<a class="bz-wall caps" style="margin-left:0" href="${esc(wall)}/wall" target="_blank" rel="noopener" title="Open the public Wall of Shame">Wall ↗</a>` : ''}
        <button class="bz-x" data-act="close" aria-label="Close">×</button></div>`;
    const listCol = `<div class="bz-body">${state.results ? renderDone() : renderList()}</div>${renderFoot()}`;
    panel.innerHTML = setup
      ? `${head}<div class="bz-body">${renderSetup()}</div>${renderSetupFoot()}`
      : split
        ? `${head}<div class="bz-split"><div class="bz-col">${listCol}</div><div class="bz-col dash"><div class="bz-body">${renderDashboard()}</div></div></div>`
        : `${head}<div class="bz-body">${chart ? renderChart() : state.results ? renderDone() : renderList()}</div>${chart ? renderChartFoot() : renderFoot()}`;
    const nb = panel.querySelector('.bz-body');
    if (nb && scrollTop) nb.scrollTop = scrollTop;

  }

  const rankSort = (a, b) => (seenCount(b) - seenCount(a)) || (b.msgs - a.msgs) || (b.active.length - a.active.length);

  function renderList() {
    if (state.running) return renderRunning();
    const s = status();
    if (s !== 'ready') { const c = NOT_READY[s] || ['One moment', '']; return `<div class="bz-empty"><div class="h">${esc(c[0])}</div>${esc(c[1])}</div>`; }
    if (state.scanError) return `<div class="bz-empty"><div class="h">Couldn't read your chats</div>${esc(state.scanError)}<div style="margin-top:10px"><button class="bz-link" data-act="scan">Try again</button></div></div>`;
    if (state.scanning) {
      const p = state.scanProgress || {};
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
      return `<div class="bz-empty"><div class="h">Reading the list</div>${p.total ? `${p.done} of ${p.total} chats` : 'Nothing is sent or changed.'}<div class="bz-scanline"><i style="width:${pct}%"></i></div></div>`;
    }
    if (!state.scanned) return `<div class="bz-empty bz-start">
      <div class="bz-start-ic">${icon('scan')}</div>
      <div class="h">Ready when you are</div>
      <p>Finds the businesses messaging you. Reads your chat list on this device only. Nothing is sent or changed until you press Bounce.</p>
      <button class="bz-btn bz-start-cta" data-act="scan">${icon('scan')}Look for businesses</button></div>`;

    const allBiz = state.groups.filter((g) => g.kind === 'biz' && g.active.length && !isIgnored(g.key));
    const promoOnly = state.filter === 'promo';
    const biz = (promoOnly ? allBiz.filter((g) => g.promo) : allBiz).slice().sort(rankSort);
    const hiddenN = allBiz.length - biz.length;
    const unknown = promoOnly ? [] : state.groups.filter((g) => g.kind === 'unknown' && g.active.length && !isIgnored(g.key));
    rowOrder = biz.map((g) => g.key).concat(state.showUnknown ? unknown.map((g) => g.key) : []);
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
        <div class="bz-toolbar">${ignoredControl()}<span class="sp"></span><button data-act="scan">Rescan</button></div>
        ${renderNotice()}
        ${renderUnknown(unknown)}
        ${renderIgnored()}
        ${state.scanStats && state.scanStats.chats ? `<div class="bz-tip">Missing something that's clearly an ad? <button class="bz-link muted" data-act="diag">Copy diagnostics</button> and send them over.</div>` : ''}`;
    }
    return `
      <div class="bz-hero">
        <div class="bz-hero-row"><div class="bz-big">${biz.length}</div>
          <div class="bz-lead">${bizWord(biz.length)} ${promoOnly ? 'sent you promotions' : 'messaged you'} ${esc(periodWord())}, burning <b>${burned}</b> ${burned === 1 ? 'number' : 'numbers'} on you.<br><span class="m">Ranked by numbers burned.</span></div></div>
        ${tabs}
      </div>
      <div class="bz-toolbar"><span>${sel} of ${biz.length} selected</span><span>·</span><button data-act="all">Select all</button><span>·</span><button data-act="none">None</button><span class="sp"></span><button data-act="scan">Rescan</button></div>
      <div class="bz-toolbar bz-tools">${ignoredControl()}<span class="sp"></span></div>
      ${renderNotice()}
      ${renderIgnored()}
      ${firstRun ? `<div class="bz-tip" style="padding-top:12px;padding-bottom:12px">Click a business to check its messages. Untick it to skip this run; ignore it to skip future scans.</div>` : ''}
      <div class="bz-ledger">${biz.map((g, i) => renderRow(g, i + 1)).join('')}</div>
      ${promoOnly && hiddenN ? `<div class="bz-tip">${hiddenN} more ${bizWord(hiddenN)} messaged you without looking promotional. <button class="bz-link" data-act="filter" data-v="all">Show all</button></div>` : ''}
      ${renderUnknown(unknown)}`;
  }

  function ignoredControl() {
    const n = Object.keys(ignoredMap()).length;
    return n ? `<button class="bz-link muted" data-act="show-ignored" aria-expanded="${state.showIgnored}">Ignored (${n}) ${state.showIgnored ? '‹' : '›'}</button>` : '';
  }
  function renderNotice() {
    return state.notice ? `<div class="bz-notice" role="status">${esc(state.notice)}${state.noticeAction ? ` <button class="bz-link" data-act="${esc(state.noticeAction)}">Undo</button>` : ''}</div>` : '';
  }
  function renderIgnored() {
    const rows = Object.entries(ignoredMap()).map(([key, e]) => ({ key, name: e?.name || key }));
    if (!rows.length || !state.showIgnored) return '';
    return `<div class="bz-section bz-ignored"><div class="bz-ign-head"><span>Skipped in every scan</span><button class="bz-link" data-act="restore-ignored">Restore all</button></div>
      <div class="bz-ign">${rows.map((r) => `<div class="bz-ign-row"><span>${esc(r.name)}</span><button data-act="unignore" data-key="${esc(r.key)}">Restore</button></div>`).join('')}</div></div>`;
  }

  function renderRunning() {
    const groups = state.runKeys.map(findGroup).filter(Boolean);
    return `<div class="bz-hero"><div class="bz-hero-row"><div class="bz-big">${groups.length}</div><div class="bz-lead">${bizWord(groups.length)} in this run.<br><span class="m">Open Details to follow each action.</span></div></div></div>
      <div class="bz-tip" style="padding-bottom:14px">Stop leaves completed actions in place.</div>
      <div class="bz-ledger bz-run-list">${groups.map((g, i) => renderRow(g, i + 1)).join('')}</div>`;
  }
  const outcomeMark = (key) => ({ complete: '✓', partial: '!', failed: '×', stopped: '—', running: '›', queued: '·' })[key];
  function renderGroupStatus(g) {
    const o = outcome(g);
    const good = g.numbers.filter(numberSucceeded).length;
    return `<span class="bz-outcome ${o.key}">${esc(o.label)}</span>${g.done && g.numbers.length > 1 ? `<span class="bz-status-note">${good} of ${g.numbers.length} numbers handled</span>` : ''}`;
  }
  function updateRunUI() {
    if (!panel || !state.open || !state.running) return;
    for (const row of panel.querySelectorAll('[data-row-key]')) {
      const g = findGroup(row.dataset.rowKey); if (!g) continue;
      const o = outcome(g);
      row.classList.toggle('active', o.key === 'running');
      for (const key of ['complete', 'partial', 'failed', 'stopped']) row.classList.toggle(`outcome-${key}`, g.done && o.key === key);
      const mark = row.querySelector('.bz-state-mark');
      if (mark) { mark.textContent = outcomeMark(o.key); mark.className = `bz-state-mark ${o.key}`; }
      const status = row.querySelector('.bz-row-status');
      const html = renderGroupStatus(g);
      if (status && status.innerHTML !== html) status.innerHTML = html;
      const details = row.querySelector('.bz-detail-content');
      if (details) { details.hidden = !g.expanded; if (g.expanded) { const nums = renderNums(g); if (details.innerHTML !== nums) details.innerHTML = nums; } }
      const toggle = row.querySelector('.bz-detail-toggle');
      if (toggle) { toggle.textContent = g.expanded ? 'Hide details' : 'Details'; toggle.setAttribute('aria-expanded', String(!!g.expanded)); }
    }
    const p = state.progress;
    if (!p) return;
    const text = (selector, value) => { const el = panel.querySelector(selector); if (el && el.textContent !== value) el.textContent = value; };
    text('.bz-prog .t', state.cancel ? 'Stopping after this action' : p.biz || 'Preparing');
    text('.bz-prog .s', `${p.done} of ${p.total} numbers processed${p.step ? ` · ${p.step}` : ''}`);
    text('.bz-prog .stop', state.cancel ? 'Stopping…' : 'Stop');
    const stop = panel.querySelector('.bz-prog .stop'); if (stop) stop.disabled = state.cancel;
    const line = panel.querySelector('.bz-line > i'); if (line) line.style.width = `${p.total ? Math.round(p.done / p.total * 100) : 0}%`;
  }

  function renderRow(g, rank) {
    const seen = seenCount(g);
    const allBlocked = g.numbers.length > 0 && g.blockedCount === g.numbers.length;
    const [catText, catCls] = CAT_LABEL[g.category] || ['', ''];
    const showCat = state.filter === 'all' && !g.done;   // inside the Promotional tab the label is redundant
    const labels = [
      g.known ? `<span class="bz-lab warn">On the Wall · ${g.known.people}</span>` : '',
      showCat && catText && !(g.known && catCls === 'hot') ? `<span class="bz-lab ${catCls}">${catText}</span>` : '',
      g.saved ? '<span class="bz-lab">In your contacts</span>' : '',
      g.sendsUpdates && g.promo && !g.done ? '<span class="bz-lab">Also sends updates</span>' : '',
      g.optedOut ? '<span class="bz-lab">Opted out</span>' : '',
      allBlocked && !g.done ? '<span class="bz-lab">Blocked</span>' : '',
    ].join('');
    const single = g.numbers.length === 1;
    const locked = state.running || g.done;
    const showNums = g.expanded;
    const o = locked ? outcome(g) : null;
    const last = g.numbers[0];
    const isActive = state.running && g.numbers.some((n) => n.id === state.activeId);
    const meta = [
      plural(g.msgs, 'message'),
      esc(fmtAgo(last.ts)),
      single ? esc(fmtPhone(last.phone)) : (!locked ? `<button data-act="expand-row" data-key="${esc(g.key)}" aria-expanded="${!!g.expanded}">${g.expanded ? 'Hide numbers' : `${plural(g.numbers.length, 'number')} ›`}</button>` : plural(g.numbers.length, 'number')),
      !locked ? `<button class="bz-ignore" data-act="ignore" data-key="${esc(g.key)}" title="Never show ${esc(g.name)} again">Ignore</button>` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="bz-row ${g.checked && !locked ? 'on' : ''} ${g.done ? `done outcome-${o.key}` : ''} ${isActive ? 'active' : ''}" data-row-key="${esc(g.key)}" data-act="open" data-key="${esc(g.key)}" title="Open the conversation at their last message">
        ${locked ? `<span class="bz-state-mark ${o.key}" aria-hidden="true">${outcomeMark(o.key)}</span>` : `<input type="checkbox" class="bz-check" data-act="noop" data-key="${esc(g.key)}" ${g.checked ? 'checked' : ''} aria-label="Select ${esc(g.name)}">`}
        <span class="bz-rank">${rank ? String(rank).padStart(2, '0') : ''}</span>
        <div class="bz-main">
          <div class="bz-row1"><span class="bz-name">${esc(g.name)}</span>${labels}</div>
          ${g.preview && !g.done ? `<div class="bz-msg ${g.previewSys ? 'sys' : ''}">${esc(g.preview)}</div>` : ''}
          <div class="bz-meta">${g.done ? plural(g.numbers.length, 'number') : meta}</div>
          ${locked ? `<div class="bz-row-status" role="status">${renderGroupStatus(g)}</div><button class="bz-detail-toggle bz-link muted" data-act="expand-row" data-key="${esc(g.key)}" aria-expanded="${!!g.expanded}">${g.expanded ? 'Hide details' : 'Details'}</button>` : ''}
        </div>
        ${seen >= 2 ? `<div class="bz-tally"><b>${seen}</b><small>numbers<br>burned</small></div>` : '<span></span>'}
        <div class="bz-detail-content" ${showNums ? '' : 'hidden'}>${showNums ? renderNums(g) : ''}</div>
      </div>`;
  }

  function renderNums(g) {
    return `<div class="bz-nums">${g.numbers.map((n) => `
      <div class="bz-num"><span>${esc(fmtPhone(n.phone))}</span><span class="when">${esc(fmtAgo(n.ts))}${n.blocked && !n.result ? ' · blocked' : ''}</span><span class="st">${renderResultTags(n)}</span></div>`).join('')}</div>`;
  }

  function renderResultTags(n) {
    if (!n.result) return '';
    if (n.result.kept) return `<span class="bz-action-status"><span>No action</span><span class="bz-st">Left alone</span><small>${n.result.kept === 'mixed' ? 'This number also sends you updates, and no marketing-only action was available.' : n.result.kept === 'old' ? 'No message from this number in the chosen period, so there was nothing to report.' : 'This number sends you updates like orders, bookings or OTPs.'}</small></span>`;
    const names = { optout: 'WhatsApp opt-out', stop: 'STOP reply', report: 'Report', block: 'Block', archive: 'Archive' };
    return resultKeys.map((k) => {
      const v = n.result[k]; if (v === undefined) return '';
      const label = v === true ? 'Done' : v === 'already' ? 'Already done' : v === 'undone' ? 'Undone' : v === 'pending' ? 'Waiting' : v === 'running' ? 'Working…' : v === 'cancelled' ? 'Not run' : v === 'skipped' ? 'Skipped' : v === 'timeout' ? 'Timed out' : 'Failed';
      const cls = actionSucceeded(v) ? 'ok' : v === false || v === 'timeout' ? 'bad' : '';
      const reason = n.errors?.[k];
      const undo = k === 'block' && v === true && !state.running ? `<button class="bz-undo" data-act="unblock" data-id="${esc(n.id)}">Unblock</button>` : '';
      return `<span class="bz-action-status"><span>${names[k]}</span><span class="bz-st ${cls}">${label}</span>${undo}${reason ? `<small>${esc(reason)}</small>` : ''}</span>`;
    }).join('') + (n.plan === 'marketing' ? '<small class="bz-plan-note">This number also sends you updates, so only marketing opt-outs ran.</small>' : '');
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
        <div class="bz-prog"><div class="t">${esc(p.biz || 'Preparing')}</div><button class="stop" data-act="cancel" ${state.cancel ? 'disabled' : ''}>${state.cancel ? 'Stopping…' : 'Stop'}</button><div class="s">${p.done} of ${plural(p.total, 'number')} processed${p.step ? ` · ${esc(p.step)}` : ''}</div></div></div>`;
    }
    if (status() !== 'ready' || !state.scanned || state.scanning || state.scanError) return '';
    const targets = selectedGroups();
    const risky = targets.filter((g) => !g.promo || g.saved);
    const n = targets.reduce((s, g) => s + g.numbers.length, 0);
    const A = state.actions;
    const parts = [(A.optout || A.stop) && 'opt out', A.report && 'report', A.block && 'block', A.archive && 'archive'].filter(Boolean);
    const what = parts.length ? parts.join(' · ') : 'No actions selected';
    let label = !targets.length ? 'Select a business' : targets.length === 1 ? `Bounce ${clip(targets[0].name, 22)}` : `Bounce ${targets.length} businesses`;
    if (state.armed) label = `Sure? Bounce ${targets.length === 1 ? clip(targets[0].name, 18) : `${targets.length} businesses`}`;
    const hint = state.armed
      ? `${risky.length === 1 ? `<b>${esc(risky[0].name)}</b> ${risky[0].saved ? 'is saved in your contacts' : "doesn't look promotional"}` : `${risky.length} of these are saved contacts or don't look promotional`}. Click again to bounce anyway.`
      : `${esc(what)} · <button data-act="setup">Change</button>${A.report ? `<br><span class="bz-warn">Reports can't be withdrawn. Blocks and archives can be undone.</span>` : ''}`;
    return `<div class="bz-foot">
      <button class="bz-btn ${state.armed ? 'armed' : ''}" data-act="run" ${targets.length && parts.length ? '' : 'disabled'}>${esc(label)}${n > targets.length && !state.armed ? `<span class="n">${plural(n, 'number')}</span>` : ''}</button>
      <div class="bz-hint">${hint}</div>
    </div>`;
  }

  function renderDone() {
    const s = state.results;
    const A = s.actions || state.actions;
    const groups = state.runKeys.map(findGroup).filter(Boolean);
    const stats = [
      A.optout ? `<b>${s.optout}</b> WhatsApp opt-outs` : '', A.stop ? `<b>${s.stop}</b> STOP replies` : '',
      A.report ? `<b>${s.report}</b> reported` : '', A.block ? `<b>${s.block}</b> blocked` : '',
      A.archive ? `<b>${s.archive}</b> archived` : '',
    ].filter(Boolean).join(' · ');
    const rs = state.reportStatus;
    const eligible = groups.filter(wallEligible);
    const selN = eligible.filter((g) => state.reportSel[g.key]).length;
    return `<div class="bz-done">
        <div class="bz-stamp">${resultTitle(s)}</div>
        <div class="bz-hero-row"><div class="bz-big ink">${s.numbersDone}</div><div class="bz-lead">${s.numbersDone === 1 ? 'number' : 'numbers'} handled across ${s.businessesDone} ${bizWord(s.businessesDone)}.</div></div>
        <div class="bz-stats">${stats}</div>
        ${s.optoutUnavailable ? `<div class="bz-result-note">WhatsApp hasn't turned on its own marketing opt-out for your account yet, so it was skipped.</div>` : ''}
        <div class="bz-result-note">${s.stopped ? 'Stopped early. Completed actions stay in place.' : !s.numbersDone ? 'No completed actions were confirmed. Check Details before trying again.' : s.completed !== s.businesses ? 'Some actions could not finish. Check the details below.' : 'All requested actions completed.'}</div>
      </div>
      ${s.numbersDone ? `<div class="bz-share-actions"><button class="bz-btn paper" data-act="post-x">Post to X ↗</button><button class="bz-btn ghost" data-act="card">Save share card</button></div>
        <div class="bz-hint">Opens a draft with your results and a link.<br>Save the card to attach it yourself.</div>` : ''}
      ${renderNotice()}
      <div class="bz-results-head"><span>Results by business</span><button class="bz-link muted" data-act="expand">View history</button></div>
      <div class="bz-ledger">${groups.map((g, i) => renderRow(g, i + 1)).join('')}</div>
      ${eligible.length ? `<div class="bz-wall-contribute">
        <div class="bz-wall-title">Help others spot these senders</div>
        <div class="bz-result-note">Share business names and hashed numbers with the public Wall of Shame.</div>
        ${rs?.ok ? `<a class="bz-link" href="${esc(rs.url || SITE_URL)}/wall" target="_blank" rel="noopener">Added · Open the Wall of Shame ↗</a>` : `<div class="bz-wall-buttons"><button class="bz-link" data-act="report" ${!selN || rs === 'sending' ? 'disabled' : ''}>${rs === 'sending' ? 'Adding…' : `Add ${selN} to the Wall`}</button><button class="bz-link muted" data-act="rep-toggle">${state.showRep ? 'Hide selection' : 'Choose which'}</button></div>`}
        ${rs?.error ? `<div class="bz-result-note">Couldn't add: ${esc(rs.error)}. Try again.</div>` : ''}
        ${state.showRep ? renderRepList(eligible) : ''}
        <label class="bz-auto"><input type="checkbox" class="bz-check" data-act="noop" data-auto="1" ${state.history.autoReport ? 'checked' : ''}> Add automatically after future runs</label>
      </div>` : ''}`;
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
      ${wall ? `<div class="bz-dash-top" style="padding-top:4px"><span class="caps" style="color:var(--muted);font-size:11px">Wall of Shame, everyone</span><span class="sp"></span>${C && C.url ? `<a class="bz-link muted" href="${esc(C.url + '/wall')}" target="_blank" rel="noopener">Open ↗</a>` : ''}</div>${wall}` : ''}`;
  }

  // One choice per outcome. "Opt out" runs both opt-out flows: WhatsApp's own
  // (Meta's side) and STOP (the business's side). They act on different systems
  // and only together cover what each one misses.
  const ICONS = {
    unsub: '<path d="M6 9a6 6 0 0 1 12 0v4l2 3H4l2-3z"/><path d="M10 19a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/>',
    report: '<path d="M5 21V4"/><path d="M5 4h12l-2 3.5 2 3.5H5"/>',
    block: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
    archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
    scan: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/><path d="M8.5 11h5M11 8.5v5"/>',
  };
  const icon = (k) => `<svg class="bz-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ''}</svg>`;
  const CHOICES = [
    ['unsub', 'Opt out', "Two at once: WhatsApp's own stop-marketing setting, and a STOP sent to the business.", 'Reversible', 'good'],
    ['report', 'Report', 'Sends their latest message to WhatsApp for review.', "Can't be undone", 'warn'],
    ['block', 'Block', 'The number can never message you again.', 'Reversible', 'good'],
    ['archive', 'Archive', 'Out of your chat list. Unarchive any time.', 'Reversible', 'good'],
  ];
  const choiceOn = (key) => (key === 'unsub' ? !!(state.actions.optout || state.actions.stop) : !!state.actions[key]);
  function setChoice(key, on) {
    if (key === 'unsub') { state.actions.optout = on; state.actions.stop = on; }
    else state.actions[key] = on;
  }
  function renderSetup() {
    return `
      <div class="bz-setup">
        <div class="bz-setup-h">What do you want to do with these messages?</div>
        <div class="bz-setup-s">For every business you tick. Change it any time.</div>
        <div class="bz-tiles">
          ${CHOICES.map(([key, title, body, note, cls]) => `
            <button class="bz-tile ${choiceOn(key) ? 'on' : ''}" data-act="opt" data-key="${key}" aria-pressed="${choiceOn(key) ? 'true' : 'false'}">
              <span class="bz-tile-top">${icon(key)}<span class="bz-tile-check"></span></span>
              <span class="bz-tile-t">${title}</span>
              <span class="bz-tile-b">${body}</span>
              <span class="bz-tile-n ${cls}">${note}</span>
            </button>`).join('')}
        </div>
      </div>`;
  }
  function renderSetupFoot() {
    const A = state.actions;
    const n = CHOICES.filter(([k]) => choiceOn(k)).length;
    return `<div class="bz-foot"><button class="bz-btn paper" data-act="setup-done" ${n ? '' : 'disabled'}>${n ? 'Continue' : 'Pick at least one'}</button>
      <div class="bz-hint">${A.report ? "Reports can't be withdrawn. Everything else can be undone." : 'Everything here can be undone.'}</div></div>`;
  }

  function renderChartFoot() {
    if (state.running) return renderFoot();
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
    x.fillText('D E A R   C U S T O M E R   ·   D E A R C U S T O M E R . K A N I S H K D A N . C O M', 1112, H - 28); x.textAlign = 'left';
    return c;
  }
  function downloadChartCard() {
    const rows = bouncedRows(); if (!rows.length) return;
    const c = drawChartCard(rows);
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = `dear-customer-history-${new Date().toISOString().slice(0, 10)}.png`;
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

  // Debug handle for support and tests. Off unless switched on with
  // localStorage.setItem('dearcustomer.debug', '1'), and it can never start a run.
  const debugHandle = { state, scan, diag, requestCommunity, version: VERSION };
  try {
    Object.defineProperty(window, '__bouncer', {
      configurable: true,
      get() { let on = false; try { on = window.localStorage.getItem('dearcustomer.debug') === '1'; } catch (_) {} return on ? debugHandle : { version: VERSION }; },
    });
  } catch (_) {}
  boot();
})();
