import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';

test('capture preserves textarea wrapping, newlines and scroll without live mutations', async t => {
  const bundle = await build({entryPoints:['widget/capture.js'],bundle:true,write:false,format:'iife',globalName:'captureTest'});
  const server=createServer((req,res)=>{
    if(req.url==='/capture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><style>body{margin:0;background:white}textarea{position:absolute;left:20px;top:20px;width:270px;height:76px;box-sizing:border-box;padding:6px 8px;font:14px/22px Arial;color:#111;border:1px solid #ccc;border-radius:5px;resize:none}</style><textarea>Проверка снимка: утеплитель 100 мм, без сохранения.
Вторая строка
Третья строка
Четвёртая строка</textarea><script src="/capture.js"></script>`);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r)); t.after(()=>new Promise(r=>server.close(r)));
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:320,height:140},deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  for(const scroll of [0,30]){
    await page.locator('textarea').evaluate((el,y)=>{el.scrollTop=y;},scroll);
    const native=(await page.screenshot()).toString('base64');
    const result=await page.evaluate(async native=>{
      const el=document.querySelector('textarea'); const before=[el.outerHTML,el.value,el.scrollTop];
      const capture=await captureTest.captureViewport();
      const img=new Image();img.src='data:image/png;base64,'+native;await img.decode();
      const expected=document.createElement('canvas');expected.width=320;expected.height=140;expected.getContext('2d').drawImage(img,0,0);
      const diff=Math.min(...[-1,0,1].map(dy=>{
        const a=expected.getContext('2d').getImageData(28,28+dy,240,56).data;
        const b=capture.getContext('2d').getImageData(28,28,240,56).data;let sum=0;
        for(let i=0;i<a.length;i+=4)sum+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
        return sum/(240*56*3*255);
      }));
      return {diff,unchanged:JSON.stringify(before)===JSON.stringify([el.outerHTML,el.value,el.scrollTop])};
    },native);
    assert.ok(result.diff<.025,`scroll ${scroll}: pixel difference ${result.diff}`);
    assert.equal(result.unchanged,true);
  }
});
