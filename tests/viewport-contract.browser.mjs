import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

async function fixture(t) {
  const server=createServer((req,res)=>{
    if(req.url==='/widget.js'||req.url==='/widget.css') {
      res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');
      res.end(readFileSync(req.url.endsWith('.js')?'dist/widget.js':'widget/widget.css')); return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;height:1600px;background:white}.target{position:absolute;left:calc(100% - 140px);top:180px;width:100px;height:180px;background:rgb(40,150,80)}</style><div class="target"></div><canvas id="drawing" width="70" height="100" style="position:absolute;left:300px;top:500px;width:70px;height:100px"></canvas><script>document.getElementById("drawing").addEventListener("bug-report-kit:before-canvas-capture",event=>{const ctx=event.target.getContext("2d");ctx.fillStyle="rgb(40,150,80)";ctx.fillRect(0,0,70,100);});</script><script src="/widget.js" data-project-key="viewport-fixture" data-launcher-style="compact"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const page=await browser.newPage({viewport:{width:390,height:699},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  page.setDefaultTimeout(5000);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const open=async()=>{
    await page.getByRole('button',{name:'Сообщить о баге',exact:true}).click();
    await page.locator('.overlay:not(.is-preparing)').waitFor();
  };
  const draw=async(x,y,right,bottom)=>{
    await page.mouse.move(x,y);await page.mouse.down();
    await page.mouse.move(right,bottom,{steps:8});await page.mouse.up();
  };
  return {page,open,draw};
}

test('capture uses root layout dimensions when Safari owner inner dimensions disagree',async t=>{
  const {page,open,draw}=await fixture(t);
  // Only the owning Window is changed. The html2canvas clone iframe keeps its real metrics.
  await page.evaluate(()=>{
    Object.defineProperty(window,'innerWidth',{value:255,configurable:true});
    Object.defineProperty(window,'innerHeight',{value:456,configurable:true});
  });
  await open();
  const canvas=page.locator('.overlay canvas');
  const metrics=await canvas.evaluate(c=>{const r=c.getBoundingClientRect();return {rootWidth:document.documentElement.clientWidth,rootHeight:document.documentElement.clientHeight,width:Number(c.dataset.captureCssWidth),height:Number(c.dataset.captureCssHeight),displayWidth:r.width,displayHeight:r.height,styleWidth:c.style.width,styleHeight:c.style.height};});
  // The visible frozen canvas need not carry the capture dataset; its immutable CSS size is observable.
  assert.equal(metrics.rootWidth,390);assert.equal(metrics.rootHeight,699);
  assert.equal(metrics.styleWidth,'390px','frozen CSS width must be the captured layout width, not100%');
  assert.equal(metrics.styleHeight,'699px','frozen CSS height must be immutable capture pixels');
  assert.equal(metrics.displayWidth,390);assert.equal(metrics.displayHeight,699);
  const pixel=await canvas.evaluate(c=>{const r=c.getBoundingClientRect();return [...c.getContext('2d').getImageData(340*c.width/r.width,250*c.height/r.height,1,1).data];});
  assert.deepEqual(pixel,[40,150,80,255],'responsive clone layout and displayed scene must match the live target');
  const drawingPixel=await canvas.evaluate(c=>{const r=c.getBoundingClientRect();return [...c.getContext('2d').getImageData(330*c.width/r.width,550*c.height/r.height,1,1).data];});
  assert.deepEqual(drawingPixel,[40,150,80,255],'drawing beyond reported inner bounds must flush its actual frame into the frozen capture');
  await draw(320,220,348,300);
  const frame=await page.locator('.box').evaluate(el=>el.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(frame.x-320)<1&&Math.abs(frame.width-28)<1,'frame must use layout coordinates beyond misreported innerWidth255');
  await page.getByRole('button',{name:'Подтвердить выделение',exact:true}).click();
  const preview=page.locator('img.preview');await preview.waitFor();
  const cropped=await preview.evaluate(async img=>{await img.decode();const c=document.createElement('canvas');c.width=c.height=1;const x=c.getContext('2d');x.drawImage(img,img.naturalWidth/2,img.naturalHeight/2,1,1,0,0,1,1);return [...x.getImageData(0,0,1,1).data];});
  assert.ok(Math.abs(cropped[0]-40)<=3&&Math.abs(cropped[1]-150)<=3&&Math.abs(cropped[2]-80)<=3,`wrong crop: ${cropped}`);
});

test('toolbar height change preserves frozen pixels and immutable crop bounds; width change cancels',async t=>{
  const {page,open,draw}=await fixture(t);
  await open();
  const canvas=page.locator('.overlay canvas');
  const before=await canvas.evaluate(c=>({width:c.width,height:c.height,rect:c.getBoundingClientRect().toJSON()}));
  await draw(50,500,200,650);
  await page.setViewportSize({width:390,height:799});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.locator('.overlay:not(.is-preparing)').count(),1,'height-only browser chrome transition must preserve selection');
  const after=await canvas.evaluate(c=>({width:c.width,height:c.height,rect:c.getBoundingClientRect().toJSON()}));
  assert.equal(after.width,before.width);assert.equal(after.height,before.height);
  assert.equal(after.rect.width,before.rect.width);assert.equal(after.rect.height,before.rect.height,'height transition must not stretch the bitmap');
  await page.getByRole('button',{name:'Снять выделение',exact:true}).click();
  await draw(50,600,200,780);
  const frame=await page.locator('.box').evaluate(el=>el.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(frame.y-600)<1&&Math.abs(frame.height-99)<1,`crop must clamp to original699px image: ${JSON.stringify(frame)}`);
  await page.setViewportSize({width:400,height:799});
  await page.locator('.overlay').waitFor({state:'detached'});
  assert.equal(await page.getByRole('button',{name:'Сообщить о баге',exact:true}).isVisible(),true);
});

test('Safari fixed-layer client offset keeps image, frame and crop in one coordinate space',async t=>{
  const {page,open,draw}=await fixture(t);
  // Model the measured native Safari layer offset without controlling the Simulator.
  await page.locator('[data-bug-report-kit]').evaluate(host=>{
    const style=document.createElement('style');style.textContent='.overlay{top:-120px}';
    host.shadowRoot.append(style);
  });
  await open();
  const canvas=page.locator('.overlay canvas');
  const first=await canvas.evaluate(c=>c.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(first.x)<.1&&Math.abs(first.y)<.1,`frozen image must start at client0: ${JSON.stringify(first)}`);
  const colorAt=async(x,y)=>canvas.evaluate((c,p)=>{
    const r=c.getBoundingClientRect();
    return [...c.getContext('2d').getImageData((p.x-r.left)*c.width/r.width,(p.y-r.top)*c.height/r.height,1,1).data];
  },{x,y});
  assert.deepEqual(await colorAt(300,250),[40,150,80,255]);
  const assertFrame=async expected=>{
    const rect=await page.locator('.box').evaluate(el=>el.getBoundingClientRect().toJSON());
    for(const [key,value] of Object.entries(expected))assert.ok(Math.abs(rect[key]-value)<1,`frame ${key}: ${rect[key]} != ${value}`);
  };
  await draw(260,220,335,300);
  await assertFrame({x:260,y:220,width:75,height:80});
  // Safari can move the fixed layer again while preserving the same frozen image.
  await page.locator('.overlay:not(.is-preparing)').evaluate(el=>el.style.top='-140px');
  const moved=await canvas.evaluate(c=>c.getBoundingClientRect().toJSON());
  assert.ok(Math.abs(moved.y+20)<.1,'fixture must actually move the layer after opening');
  await page.getByRole('button',{name:'Снять выделение',exact:true}).click();
  await draw(260,200,335,290);
  await assertFrame({x:260,y:200,width:75,height:90});
  assert.deepEqual(await colorAt(300,250),[40,150,80,255]);
  await page.getByRole('button',{name:'Подтвердить выделение',exact:true}).click();
  const preview=page.locator('img.preview');await preview.waitFor();
  const cropped=await preview.evaluate(async img=>{
    await img.decode();const c=document.createElement('canvas');c.width=c.height=1;
    const ctx=c.getContext('2d');ctx.drawImage(img,img.naturalWidth/2,img.naturalHeight/2,1,1,0,0,1,1);
    return [...ctx.getImageData(0,0,1,1).data];
  });
  assert.ok(Math.abs(cropped[0]-40)<=3&&Math.abs(cropped[1]-150)<=3&&Math.abs(cropped[2]-80)<=3,`shifted-layer crop must match the selected green scene: ${cropped}`);
});
