import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sanitizeReportUrl} from '../shared/report-url.mjs';
import {createApp} from '../server/app.mjs';
const id = '4926e66c-6bd1-4a10-9b36-1a45e146a8cb';
test('report URL retains only an unambiguous UUID project identifier', () => {
  assert.equal(sanitizeReportUrl(`https://site.test/plan?project_id=${id}&token=private&search=customer`), `https://site.test/plan?project_id=${id}`);
  assert.equal(sanitizeReportUrl(`https://site.test/plan?project_id=${id}&project_id=${id}`), 'https://site.test/plan');
  assert.equal(sanitizeReportUrl('https://site.test/plan?project_id=secret'), 'https://site.test/plan');
});
test('report URL removes credentials and secret fragments', () => {
  assert.equal(sanitizeReportUrl('https://user:pass@site.test/plan?password=secret#access_token=private'), 'https://site.test/plan');
  assert.equal(sanitizeReportUrl('https://site.test/#/plan?token=secret'), 'https://site.test/#/plan');
});
test('server persists safe project URL for screenshot and report consumers', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bug-kit-url-'));
  const app = createApp({projects:[{id:'qa', name:'QA', widgetKey:'fixture-widget', allowedOrigins:['http://localhost:15178']}], teamTokens:[{name:'QA',role:'developer',token:'fixture-team',projects:['qa']}]}, {rootDir:dir,database:join(dir,'qa.sqlite')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();rmSync(dir,{recursive:true,force:true});});
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = await fetch(`${base}/api/reports`, {method:'POST',headers:{Origin:'http://localhost:15178','X-Project-Key':'fixture-widget','Content-Type':'application/json'},body:JSON.stringify({description:'TEST safe project URL',pageUrl:`http://localhost:15178/plan?project_id=${id}&token=private`,appVersion:'capture-fix-qa'})});
  assert.equal(post.status,201);
  const created = await post.json();
  const response = await fetch(`${base}/api/reports/${created.id}`, {headers:{Authorization:'Bearer fixture-team'}});
  assert.equal(response.status,200);
  const report = await response.json();
  assert.equal(report.pageUrl,`http://localhost:15178/plan?project_id=${id}`);
  assert.equal(report.appVersion,'capture-fix-qa');
});
