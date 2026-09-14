const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function harness() {
  let clock = Date.now();
  class Clock extends Date { static now() { return clock; } }
  const calls = [], messages = [], cardText = [], opened = [];
  const ctx = new Proxy({}, { get: (_, key) => key === 'measureText' ? () => ({ width: 100 }) : key === 'fillText' ? (text, x, y) => cardText.push({ text, x, y }) : () => {} });
  const WPP = { isInjected: true, isReady: true, isFullReady: true, conn: { isAuthenticated: () => true },
    blocklist: { blockContact: async (id) => calls.push(['block', id]) },
    chat: { archive: async (id) => calls.push(['archive', id]), delete: async (id) => calls.push(['delete', id]) } };
  const sandbox = { window: { WPP, addEventListener() {}, postMessage: (m) => messages.push(m), innerWidth: 1400, open: (...args) => opened.push(args) },
    document: { createElement: () => ({ getContext: () => ctx }) }, console: { log() {} },
    Date: Clock, URLSearchParams, setTimeout: (fn, ms) => setTimeout(() => { clock += ms; fn(); }, ms >= 6000 ? 25 : 0), clearTimeout };
  let source = fs.readFileSync(path.join(__dirname, '../src/engine.js'), 'utf8');
  // Exercise production handlers and runner, replacing only browser rendering/boot.
  source = source.replace('function render(full = false) {', 'function render() {}\nfunction renderOriginal(full = false) {');
  source = source.replace('  boot();', `root = { contains: () => true }; panel = { style: {left:'0px'}, querySelector: () => null }; window.testAPI = { state, run, onClick, outcome, selectedGroups, renderList, renderDone, renderResultTags, reportItems, drawCard, shareText, postToX, groupRows };`);
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const api = sandbox.window.testAPI;
  api.state.scanned = true; api.state.onboarded = true;
  api.state.history = { seen: {}, runs: [], ignored: {}, bounced: {} };
  api.state.actions = { block: true };
  return { ...api, WPP, calls, messages, cardText, opened,
    click: (act, key, v) => api.onClick({ target: { closest: () => ({ dataset: { act, key, v } }) } }) };
}
function group(name, count = 1) {
  const nums = Array.from({ length: count }, (_, i) => ({ id: `${name}-${i}@c.us`, hash: `${name}-${i}-hash`, phone: '919999999999', ts: Math.floor(Date.now()/1000), inWindow: true, msgs: 1, category: 'promo' }));
  return { key: name, name, kind: 'biz', promo: true, category: 'promo', checked: true, active: nums, numbers: nums, msgs: count, blockedCount: 0 };
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
test('unavailable opt-out remains visible on later numbers', async () => {
  const h=harness(); const a=group('A',2); h.state.groups=[a]; h.state.actions={optout:true,block:true}; await h.run();
  assert.equal(a.numbers[1].result.optout,'skipped'); assert.equal(h.outcome(a).key,'partial');
  assert.match(h.renderResultTags(a.numbers[1]),/Skipped/); assert.match(h.renderResultTags(a.numbers[1]),/unavailable/);
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
