import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {html2canvasPatches} from '../scripts/html2canvas-patches.mjs';
import {chromium} from 'playwright';

test('idle WebGL, modern colors and SVG controls survive capture; widget releases keyboard', async t => {
  const bundle = await build({plugins:[html2canvasPatches()],entryPoints:['widget/capture.js'],bundle:true,write:false,format:'iife',globalName:'captureTest'});
  const fixture = await readFile(new URL('./fixtures/capture-drawing.html',import.meta.url),'utf8');
  const server = createServer(async(req,res) => {
    if(req.url === '/capture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
    if(req.url === '/widget.js' || req.url === '/widget.css'){
      res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');
      res.end(await readFile(new URL(req.url.endsWith('.css')?'../widget/widget.css':'../dist/widget.js',import.meta.url)));return;
    }
    res.setHeader('Content-Type','text/html;charset=utf-8');
    res.end(fixture.replaceAll('http://127.0.0.1:17338',`http://127.0.0.1:${server.address().port}`));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:2});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForTimeout(100); // Let the initial WebGL drawing buffer be discarded.
  await page.getByRole('button',{name:'Проверить снимок',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('webglPixel'));
  const result=JSON.parse(await page.locator('#result').textContent());
  assert.equal(result.renderedBeforeRead,true);
  assert.deepEqual(result.webglPixel,[51,153,204,255]);
  assert.equal(result.liveDrawingUnchanged,true);
  // ForeignObject is rasterized by the SVG image path; the edit value must be visible.
  const svg=await page.locator('svg').boundingBox();
  const pixels=await page.evaluate(async ({svg})=>{
    const img=document.querySelector('#captured');await img.decode();
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;c.getContext('2d').drawImage(img,0,0);
    const scale=img.naturalWidth/innerWidth;
    const data=c.getContext('2d').getImageData((svg.x+140)*scale,(svg.y+105)*scale,75*scale,25*scale).data;
    let dark=0;for(let i=0;i<data.length;i+=4)if(data[i]<90&&data[i+1]<100&&data[i+2]<110)dark++;
    return dark;
  },{svg});
  assert.ok(pixels>60,'SVG edit value is readable');
  await page.getByRole('button',{name:'Проверить вход',exact:true}).click();
  await page.getByRole('button',{name:'Сообщить о баге',exact:true}).click();
  await page.getByRole('textbox',{name:'Имя или ник',exact:true}).press('Escape');
  assert.equal(await page.getByRole('textbox',{name:'Имя или ник',exact:true}).count(),0);
  // Keep the authentication request pending while a user starts drawing immediately.
  let releaseSession;
  const sessionReady=new Promise(resolve=>{releaseSession=resolve;});
  await page.route('**/api/reporter/me',async route=>{
    await sessionReady;
    await route.fulfill({json:{reporter:{id:'fixture',name:'Fixture'}}});
  });
  await page.getByRole('button',{name:'Медленная сессия',exact:true}).click();
  await page.getByRole('button',{name:'Сообщить о баге',exact:true}).click();
  await page.getByText('Подготавливаем снимок… · Esc — отмена',{exact:true}).waitFor();
  await page.mouse.move(80,220);await page.mouse.down();await page.mouse.move(300,350);await page.mouse.up();
  assert.equal(await page.locator('#drags').textContent(),'Перемещений: 0');
  await page.keyboard.press('Escape');releaseSession();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('[data-bug-report-kit-active]').count(),0);
  assert.equal(await page.getByText('Выделите проблемную область',{exact:true}).count(),0);
  await page.getByRole('button',{name:'Включить ловитель',exact:true}).click();
  await page.getByRole('button',{name:'Сообщить о баге',exact:true}).click();
  await page.getByText('Выделите проблемную область',{exact:true}).waitFor();
  await page.keyboard.press('F8');
  assert.equal(await page.locator('[data-bug-report-kit]').count(),0);
  const field=page.getByRole('textbox',{name:'Клавиатура после удаления',exact:true});
  await field.fill('123');await field.press('Backspace');assert.equal(await field.inputValue(),'12');
});
