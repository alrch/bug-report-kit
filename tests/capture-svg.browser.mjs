import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {html2canvasPatches} from '../scripts/html2canvas-patches.mjs';

test('SVG CSS border paints once with margin, padding and both box-sizing modes',async t=>{
 const bundle=await build({plugins:[html2canvasPatches()],entryPoints:['widget/capture.js'],bundle:true,write:false,format:'iife',globalName:'captureTest'});
 const fixture=await readFile(new URL('./fixtures/capture-svg.html',import.meta.url));
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/capture.js'?'text/javascript':'text/html;charset=utf-8');res.end(req.url==='/capture.js'?bundle.outputFiles[0].text:fixture);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 for(const deviceScaleFactor of [1,2]){
  const page=await browser.newPage({viewport:{width:1100,height:600},deviceScaleFactor});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'Проверить SVG',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#result').textContent.includes('magentaBorderSegments'));
  const result=JSON.parse(await page.locator('#result').textContent());
  assert.equal(result.passed,true,JSON.stringify(result));assert.equal(result.liveDomUnchanged,true);
  await page.close();
 }
});
