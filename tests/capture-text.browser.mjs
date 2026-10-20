import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {chromium} from 'playwright';

test('capture keeps ellipsis and placeholder appearance without changing the live page', async t => {
  const bundle = await build({entryPoints:['widget/capture.js'], bundle:true, write:false, format:'iife', globalName:'captureTest'});
  const server = createServer((req,res) => {
    if (req.url === '/capture.js') {res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.end(`<!doctype html><style>
      body{margin:0;background:white;font:16px Arial}
      p{position:absolute;left:20px;top:20px;margin:0;width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:24px}
      input{position:absolute;left:20px;top:64px;width:260px;height:32px;box-sizing:border-box;border:1px solid #ccc;padding:4px 8px;font:16px Arial;color:#111;background:white}
      textarea{position:absolute;left:20px;top:110px;width:260px;height:50px;padding:4px 8px;box-sizing:border-box;font:16px Arial;color:#111;background:white;border:1px solid #ccc}\n      input::placeholder,textarea::placeholder{color:rgba(0,0,0,.25);opacity:1}
    </style><p>ТЕСТ AUDIT 20261016 MAIN C Г-образная</p><input placeholder="Поиск по папкам и проектам"><textarea placeholder="Прикрепите эскиз…"></textarea><script src="/capture.js"></script>`);
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve=>server.close(resolve)));
  const browser = await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page = await browser.newPage({viewport:{width:400,height:240},deviceScaleFactor:1});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const before = await page.screenshot();
  const result = await page.evaluate(async native => {
    const original = document.body.innerHTML;
    const captured = await captureTest.captureViewport();
    const image = new Image(); image.src = 'data:image/png;base64,' + native;
    await image.decode();
    const expected = document.createElement('canvas');expected.width=400;expected.height=240;
    expected.getContext('2d').drawImage(image,0,0);
    const regions = [[205,20,35,24],[20,64,260,32],[20,110,260,50]];
    const differences = regions.map(([x,y,w,h]) => {
      // Browser and canvas glyph rasterizers can differ by one baseline pixel.
      return Math.min(...[-1,0,1].map(dy => {
        const a=expected.getContext('2d').getImageData(x,y+dy,w,h).data;
        const b=captured.getContext('2d').getImageData(x,y,w,h).data;
        let difference=0;
        for(let i=0;i<a.length;i+=4) difference+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);
        return difference/(w*h*3*255);
      }));
    });
    return {differences,unchanged:original===document.body.innerHTML};
  },before.toString('base64'));
  assert.equal(result.unchanged,true,'capture must not mutate the live page');
  assert.ok(result.differences[0]<.025,`title pixel difference ${result.differences[0]}`);
  assert.ok(result.differences[1]<.02,`placeholder pixel difference ${result.differences[1]}`);
  assert.ok(result.differences[2]<.02,`textarea placeholder pixel difference ${result.differences[2]}`);
});
