import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.mjs';

test('one service preserves distinct project PIN secrets and existing sessions after data import', async t => {
  const root=mkdtempSync(join(tmpdir(),'kit-tenant-auth-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const origin='http://localhost:7338';
  const projects=['alpha','beta'].map(id=>({id,widgetKey:id+'-key',allowedOrigins:[origin],reporterAuth:true,panelAccess:true}));
  const secrets=['synthetic-alpha-secret-at-least-32-characters','synthetic-beta-secret-at-least-32-characters'];
  const actors=[{token:'test-team-token',projects:['alpha','beta']}];
  async function start(config,database){const app=createApp(config,{rootDir:root,database});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));return {app,url:'http://127.0.0.1:'+app.server.address().port};}
  async function stop(app){await new Promise(r=>app.server.close(r));app.db.close();}
  async function post(url,project,path,data,token){return fetch(url+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Project-Key':project.widgetKey,...(token?{'X-Reporter-Token':token}:{})},body:JSON.stringify(data)});}
  const tokens=[], reports=[];
  for(let i=0;i<2;i++){
    const {app,url}=await start({projects:[projects[i]],teamTokens:actors,reporterAuthSecret:secrets[i]},`./${i}.sqlite`);
    const response=await post(url,projects[i],'/api/reporter/register',{name:'Same name',pin:'1234'});
    assert.equal(response.status,201);tokens.push((await response.json()).token);
    const created=await post(url,projects[i],'/api/reports',{description:'Synthetic report',pageUrl:origin+'/page',
      screenshot:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',
      attachment:{name:'fixture.txt',data:'data:text/plain;base64,aGVsbG8='}},tokens[i]);
    assert.equal(created.status,201);reports.push((await created.json()).id);await stop(app);
  }
  const combined={projects:projects.map((p,i)=>({...p,reporterAuthSecret:secrets[i]})),teamTokens:actors};
  const init=createApp(combined,{rootDir:root,database:'./template.sqlite'});init.db.close();
  execFileSync('python3',[join(import.meta.dirname,'../scripts/combine-snapshots.py'),'--template',join(root,'template.sqlite'),
    '--target',join(root,'combined.sqlite'),'--source','alpha',join(root,'0.sqlite'),'--source','beta',join(root,'1.sqlite')]);
  const {app,url}=await start(combined,'./combined.sqlite');
  try {
    const exposed = await (await fetch(url+'/api/projects',{headers:{Authorization:'Bearer test-team-token'}})).text();
    const panelProjects = await (await fetch(url+'/api/panel/projects')).text();
    for(const secret of secrets){assert.ok(!exposed.includes(secret));assert.ok(!panelProjects.includes(secret));}
    for(let i=0;i<2;i++){
      assert.equal((await post(url,projects[i],'/api/reporter/login',{name:'Same name',pin:'1234'})).status,200);
      assert.equal((await post(url,projects[i],'/api/reporter/me',{},tokens[i])).status,200);
      assert.equal((await post(url,projects[1-i],'/api/reporter/me',{},tokens[i])).status,401);
      assert.equal((await fetch(url+'/api/reports/'+reports[i],{headers:{Authorization:'Bearer '+tokens[i]}})).status,200);
      assert.equal((await fetch(url+'/api/reports/'+reports[1-i],{headers:{Authorization:'Bearer '+tokens[i]}})).status,403);
      const attachment=await fetch(url+'/api/reports/'+reports[i]+'/attachment',{headers:{Authorization:'Bearer '+tokens[i]}});
      assert.equal(attachment.status,200);assert.equal(await attachment.text(),'hello');
    }
  } finally {await stop(app);}
  assert.throws(()=>createApp({...combined,projects:[{...combined.projects[0],reporterAuthSecret:''}]},{rootDir:root,database:'./invalid.sqlite'}),/reporterAuthSecret/);
  assert.throws(()=>createApp({...combined,projects:[combined.projects[0],combined.projects[0]]},{rootDir:root,database:'./duplicate.sqlite'}),/Duplicate project/);
  assert.throws(()=>createApp({...combined,projects:[combined.projects[0],{...combined.projects[1],widgetKey:combined.projects[0].widgetKey}]},{rootDir:root,database:'./duplicate.sqlite'}),/Duplicate project/);
});
