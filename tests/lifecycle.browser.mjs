import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

test('duplicate script keeps the active SDK and draft; destroy allows a clean reload',async t=>{
 const server=createServer((req,res)=>{
  if(['/widget.js','/widget.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('.js')?'text/javascript':'text/css');res.end(readFileSync(req.url.endsWith('.js')?'dist/widget.js':'widget/widget.css'));return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p>TEST isolated SDK lifecycle</p><script src="/widget.js" data-project-key="TEST-lifecycle-key"></script>');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByRole('button',{name:'Сообщить о баге',exact:true}).click();await page.getByRole('button',{name:'Продолжить без снимка',exact:true}).click();await page.locator('.report-fields textarea').fill('TEST draft must survive a repeated script');
 await page.evaluate(()=>window.savedInstance=window.BugReportKit.instance);
 const reload=()=>page.evaluate(()=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/widget.js';script.dataset.projectKey='TEST-lifecycle-key';script.onload=resolve;script.onerror=reject;document.body.append(script);}));
 await reload();assert.equal(await page.locator('[data-bug-report-kit]').count(),1);assert.equal(await page.evaluate(()=>window.savedInstance===window.BugReportKit.instance),true);assert.equal(await page.locator('.report-fields textarea').inputValue(),'TEST draft must survive a repeated script');
 await page.evaluate(()=>{window.savedInstance.destroy();window.savedInstance.destroy();});assert.equal(await page.locator('[data-bug-report-kit]').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.BugReportKit.instance)),false);
 await reload();await page.getByRole('button',{name:'Сообщить о баге',exact:true}).waitFor();assert.equal(await page.locator('[data-bug-report-kit]').count(),1);assert.equal(await page.locator('.report-card').count(),0);
});
