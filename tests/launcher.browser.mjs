import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

test('compact launcher avoids controls after CSS load, mutations, resize and scroll', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/widget.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync('dist/widget.js')); return; }
    if (req.url === '/widget.css') {
      res.setHeader('Content-Type', 'text/css');
      setTimeout(() => res.end(readFileSync('widget/widget.css')), 200);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width"><style>body{margin:0;height:2400px}#save{position:fixed;right:20px;top:16px;width:120px;height:40px}</style><button id="save">Сохранить</button><script src="/widget.js" data-project-key="${req.url === '/other' ? 'other' : 'test'}" data-launcher-style="compact"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({headless:true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport:{width:800,height:600}});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const launcher = page.locator('.launcher');
  const settled = async () => {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return launcher.boundingBox();
  };
  const check = async () => {
    const bug = await settled();
    const control = await page.locator('#save').boundingBox();
    assert.equal(bug.width,40); assert.equal(bug.height,40);
    assert.equal(bug.y,16);
    assert.ok(bug.x + bug.width <= control.x - 10, 'bug moves left of the control with a gap');
    const viewport=page.viewportSize();
    assert.ok(bug.x>=0 && bug.x+40<=viewport.width && bug.y+40<=viewport.height);
  };
  await check();
  assert.equal(await launcher.textContent(),'');
  assert.equal(await launcher.getAttribute('aria-label'),'Сообщить о баге');
  await page.setViewportSize({width:375,height:667});
  await check();
  await page.evaluate(() => scrollTo(0,500));
  await check();
  await page.locator('#save').evaluate(el=>el.style.width='200px');
  await check();
  await page.locator('#save').evaluate(el=>el.remove());
  const returned=await settled();
  assert.equal(returned.x,315); assert.equal(returned.y,16);
  await launcher.click();
  await page.locator('.overlay').waitFor({state:'visible'});
  await page.setViewportSize({width:390,height:667});
  await page.locator('.overlay').waitFor({state:'detached'});
  await launcher.waitFor({state:'visible'});
  await page.setViewportSize({width:375,height:667});
  await launcher.click();
  await page.locator('.overlay').waitFor({state:'visible'});
  await page.keyboard.press('Escape');
  await launcher.waitFor({state:'visible'});
  assert.equal((await settled()).x,315);
  const dragTo = async (x,y) => {
    const box=await launcher.boundingBox();
    await page.mouse.move(box.x+20,box.y+20);
    await page.mouse.down();
    await page.mouse.move(x,y,{steps:8});
    await page.mouse.up();
    await settled();
  };
  await dragTo(30,630);
  assert.equal(await page.locator('.overlay').count(),0,'drag must not open report');
  let pinned=await settled();
  assert.equal(pinned.x,20); assert.equal(pinned.y,611);
  await page.evaluate(()=>{
    const button=document.createElement('button');
    button.style.cssText='position:fixed;left:20px;bottom:16px;width:80px;height:40px';
    document.body.append(button);
  });
  assert.equal((await settled()).x,20,'manual placement overrides collision avoidance');
  await page.reload();
  pinned=await settled();
  assert.equal(pinned.x,20); assert.equal(pinned.y,611,'corner survives reload');
  await page.setViewportSize({width:800,height:600});
  pinned=await settled();
  assert.equal(pinned.x,20); assert.equal(pinned.y,544);
  await page.goto(new URL('/other',page.url()).href);
  assert.ok((await settled()).x>20,'another project does not inherit the corner');
  await page.goto(new URL('/',page.url()).href);
  assert.equal((await settled()).x,20);
  await launcher.click();
  await page.locator('.overlay').waitFor({state:'visible'});
  await page.keyboard.press('Escape');

});
