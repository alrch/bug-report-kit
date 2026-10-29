import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';

test('work and personal Kit instances reject each other and keep independent persistent reports', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kit-isolation-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist/client.mjs'), 'export const fixture = true;');
  writeFileSync(join(root, 'dist/client.d.mts'), 'export declare const fixture: boolean;');
  async function start(id) {
    const config = {projects:[{id,name:id,widgetKey:id+'-public',allowedOrigins:['https://'+id+'.example.test']}],
      teamTokens:[{name:'TEST developer',role:'developer',token:id+'-private-test',projects:[id]}]};
    const app = createApp(config,{rootDir:root,database:join(root,id+'.sqlite')});
    await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
    let closed = false;
    const stop = async () => {if(closed)return;closed=true;app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.db.close();};
    t.after(stop);
    return {base:`http://127.0.0.1:${app.server.address().port}`,stop};
  }
  let work = await start('work'); const personal = await start('personal');
  const auth = id => ({Authorization:'Bearer '+id+'-private-test'});
  const report = async (instance,id) => {
    const response = await fetch(instance.base+'/api/reports',{method:'POST',headers:{Origin:'https://'+id+'.example.test','X-Project-Key':id+'-public','Content-Type':'application/json'},body:JSON.stringify({description:'TEST isolated '+id,pageUrl:'https://'+id+'.example.test/page'})});
    assert.equal(response.status,201);return (await response.json()).id;
  };
  const workId = await report(work,'work'), personalId = await report(personal,'personal');
  for(const [instance,own,foreign,id] of [[work,'work','personal',personalId],[personal,'personal','work',workId]]) {
    const list = await (await fetch(instance.base+'/api/reports',{headers:auth(own)})).json();
    assert.equal(list.length,1);assert.equal(list[0].projectId,own);
    assert.ok([401,403].includes((await fetch(instance.base+'/api/reports',{headers:auth(foreign)})).status));
    assert.equal((await fetch(instance.base+'/api/reports/'+id,{headers:auth(own)})).status,404);
    const rejected = await fetch(instance.base+'/api/reports',{method:'POST',headers:{Origin:'https://'+foreign+'.example.test','X-Project-Key':foreign+'-public','Content-Type':'application/json'},body:JSON.stringify({description:'TEST must reject',pageUrl:'https://'+foreign+'.example.test/'})});
    assert.ok([401,403].includes(rejected.status));
  }
  for(const path of ['/client.mjs','/client.d.mts']) {
    const response = await fetch(work.base+path);assert.equal(response.status,200);assert.ok((await response.text()).length>0);
  }
  await work.stop();
  assert.equal((await fetch(personal.base+'/healthz')).status,200);
  work = await start('work');
  assert.equal((await (await fetch(work.base+'/api/reports',{headers:auth('work')})).json())[0].id,workId);
  assert.equal((await (await fetch(personal.base+'/api/reports',{headers:auth('personal')})).json())[0].id,personalId);
});
