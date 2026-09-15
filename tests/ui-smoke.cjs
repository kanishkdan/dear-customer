// Offline UI check. Install playwright-core and point CHROMIUM_PATH at a Chromium executable.
const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.join(__dirname, '../dist/qa');
const ROOT = path.join(__dirname, '..');
fs.mkdirSync(OUT, { recursive: true });

async function seed(page) {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#0b141a;color:#8696a0;font:15px system-ui}#pane-side{position:fixed;left:64px;top:0;width:400px;height:100vh;background:#111b21;border-right:1px solid #26353d}.demo{position:fixed;right:28px;bottom:24px;font-size:12px;letter-spacing:.12em;text-transform:uppercase}.context{margin-left:464px;display:grid;place-content:center;height:100vh;text-align:center}.context b{color:#e9edef;font-size:24px;font-weight:500}.context p{max-width:300px;line-height:1.7}</style><div id="pane-side"></div><div class="context"><b>Your inbox, on your terms.</b><p>Review the senders. Choose what happens next.</p></div><div class="demo">Demo data · No real chats</div>`);
  await page.evaluate(() => {
    const now = Math.floor(Date.now() / 1000);
    window.testCalls = []; window.testLinks = []; window.testReports = [];
    window.open = (...args) => { window.testLinks.push(args); return null; };
    window.fixtureMode = 'success'; window.releaseAction = null;
    const records = [
      ['Zorblax Pet Foods', 3, 'Weekend deal: 40% off on pet food. Shop now.'],
      ['Quikcash Loans', 2, 'Pre-approved loan offer. Apply now for instant approval.'],
      ['Style Circle', 1, 'Flash sale: extra 20% off your next order. Shop now.'],
      ['Trail Club', 1, 'Exclusive offer. Save 30% this weekend.'],
      ['Green Basket', 1, 'Your order has been delivered. Thank you.'],
    ];
    const chats = new Map(); let index=0;
    for (const [name, count, body] of records) for (let i=0;i<count;i++) {
      const id = `919000000${String(index++).padStart(3,'0')}@c.us`;
      const msg = {id:{_serialized:id+'-msg',fromMe:false},type:'chat',body,t:now-3600*(i+1)};
      chats.set(id,{ id:{_serialized:id},t:msg.t,formattedTitle:name,contact:{isBusiness:true,isEnterprise:true,isMyContact:false,pushname:name},msgs:{toArray:()=>[msg]} });
    }
    const action = async (key,id) => {
      window.testCalls.push([key,id]);
      if (key==='block' && window.fixtureMode==='hold') await new Promise((resolve)=>{window.releaseAction=resolve;});
      if (window.fixtureMode==='failure' || (window.fixtureMode==='partial' && key==='archive')) throw new Error('This action is unavailable in the test session.');
      return {};
    };
    window.WPP={isInjected:true,isReady:true,isFullReady:true,conn:{isAuthenticated:()=>true},
      chat:{list:async()=>[...chats.values()],get:async(id)=>chats.get(id),getMessages:async()=>[],archive:(id)=>action('archive',id),delete:(id)=>action('delete',id),sendTextMessage:(id)=>action('stop',id),openChatBottom:async(id)=>window.testCalls.push(['open',id])},
      contact:{get:async(id)=>chats.get(id).contact,getPnLidEntry:async()=>null},
      blocklist:{isBlocked:async()=>false,blockContact:(id)=>action('block',id),unblockContact:(id)=>action('unblock',id)},
      whatsapp:{functions:{reportSpam:async(chat)=>{await action('report',chat.id._serialized);return {reportIdMixin:{reportId:'demo'}}}}}};
    // Everything including storage and community calls stays inside this page.
    let saved = {seen:{},runs:[],ignored:{}};
    addEventListener('message',(event)=>{
      const m=event.data;if(!m?.__bouncer || m.dir!=='to-ext')return;
      const reply=(type,payload)=>postMessage({__bouncer:true,dir:'to-page',type,payload},'*');
      if(m.type==='ready') reply('history',saved);
      if(m.type==='save') saved=m.payload;
      if(m.type==='community') reply('community',{ok:true,url:'https://dearcustomer.kanishkdan.com',data:{businesses:[],hashes:{},totals:{}}});
      if(m.type==='report'){window.testReports.push(m.payload);reply('reported',{ok:true,accepted:m.payload.length,url:'https://dearcustomer.kanishkdan.com'});}
    });
  });
  // The debug handle the checks read is off unless this flag is set.
  await page.evaluate(()=>Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:(k)=>k==='dearcustomer.debug'?'1':null,setItem(){},removeItem(){}}}));
  await page.addScriptTag({path:path.join(ROOT,'src/keywords.js')});
  await page.addScriptTag({path:path.join(ROOT,'src/engine.js')});
  await page.evaluate(()=>postMessage({__bouncer:true,dir:'to-page',type:'open'},'*'));
  await page.waitForFunction(()=>window.__bouncer.state.scanned && !window.__bouncer.state.scanning);
}
const button = (page, act) => page.locator(`#bouncer-root [data-act="${act}"]`);
const row = (page,key)=>page.locator(`[data-row-key="${key}"]`);
const screenshot = (page,name)=>page.screenshot({path:path.join(OUT, name+'.png')});
(async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1280,height:800},reducedMotion:'reduce',acceptDownloads:true});
  const requests=[], errors=[];
  await context.route('**/*',r=>{requests.push(r.request().url());return r.abort();});
  const page=await context.newPage(); page.on('pageerror',e=>errors.push(e.message));
  try {
    await seed(page); await screenshot(page,'01-setup');
    // 1.0.3: no delete choice, and the debug handle can't start a run.
    const setupText=await page.locator('#bouncer-root').innerText();
    for (const t of ['Opt out','Report','Block','Archive']) assert.match(setupText,new RegExp(t));
    assert.doesNotMatch(setupText,/Delete/);
    assert.equal(await page.evaluate(()=>typeof window.__bouncer.run),'undefined');
    // The Wall choice is on by default and lives on the setup screen. Switch it off here so the manual button below gets exercised.
    const wallOpt=page.locator('#bouncer-root .bz-wall-opt .bz-check');
    assert.equal(await wallOpt.isChecked(),true);
    await wallOpt.click();
    assert.equal(await page.locator('#bouncer-root .bz-wall-opt .bz-check').isChecked(),false);
    assert.equal(await page.evaluate(()=>window.__bouncer.state.history.autoReport),false);
    await button(page,'setup-done').click(); await screenshot(page,'02-list');
    await row(page,'zorblax pet foods').locator('[data-act="expand-row"]').click();
    assert.equal(await page.evaluate(()=>window.__bouncer.state.expanded),false);
    assert.equal(await row(page,'zorblax pet foods').locator('.bz-num').count(),3);
    await row(page,'zorblax pet foods').locator('[data-act="expand-row"]').click();
    await row(page,'zorblax pet foods').locator('[data-act="ignore"]').click();
    await button(page,'all').click();
    assert.equal(await page.evaluate(()=>window.__bouncer.state.groups.find(g=>g.key==='zorblax pet foods').checked),false);
    await button(page,'undo-ignore').click();
    assert.equal(await row(page,'zorblax pet foods').count(),1);
    while(await button(page,'ignore').count()) await button(page,'ignore').first().click();
    assert.equal(await page.locator('.bz-row').count(),0);
    await button(page,'show-ignored').click(); await screenshot(page,'03-restore');
    await button(page,'restore-ignored').click();
    assert.equal(await page.locator('.bz-check:checked').count(),0);
    await button(page,'all').click();
    await page.evaluate(()=>{window.__bouncer.state.actions={block:true,archive:true};window.fixtureMode='hold';});
    await button(page,'run').click();
    await page.waitForFunction(()=>!!window.releaseAction);
    await row(page,'zorblax pet foods').locator('[data-act="expand-row"]').click();
    await screenshot(page,'04-running');
    // Updates retain row/Stop-button identity and preserve a deliberate scroll position.
    await page.evaluate(()=>{
      window.savedRow=document.querySelector('[data-row-key="zorblax pet foods"]');
      window.savedStop=document.querySelector('[data-act="cancel"]');
      const body=document.querySelector('.bz-body');body.scrollTop=140;window.savedScroll=body.scrollTop;
      window.fixtureMode='success';window.releaseAction();
    });
    await page.waitForFunction(()=>window.testCalls.some(c=>c[0]==='archive'));
    assert.equal(await page.evaluate(()=>window.savedRow===document.querySelector('[data-row-key="zorblax pet foods"]')),true);
    assert.equal(await page.evaluate(()=>window.savedStop===document.querySelector('[data-act="cancel"]')),true);
    assert.equal(await page.evaluate(()=>document.querySelector('.bz-body').scrollTop===window.savedScroll),true);
    await page.waitForFunction(()=>!!window.__bouncer.state.results);
    assert.equal(await page.locator('.bz-body').evaluate(el=>el.scrollTop),0);
    assert.equal(await page.locator('.bz-stamp').innerText(),'BOUNCED');
    await screenshot(page,'05-results');
    assert.equal(await button(page,'copy').count(),0); assert.equal(await button(page,'ignore-sel').count(),0);
    await button(page,'post-x').click();
    const link=await page.evaluate(()=>window.testLinks[0][0]);assert.match(link,/^https:\/\/x.com\/intent\/tweet\?/);
    assert.equal(new URL(link).searchParams.get('url'),'https://dearcustomer.kanishkdan.com');
    const downloadPromise=page.waitForEvent('download');await button(page,'card').click();const download=await downloadPromise;
    await download.saveAs(path.join(OUT,'share-card.png'));
    assert.match(download.suggestedFilename(),/^dear-customer-/);
    if(await row(page,'zorblax pet foods').locator('[data-act="expand-row"]').getAttribute('aria-expanded') !== 'true') await row(page,'zorblax pet foods').locator('[data-act="expand-row"]').click();
    await row(page,'zorblax pet foods').locator('[data-act="unblock"]').first().click();
    assert.match(await row(page,'zorblax pet foods').innerText(),/Undone/);
    await button(page,'report').click();await page.waitForFunction(()=>window.__bouncer.state.reportStatus?.ok);
    assert.equal(await page.evaluate(()=>window.testReports.length),1);
    // Partial and failed results, independent of the successful run's receipt.
    await button(page,'back').click();await page.waitForFunction(()=>!window.__bouncer.state.scanning);
    await page.evaluate(()=>{window.fixtureMode='partial';window.__bouncer.state.actions={block:true,archive:true};});
    await button(page,'run').click();await page.waitForFunction(()=>!!window.__bouncer.state.results);
    assert.equal(await page.locator('.bz-stamp').innerText(),'PARTLY DONE');
    await row(page,'zorblax pet foods').locator('[data-act="expand-row"]').click();
    await screenshot(page,'06-partial');
    assert.match(await row(page,'zorblax pet foods').innerText(),/unavailable in the test session/);
    await button(page,'back').click();await page.waitForFunction(()=>!window.__bouncer.state.scanning);
    await page.evaluate(()=>{window.fixtureMode='failure';});
    await button(page,'run').click();await page.waitForFunction(()=>!!window.__bouncer.state.results);
    assert.equal(await page.locator('.bz-stamp').innerText(),'NOT COMPLETED');
    assert.equal(await button(page,'post-x').count(),0);await screenshot(page,'07-failed');
    // Stop mid-number, with no archive started after the current block returns.
    await button(page,'back').click();await page.waitForFunction(()=>!window.__bouncer.state.scanning);
    await page.evaluate(()=>{window.fixtureMode='hold';window.releaseAction=null;window.testCalls=[];});
    await button(page,'run').click();await page.waitForFunction(()=>!!window.releaseAction);
    await page.setViewportSize({width:800,height:600});
    await button(page,'expand').first().click();
    assert.equal(await page.evaluate(()=>window.__bouncer.state.view),'chart');
    assert.equal(await button(page,'cancel').isVisible(),true);
    await button(page,'cancel').click();
    await page.evaluate(()=>{window.fixtureMode='success';window.releaseAction();});
    await page.waitForFunction(()=>!!window.__bouncer.state.results);
    assert.equal(await page.evaluate(()=>window.__bouncer.state.results.numbersDone),1);
    assert.equal(await page.evaluate(()=>window.testCalls.length),1);
    assert.equal(await page.evaluate(()=>window.__bouncer.state.view),'list');
    await page.setViewportSize({width:1280,height:800});
    await screenshot(page,'08-stopped');
    await page.setViewportSize({width:800,height:600});
    await button(page,'expand').first().click();assert.equal(await page.evaluate(()=>window.__bouncer.state.view),'chart');
    await button(page,'chart-close').click();
    assert.equal(await page.locator('.bz-panel').evaluate(el=>el.getBoundingClientRect().right<=innerWidth),true);
    await screenshot(page,'09-compact');
    assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);
    console.log(JSON.stringify({ok:true,checks:['setup','no delete','debug handle has no run','Wall choice in setup','restore all','ignore selection guard','row expansion','stable progress DOM','stable scroll','results reset scroll','X draft','PNG download','unblock','Wall payload','partial','failure','cancel','compact'],screenshots:OUT,networkRequests:requests.length,pageErrors:errors.length},null,2));
  } catch(e){console.error('page errors so far:',JSON.stringify(errors,null,1));throw e;} finally {await context.close();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
