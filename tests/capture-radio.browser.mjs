import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';

test('capture preserves the centered dot of a selected custom radio', async t => {
  const bundle=await build({entryPoints:['widget/capture.js'],bundle:true,write:false,format:'iife',globalName:'captureTest'});
  const server=createServer((req,res)=>{
    if(req.url==='/capture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><style>
      body{margin:0;background:white}*{box-sizing:border-box}
      label{position:absolute;left:24px;top:24px;display:inline-block;width:16px;height:16px}
      input{position:absolute;inset:0;margin:0;opacity:0}
      .radio-inner{position:relative;display:block;width:16px;height:16px;border:1px solid #1677ff;border-radius:50%;background:#1677ff}
      .radio-inner::after{content:'';position:absolute;left:50%;top:50%;width:16px;height:16px;margin-top:-8px;margin-left:-8px;border-radius:50%;background:white;transform:scale(.375);transform-origin:50% 50%;transition:transform .2s,opacity .2s}
      .unselected{left:64px}.unselected .radio-inner{background:white;border-color:#ddd}.unselected .radio-inner::after{opacity:0;transform:scale(0)}
    </style><label><input type="radio" checked><span class="radio-inner"></span></label><label class="unselected"><input type="radio"><span class="radio-inner"></span></label><script src="/capture.js"></script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:200,height:100},deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const original=await page.screenshot();
  const result=await page.evaluate(async native=>{
    const html=document.body.innerHTML;
    const capture=await captureTest.captureViewport();
    const image=new Image();image.src='data:image/png;base64,'+native;await image.decode();
    const expected=document.createElement('canvas');expected.width=200;expected.height=100;expected.getContext('2d').drawImage(image,0,0);
    const differences=[24,64].map(x=>{
      const a=expected.getContext('2d').getImageData(x,24,16,16).data,b=capture.getContext('2d').getImageData(x,24,16,16).data;
      let difference=0;for(let i=0;i<a.length;i+=4)difference+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
      return difference/(16*16*3*255);
    });
    return {differences,center:[...capture.getContext('2d').getImageData(32,32,1,1).data],unchanged:html===document.body.innerHTML};
  },original.toString('base64'));
  assert.equal(result.unchanged,true);
  assert.ok(result.center.slice(0,3).every(v=>v>240),`selected radio center is not white: ${result.center}`);
  assert.ok(result.differences[0]<.035,`selected radio pixel difference ${result.differences[0]}`);
  assert.ok(result.differences[1]<.025,`unselected radio pixel difference ${result.differences[1]}`);
});
