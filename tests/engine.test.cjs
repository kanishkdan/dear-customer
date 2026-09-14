const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness() {
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const calls = [], messages = [], cardText = [], opened = [], listeners = [], buttons = {};
  const ctx = new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 100 }) : key === 'fillText' ? (text, x, y) => cardText.push({ text, x, y }) : () => {} });
  const WPP = { isInjected: true, isReady: true, isFullReady: true, conn: { isAuthenticated: () => true },
    blocklist: { blockContact: async (id) => calls.push(['block', id]) },
    chat: { archive: async (id) => calls.push(['archive', id]), delete: async (id) => calls.push(['delete', id]),
      get: async (id) => { const t = Math.floor(clock / 1000) - 60;
        const msgs = [{ id: { _serialized: `${id}-m`, fromMe: false }, type: buttons[id] ? 'hsm' : 'chat', body: 'Sale', t, ...(buttons[id] ? { hydratedButtons: buttons[id] } : {}) }];
        return { id: { _serialized: id }, contact: { id }, msgs: { toArray: () => msgs, getModelsArray: () => msgs } }; },
      replyToButtonMessage: async (id, msgId, o) => calls.push(['tap', id, o.buttonIndex]),
      sendTextMessage: async (id, text) => calls.push(['text', id, text]) },
    contact: { get: async (id) => ({ id }) },
    whatsapp: { functions: { reportSpam: async (chat) => { calls.push(['report', chat.id._serialized]); return {}; } } } };
  const sandbox = { window: { WPP, addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); }, postMessage: (m) => messages.push(m), innerWidth: 1400, open: (...args) => opened.push(args) },
    document: { createElement: () => ({ getContext: () => ctx }) }, console: { log() {} },
    Date: Clock, URLSearchParams, setTimeout: (fn, ms) => setTimeout(() => { clock += ms; fn(); }, ms >= 6000 ? 25 : 0), clearTimeout };
  let source = fs.readFileSync(path.join(__dirname, '../src/engine.js'), 'utf8');
  // Exercise production handlers and runner, replacing only browser rendering/boot.
  source = source.replace('function render(full = false) {', 'function render() {}\nfunction renderOriginal(full = false) {');
  source = source.replace('  boot();', `root = { contains: () => true }; panel = { style: {left:'0px'}, querySelector: () => null }; window.testAPI = { state, run, onClick, outcome, selectedGroups, renderList, renderDone, renderResultTags, reportItems, drawCard, shareText, postToX, groupRows, msgCategory, saveHistory };`);
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const api = sandbox.window.testAPI;
  api.state.scanned = true; api.state.onboarded = true;
  api.state.history = { seen: {}, runs: [], ignored: {}, bounced: {} };
  api.state.historyLoaded = true;
  api.state.actions = { block: true };
  // WhatsApp's switch for its own marketing opt-out, and the opt-out module behind it.
  const gate = (on) => { sandbox.window.require = on ? (n) => (n === 'WAWebMarketingMessagesUserFeedbackGatingUtils' ? { isMMOptOutEnabled: () => true }
    : n === 'WAWebOptOutBizAction' ? { optOutContact: async (c) => calls.push(['optout', c.id]) } : null) : undefined; };
  const send = (type, payload) => listeners.forEach((fn) => fn({ source: sandbox.window, data: { __bouncer: true, dir: 'to-page', type, payload } }));
  return { ...api, WPP, calls, messages, cardText, opened, buttons, gate, send, sandbox,
    click: (act, key, v) => api.onClick({ target: { closest: () => ({ dataset: { act, key, v } }) } }) };
}
function group(name, count = 1) {
  const nums = Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}@c.us`, hash: `${name}-${i}-hash`, phone: '919999999999', ts: Math.floor(Date.now()/1000), inWindow: true, msgs: 1, category: 'promo' }));
  return { key: name, name, kind: 'biz', promo: true, category: 'promo', checked: true, verified: true, active: nums, numbers: nums, msgs: count, blockedCount: 0 };
}

test('ignore excludes a sender from Select all and the runner, even with stale checked state', async () => {
  const h = harness(); const a = group('Ignored'), b = group('Visible'); h.state.groups = [a, b];
  h.click('ignore', a.key); h.click('all'); assert.equal(a.checked, false);
  a.checked = true; await h.run();
  assert.deepEqual(h.calls, [['block', b.numbers[0].id]]);
});
test('all-ignored empty state offers restore and Undo restores a single selection', () => {
  const h = harness(); const a = group('A'), b = group('B'); h.state.groups = [a,b];
  h.click('ignore', 'A'); h.click('undo-ignore'); assert.equal(a.checked, true); assert.equal(Object.keys(h.state.history.ignored).length, 0);
  h.click('ignore', 'A'); h.click('ignore', 'B');
  assert.match(h.renderList(), /Ignored \(2\)/); assert.match(h.renderList(), /undo-ignore/);
  h.click('show-ignored'); assert.match(h.renderList(), /Restore all/);
  h.click('restore-ignored'); assert.equal(Object.keys(h.state.history.ignored).length, 0);
  assert.equal(a.checked, false); assert.equal(b.checked, false);
  assert.equal(h.messages.filter((m) => m.type === 'save').at(-1).payload.ignored.A, undefined);
});
test('number expansion changes only that row', () => {
  const h = harness(); const a = group('A', 3); h.state.groups = [a];
  h.click('expand-row', 'A'); assert.equal(a.expanded, true); assert.equal(h.state.expanded, false);
  h.click('expand-row', 'A'); assert.equal(a.expanded, false);
});
test('switching to Promotional removes hidden alert selections', async () => {
  const h = harness(); const a = group('Alert'); a.promo = false; a.category = 'txn'; h.state.filter = 'all'; h.state.groups = [a,group('Promo')];
  h.click('filter', undefined, 'promo'); assert.equal(a.checked, false);
  a.checked = true; await h.run(); assert.equal(h.calls.length, 1); assert.match(h.calls[0][1], /^Promo/);
});
test('all failed means no Bounced headline, history, Wall submission, or sharing', async () => {
  const h = harness(); h.state.groups = [group('A')]; h.state.history.autoReport = true;
  h.WPP.blocklist.blockContact = async () => { throw Error('mock failure'); };
  await h.run();
  assert.equal(h.state.results.numbersDone, 0); assert.equal(h.state.results.businessesDone, 0);
  assert.equal(h.state.history.runs.length, 0); assert.equal(Object.keys(h.state.history.bounced).length, 0);
  assert.match(h.renderDone(), /Not completed/); assert.doesNotMatch(h.renderDone(), /data-act="post-x"/);
  assert.equal(h.reportItems().length, 0); assert.equal(h.messages.some((m) => m.type === 'report'), false);
  h.postToX(); assert.equal(h.opened.length, 0);
});
test('partial outcomes expose failure reasons and count only numbers with a successful action', async () => {
  const h = harness(); const a=group('A',2); h.state.groups=[a]; h.state.actions={block:true,archive:true};
  h.WPP.blocklist.blockContact=async(id)=>{if(id===a.numbers[1].id) throw Error('cannot block');};
  h.WPP.chat.archive=async()=>{throw Error('cannot archive');}; await h.run();
  assert.equal(h.outcome(a).key, 'partial'); assert.equal(h.state.results.numbersDone, 1);
  assert.equal(h.state.history.bounced.A.numbers, 1);
  assert.deepEqual(Array.from(h.reportItems()[0].numbers), [a.numbers[0].hash]);
  assert.match(h.renderResultTags(a.numbers[1]), /cannot archive/); assert.match(h.renderDone(), /Partly done/);
});
test('Stop after the current action leaves later actions unrun and fixes share counts', async () => {
  const h = harness(); const a=group('A',2); h.state.groups=[a,group('B')]; h.state.actions={block:true,archive:true};
  h.WPP.blocklist.blockContact=async(id)=>{h.calls.push(['block',id]); h.state.cancel=true;}; await h.run();
  assert.equal(h.calls.length, 1); assert.equal(a.numbers[0].result.archive, 'cancelled');
  assert.equal(h.state.results.numbersDone, 1); assert.equal(h.state.results.businessesDone, 1);
  assert.equal(h.outcome(a).key, 'partial'); assert.equal(h.state.history.bounced.B, undefined);
  h.drawCard(h.state.results); assert.equal(h.cardText.find((t)=>t.y===280).text, '1');
  assert.match(h.shareText(h.state.results), /1 WhatsApp number from 1 business/);
  h.postToX(); const url = new URL(h.opened[0][0]);
  assert.equal(url.origin,'https://x.com'); assert.equal(url.searchParams.get('url'),'https://dearcustomer.kanishkdan.com');
  assert.match(url.searchParams.get('text'), /Stopped early/);
});
test("WhatsApp's opt-out is skipped where WhatsApp hasn't enabled it, without holding back other actions", async () => {
  const h=harness(); const a=group('A',2); h.state.groups=[a]; h.state.actions={optout:true,block:true}; await h.run();
  assert.equal(h.calls.some((c)=>c[0]==='optout'),false);
  assert.equal(a.numbers[1].result.optout,undefined); assert.equal(a.numbers[1].result.block,true);
  assert.equal(h.outcome(a).key,'complete'); assert.equal(h.state.results.optoutUnavailable,true);
  assert.match(h.renderDone(),/turned on its own marketing opt-out/);
});
test('a run with only the unavailable opt-out selected does not start', async () => {
  const h=harness(); h.state.groups=[group('A')]; h.state.actions={optout:true}; await h.run();
  assert.ok(!h.state.results); assert.equal(h.calls.length,0); assert.equal(h.state.running,false);
});
test('run actions are a snapshot and already-completed actions count without inflating action totals', async () => {
  const h=harness(); const a=group('A'); h.state.groups=[a]; h.state.actions={block:true,archive:true};
  h.WPP.blocklist.blockContact=async()=>{h.state.actions.archive=false;};
  h.WPP.chat.archive=async()=>{throw Error('already archived');}; await h.run();
  assert.equal(a.numbers[0].result.archive,'already'); assert.equal(h.state.results.archive,0); assert.equal(h.outcome(a).key,'complete');
});
test('STOP cap is explicit and does not suppress blocking', async () => {
  const h=harness(); const a=group('A'); h.state.groups=[a]; h.state.actions={stop:true,block:true};
  h.state.history.stopDay = new Date().toISOString().slice(0,10); h.state.history.stopCount=40;
  await h.run(); assert.equal(a.numbers[0].result.stop,'skipped'); assert.equal(a.numbers[0].result.block,true);
  assert.match(h.renderResultTags(a.numbers[0]),/STOP limit/);
});
test('a timeout is not reported as success', async()=>{
  const h=harness(); const a=group('A'); h.state.groups=[a]; h.WPP.blocklist.blockContact=()=>new Promise(()=>{});
  await h.run(); assert.equal(a.numbers[0].result.block,'timeout'); assert.equal(h.state.results.numbersDone,0); assert.match(h.renderResultTags(a.numbers[0]),/Timed out/);
});
test('a sender that also sends updates only gets marketing opt-outs; update-only and inactive numbers are left alone', async () => {
  const h = harness(); h.gate(true); h.state.actions = { optout: true, stop: true, report: true, block: true, archive: true };
  const m = group('Myntra', 3); m.numbers[0].cls = 'mixed'; m.numbers[1].cls = 'updates'; m.numbers[2].cls = 'promo'; m.numbers[2].inWindow = false;
  m.active = m.numbers.slice(0, 2);
  h.buttons[m.numbers[0].id] = [{ index: 0, quickReplyButton: { displayText: 'Disable all communication' } }, { index: 1, quickReplyButton: { displayText: 'Stop promotions' } }];
  const s = group('Spam'); s.numbers[0].cls = 'promo';
  h.state.groups = [m, s]; await h.run();
  const [mixed, updates, inactive] = m.numbers.map((n) => n.id);
  assert.deepEqual(h.calls.filter((c) => c[1] === mixed), [['optout', mixed], ['tap', mixed, 1]]);
  assert.deepEqual(h.calls.filter((c) => c[1] === updates || c[1] === inactive), []);
  assert.equal(m.numbers[1].result.kept, 'updates'); assert.match(h.renderResultTags(m.numbers[1]), /Left alone/);
  assert.match(h.renderResultTags(m.numbers[0]), /only marketing opt-outs ran/);
  assert.deepEqual(h.calls.filter((c) => c[1] === s.numbers[0].id).map((c) => c[0]), ['optout', 'text', 'report', 'block', 'archive']);
  assert.equal(h.calls.some((c) => c[0] === 'delete'), false);
  assert.deepEqual(Array.from(h.reportItems(), (i) => i.name), ['Spam']);
});
test('no STOP for a sender that also sends updates unless it offers a promotions-only button', async () => {
  const h = harness(); h.gate(true); h.state.actions = { optout: true, stop: true };
  const m = group('Bank'); m.numbers[0].cls = 'mixed';
  h.buttons[m.numbers[0].id] = [{ index: 0, quickReplyButton: { displayText: 'Unsubscribe' } }];
  h.state.groups = [m]; await h.run();
  assert.deepEqual(h.calls.map((c) => c[0]), ['optout']);
  assert.equal(m.numbers[0].result.stop, 'skipped'); assert.match(h.renderResultTags(m.numbers[0]), /promotions-only/);
});
test('people saved in your contacts are never pre-ticked, and one promotional word is not an ad', () => {
  const h = harness(); const now = Math.floor(Date.now() / 1000);
  const row = (id, name, extra) => ({ id, name, kind: 'biz', isApi: false, verified: false, category: 'guess', inWindow: true, ts: now, msgs: 1, ...extra });
  const groups = h.groupRows([row('1@c.us', 'Mom', { saved: true }), row('2@c.us', 'Shop', {})]);
  assert.equal(groups.find((g) => g.name === 'Mom').checked, false);
  assert.equal(groups.find((g) => g.name === 'Shop').checked, true);
  assert.notEqual(h.msgCategory({ id: { fromMe: false }, type: 'chat', body: 'Happy birthday! Sending you a small gift' }), 'promo-guess');
});
test('saved contacts and unofficial accounts never go to the public Wall', async () => {
  const h = harness(); const a = group('Aunty'); a.saved = true; const b = group('Local Shop'); b.verified = false; const c = group('Brand');
  h.state.groups = [a, b, c]; await h.run();
  assert.deepEqual(Array.from(h.reportItems(), (i) => i.name), ['Brand']);
  assert.equal(h.reportItems()[0].is_api, true);
});
test('reports stop at the daily limit while other actions still run', async () => {
  const h = harness(); const a = group('A'); h.state.groups = [a]; h.state.actions = { report: true, block: true };
  h.state.history.reportDay = new Date().toISOString().slice(0, 10); h.state.history.reportCount = 50;
  await h.run();
  assert.equal(a.numbers[0].result.report, 'skipped'); assert.equal(a.numbers[0].result.block, true);
  assert.equal(h.calls.some((c) => c[0] === 'report'), false);
});
test('history from an older version can never switch on delete, and nothing is saved before history loads', () => {
  const h = harness(); h.state.historyLoaded = false; h.state.groups = [];
  h.saveHistory(); assert.equal(h.messages.filter((m) => m.type === 'save').length, 0);
  h.send('history', { actions: { block: true, del: true }, ignored: { kept: { name: 'Kept' } }, onboarded: true, runs: [], seen: {} });
  assert.equal('del' in h.state.actions, false);
  const saves = h.messages.filter((m) => m.type === 'save');
  assert.equal(saves.length, 1); assert.equal('del' in saves[0].payload.actions, false); assert.ok(saves[0].payload.ignored.kept);
});
test('the page-visible handle is off by default and can never start a run', () => {
  const h = harness();
  assert.deepEqual(Object.keys(h.sandbox.window.__bouncer), ['version']);
  h.sandbox.window.localStorage = { getItem: (k) => (k === 'dearcustomer.debug' ? '1' : null) };
  assert.ok(h.sandbox.window.__bouncer.state); assert.equal(h.sandbox.window.__bouncer.run, undefined);
});
