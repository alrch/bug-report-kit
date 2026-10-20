import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {html2canvasPatches} from '../scripts/html2canvas-patches.mjs';
import {chromium} from 'playwright';

test('soft rounded shadows preserve the surface and scale at DPR 1 and 2', async t=>{
 const bundle=await build({plugins:[html2canvasPatches()],entryPoints:['widget/capture.js'],bundle:true,write:false,format:'iife',globalName:'captureTest'});
 const server=createServer((req,res)=>{if(req.url==='/capture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}res.setHeader('Content-Type','text/html');res.end(`<!doctype html><style>body{margin:0;background:white}.surface{position:absolute;left:50%;transform:translateX(-50%);top:80px;width:346px;height:68px;background:white;border:1px solid #d8d8db;border-radius:29px;box-shadow:0 12px 38px rgba(0,0,0,.13),0 1px 3px rgba(0,0,0,.06)}</style><div class=surface></div><div class=surface style="transform:none;left:22px;top:190px;box-shadow:inset 0 3px 12px 2px rgba(0,0,0,.2)"></div><div class=surface style="top:300px;border-radius:0;box-shadow:-5px 8px 12px 3px rgba(0,0,0,.2)"></div><script src=/capture.js></script>`);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const dpr of [1,2]){
 const page=await browser.newPage({viewport:{width:390,height:430},deviceScaleFactor:dpr});await page.goto(`http://127.0.0.1:${server.address().port}`);
 const native=(await page.screenshot()).toString('base64');
 const result=await page.evaluate(async ({native,dpr})=>{const captured=await captureTest.captureViewport();const img=new Image();img.src='data:image/png;base64,'+native;await img.decode();const expected=document.createElement('canvas');expected.width=img.width;expected.height=img.height;expected.getContext('2d').drawImage(img,0,0);const a=expected.getContext('2d').getImageData(0,0,img.width,img.height).data,b=captured.getContext('2d').getImageData(0,0,img.width,img.height).data;let diff=0;for(let i=0;i<a.length;i+=4)diff+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]);return {diff:diff/(img.width*img.height*3*255),center:[...captured.getContext('2d').getImageData(195*dpr,110*dpr,1,1).data]};},{native,dpr});

 assert.ok(result.center.slice(0,3).every(v=>v>250),`DPR ${dpr} center ${result.center}`);
 assert.ok(result.diff<.006,`DPR ${dpr} shadow pixel difference ${result.diff}`);await page.close();
 }
});
