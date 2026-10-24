import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { fixture, root } from './helpers.mjs';

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
test('H03: existing malicious content and all dynamic HTML sinks are inert in a real browser', async () => {
  const f = await fixture({ start: false }); let browser;
  try {
    const payload = '<img src="data:image/png;base64,AA==" onerror="globalThis.__securityXss=1">';
    f.store.data.a.content = [{ id: 123, title: 'Legacy '+payload, type: 'Publicación', channel: 'Instagram', status: 'pending', date: '2026-10-24', caption: 'Caption '+payload, icon: payload }];
    f.store.data.a.properties[0].title = 'Property '+payload;
    await writeFile(join(f.dir, 'store.json'), JSON.stringify(f.store)); await f.launch();
    const cookie = await f.login();
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext(); await context.addCookies([{ name: 'ruano_session', value: cookie.slice(cookie.indexOf('=')+1), url: f.origin, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(f.origin+'/') ? route.continue() : route.abort());
    await page.goto(f.origin); await page.waitForFunction(() => serverReady && content.some(x=>x.id===123));
    await page.evaluate(() => { showView('content'); renderCalendar(); renderBrands(); runSearch(); toggleNotifPanel(); });
    assert.equal(await page.evaluate(() => globalThis.__securityXss), undefined);
    assert.ok((await page.locator('#contentGrid').textContent()).includes('Legacy <img'));
    // Cover payloads that do not pass through content.icon, including dangerous URLs and SVG.
    await page.evaluate(() => {
      const box=document.createElement('div'); box.id='security-probe'; document.body.append(box);
      setHTML(box,'<img src="data:image/png;base64,AA==" onerror="globalThis.__securityXss=2"><svg onload="globalThis.__securityXss=3"></svg><a href="javascript:globalThis.__securityXss=4">link</a>');
    });
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => globalThis.__securityXss), undefined);
    assert.equal(await page.locator('#security-probe [onerror], #security-probe [onload], #security-probe a[href^="javascript:"]').count(), 0);
    const a = await f.login();
    await f.sync(a, { data: { a: { content: { upsert: [{ id: 124, type: 'Publicación', channel: 'Instagram', status: 'pending', title: 'Safe', icon: payload }] } } } });
    const saved = await (await f.request('/api/sync',a)).json(); assert.equal(saved.data.a.content.find(x=>x.id===124).icon, '⌂');
    await page.evaluate(()=>openReport('a'));
    const popupReady=page.waitForEvent('popup'); await page.locator('#reportOpen').click();
    const report=await popupReady; await report.waitForLoadState();
    assert.ok((await report.locator('body').textContent()).includes('Legacy <img'));
    assert.equal(await report.locator('[onerror], [onclick], a[href^="javascript:"]').count(),0);
    assert.ok(await report.locator('style').count());
    await report.close();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.close(); }
});

test('frontend still uploads, reloads and edits photos with explicit brand URLs', async () => {
  const f = await fixture(); let browser;
  try {
    const cookie = await f.login(); browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext(); await context.addCookies([{ name: 'ruano_session', value: cookie.slice(cookie.indexOf('=')+1), url: f.origin }]);
    const page = await context.newPage(), errors = []; page.on('pageerror', e=>errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(f.origin+'/') ? route.continue() : route.abort());
    await page.goto(f.origin); await page.waitForFunction(()=>serverReady && getProperties().some(p=>p.id===101));
    await page.evaluate(()=>openPhotos(101));
    await page.locator('#photoInput').setInputFiles(join(root,'tests/fixtures/photo.jpg'));
    await page.waitForFunction(()=>photoState.images.length===1 && !!photoState.images[0].serverId);
    assert.ok((await page.locator('#photoGallery img').first().getAttribute('src'))?.startsWith('blob:'),'Gallery preserves local blob previews');
    const saved = page.waitForResponse(r=>r.url().includes('/api/photos/101?brand=a') && r.request().method()==='PUT');
    await page.evaluate(()=>{const input=document.querySelector('#brightness');input.value='7';input.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal((await saved).status(),200);
    assert.equal((await (await f.request('/api/photos/101?brand=a',cookie)).json()).photos[0].adjust.brightness,7);
    await page.reload(); await page.waitForFunction(()=>serverReady);
    await page.evaluate(()=>openPhotos(101)); await page.waitForFunction(()=>photoState.images.length===1);
    assert.equal(await page.evaluate(()=>photoState.adjustments[0].brightness),7);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.close(); }
});

test('browser logout rejects a copied cookie; independent B session survives a server restart',async()=>{
 const f=await fixture();let browser;
 try{
  const a=await f.login(),b=await f.login('testb');browser=await chromium.launch({executablePath,headless:true});
  const contextA=await browser.newContext(),contextB=await browser.newContext();
  for(const [context,cookie] of [[contextA,a],[contextB,b]])await context.addCookies([{name:'ruano_session',value:cookie.slice(cookie.indexOf('=')+1),url:f.origin,httpOnly:true}]);
  const pageA=await contextA.newPage(),pageB=await contextB.newPage();
  for(const p of [pageA,pageB])await p.route('**/*',r=>r.request().url().startsWith(f.origin+'/')?r.continue():r.abort());
  await pageA.goto(f.origin+'/logout');assert.equal(new URL(pageA.url()).pathname,'/login');
  await contextA.addCookies([{name:'ruano_session',value:a.slice(a.indexOf('=')+1),url:f.origin,httpOnly:true}]);
  await pageA.goto(f.origin);assert.equal(new URL(pageA.url()).pathname,'/login');
  await f.stop();await f.launch();
  await pageA.goto(f.origin);assert.equal(new URL(pageA.url()).pathname,'/login');
  await pageB.goto(f.origin);await pageB.waitForFunction(()=>serverReady);assert.equal(await pageB.evaluate(()=>fetch('/api/me').then(r=>r.status)),200);
 }finally{await browser?.close();await f.close()}
});
