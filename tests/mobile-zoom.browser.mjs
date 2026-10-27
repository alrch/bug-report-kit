import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

test('pinch zoom and pan preserve launcher size, frozen scene and touch crop coordinates', async t => {
  const server = createServer((req,res) => {
    if (req.url === '/widget.js' || req.url === '/widget.css') {
      res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');
      res.end(readFileSync(req.url.endsWith('.js')?'dist/widget.js':'widget/widget.css')); return;
    }
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;height:2600px;background:white}.target{position:absolute;left:170px;top:800px;width:150px;height:240px;background:rgb(40,150,80)}</style><div class="target"><p style="margin:10px 4px;font:18px/1.4 sans-serif;color:#000">Чёткий текст<br>Шаги бага 123</p></div><script src="/widget.js" data-project-key="test" data-launcher-style="compact" data-reporter-auth="${req.url.includes('auth')?'true':'false'}"></script>`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const browser=await chromium.launch({headless:true}); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:3});
  page.setDefaultTimeout(6000);
  const cdp=await page.context().newCDPSession(page);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const launcher=page.locator('.launcher'); await launcher.waitFor();
  const settled=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const view=()=>page.evaluate(()=>({x:scrollX,y:scrollY,left:visualViewport.offsetLeft,top:visualViewport.offsetTop,width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}));
  await page.evaluate(()=>scrollTo(0,650));
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});
  await cdp.send('Input.synthesizeScrollGesture',{x:150,y:220,xDistance:-100,yDistance:-120,speed:500,gestureSourceType:'touch'});
  await settled();
  const before=await view(); assert.equal(before.scale,2); assert.ok(before.left>20 && before.top>20,'real visual viewport pan required');
  const physical=await launcher.evaluate(el=>({width:el.getBoundingClientRect().width*visualViewport.scale,height:el.getBoundingClientRect().height*visualViewport.scale}));
  assert.ok(Math.abs(physical.width-40)<.1 && Math.abs(physical.height-40)<.1,`launcher grew: ${JSON.stringify(physical)}`);
  const touch=async(type,x,y)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'?[]:[{x,y,id:1}]});
  const tap=async locator=>{const p=await locator.evaluate(el=>{const r=el.getBoundingClientRect(),v=visualViewport;return {x:r.left+r.width/2-v.offsetLeft,y:r.top+r.height/2-v.offsetTop};});await touch('touchStart',p.x,p.y);await touch('touchEnd');};
  const button=await launcher.evaluate(el=>{const r=el.getBoundingClientRect(),v=visualViewport;return {x:r.left+r.width/2-v.offsetLeft,y:r.top+r.height/2-v.offsetTop};});
  await touch('touchStart',button.x,button.y);await touch('touchEnd');
  await page.locator('.overlay:not(.is-preparing)').waitFor(); await settled();
  assert.deepEqual(await view(),before,'opening the widget must preserve zoom and pan');
  const resolution=await page.locator('.overlay canvas').evaluate(c=>({width:c.width,height:c.height,cssWidth:parseFloat(c.style.width),cssHeight:parseFloat(c.style.height),density:devicePixelRatio*visualViewport.scale}));
  assert.ok(Math.abs(resolution.width/resolution.cssWidth-resolution.density)<.01,'frozen text must retain the physical density of the zoomed page');
  assert.ok(resolution.width*resolution.height<=16000000&&resolution.width<=8192&&resolution.height<=8192,'capture allocation stays bounded');

  const target=await page.locator('.target').evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
  const point={x:target.x+55,y:target.y+70};
  const pixel=await page.locator('.overlay canvas').evaluate((canvas,p)=>{const s=canvas.width/innerWidth;return [...canvas.getContext('2d').getImageData(Math.round(p.x*s),Math.round(p.y*s),1,1).data];},point);
  assert.deepEqual(pixel,[40,150,80,255],`frozen scene shifted: ${pixel}`);
  // CDP touch coordinates use visual-viewport CSS pixels; events report layout client coords.
  const a={x:Math.max(target.x+25,before.left+25),y:Math.max(target.y+30,before.top+70)};
  const b={x:Math.min(a.x+75,before.left+before.width-15),y:Math.min(a.y+90,before.top+before.height-70)};
  assert.ok(b.x-a.x>=24 && b.y-a.y>=24,`fixture must be visible: ${JSON.stringify({a,b,before,target})}`);
  const screen=p=>({x:p.x-before.left,y:p.y-before.top});
  await touch('touchStart',screen(a).x,screen(a).y);
  for(let i=1;i<=8;i++)await touch('touchMove',screen({x:a.x+(b.x-a.x)*i/8,y:a.y+(b.y-a.y)*i/8}).x,screen({x:a.x+(b.x-a.x)*i/8,y:a.y+(b.y-a.y)*i/8}).y);
  await touch('touchEnd');
  const rect=await page.locator('.box').evaluate(el=>el.getBoundingClientRect().toJSON());
  for(const [key,value] of Object.entries({x:a.x,y:a.y,width:b.x-a.x,height:b.y-a.y}))assert.ok(Math.abs(rect[key]-value)<1,`frame ${key}: ${rect[key]} != ${value}`);
  // Native two-finger pinch remains available even when both fingers start inside the frame.
  await cdp.send('Input.synthesizePinchGesture',{x:110,y:120,scaleFactor:.7,relativeSpeed:800,gestureSourceType:'touch'});
  await settled(); assert.ok((await view()).scale<before.scale,'selection must allow pinch zoom-out');
  assert.equal(await page.locator('.overlay:not(.is-preparing)').count(),1);
  const afterPinch=await page.locator('.box').evaluate(el=>el.getBoundingClientRect().toJSON());
  for(const key of ['x','y','width','height'])assert.ok(Math.abs(afterPinch[key]-rect[key])<1,'pinch cancels its provisional drag');
  // CDP touch uses the current visual viewport without locator auto-scroll.
  await tap(page.getByRole('button',{name:'Подтвердить выделение',exact:true}));
  const preview=page.locator('img.preview');await preview.waitFor();
  const crop=await preview.evaluate(img=>{const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(img,img.naturalWidth/2,img.naturalHeight/2,1,1,0,0,1,1);return [...x.getImageData(0,0,1,1).data];});
  assert.ok(Math.abs(crop[0]-40)<4 && Math.abs(crop[1]-150)<4 && Math.abs(crop[2]-80)<4,`wrong zoomed crop: ${crop}`);
  assert.ok(await page.locator('textarea').evaluateAll(els=>els.every(el=>parseFloat(getComputedStyle(el).fontSize)>=16)),'editable controls must not trigger iOS small-text focus zoom');
  const panelBounds=await page.locator('.report-card').evaluate(el=>el.getBoundingClientRect().toJSON());
  const formView=await view();
  assert.ok(panelBounds.left>=formView.left-.1 && panelBounds.right<=formView.left+formView.width+.1,'zoomed form must fit the visible screen');
  await page.locator('.report-card').evaluate(el=>el.scrollTop=el.scrollHeight);
  await tap(page.getByRole('button',{name:'Отмена',exact:true}));
  await settled(); assert.deepEqual(await view(),formView,'cancel keeps the inspected viewport');

  // Extreme zoom uses the pixel budget instead of allocating an unbounded bitmap.
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:4});await settled();
  await tap(launcher);await page.locator('.overlay:not(.is-preparing) canvas').waitFor();
  const capped=await page.locator('.overlay canvas').evaluate(c=>({width:c.width,height:c.height}));
  assert.ok(capped.width*capped.height<=16000000&&capped.width*capped.height>15500000,'extreme zoom must use but not exceed the capture budget');
  assert.ok(capped.width<=8192&&capped.height<=8192);
  await tap(page.getByRole('button',{name:'Отменить снимок',exact:true}));

  await page.goto(new URL('/?auth',page.url()).href);
  await page.evaluate(()=>scrollTo(0,650));
  await cdp.send('Emulation.setPageScaleFactor',{pageScaleFactor:2});
  await cdp.send('Input.synthesizeScrollGesture',{x:150,y:220,xDistance:-100,yDistance:-120,speed:500,gestureSourceType:'touch'});
  await settled(); const authView=await view();
  await tap(launcher);await page.locator('.auth-card').waitFor();
  assert.deepEqual(await view(),authView,'opening authentication must preserve the inspected viewport');
  assert.ok(await page.locator('.auth-card input').evaluateAll(els=>els.every(el=>parseFloat(getComputedStyle(el).fontSize)>=16)));
  const authBounds=await page.locator('.auth-card').evaluate(el=>el.getBoundingClientRect().toJSON());
  assert.ok(authBounds.left>=authView.left-.1 && authBounds.right<=authView.left+authView.width+.1,'zoomed authentication must remain visible');
  await page.getByPlaceholder('Имя или ник').fill('TEST zoom');
  await page.getByLabel('PIN из 4 цифр').fill('2468');
  // If layout scrolling occurs during authentication, a pending older capture must be refreshed.
  await page.route('**/api/reporter/login',async route=>{
    await page.evaluate(()=>scrollTo(0,710));
    await route.fulfill({json:{token:'test-session',reporter:{id:'test-reporter',name:'TEST zoom'}}});
  });
  await tap(page.getByRole('button',{name:'Войти',exact:true}));
  await page.locator('.overlay:not(.is-preparing)').waitFor();
  const current=await page.locator('.target').evaluate(el=>el.getBoundingClientRect().toJSON());
  const refreshed=await page.locator('.overlay canvas').evaluate((c,p)=>{const s=c.width/innerWidth;return [...c.getContext('2d').getImageData((p.x+55)*s,(p.y+70)*s,1,1).data];},current);
  assert.deepEqual(refreshed,[40,150,80,255],'authentication cannot reuse a capture from an earlier scroll origin');

});
