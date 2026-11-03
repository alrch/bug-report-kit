import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';

test('shared gateway and existing PIN panel coexist without exposing report data', async t => {
  const directory=mkdtempSync(join(tmpdir(),'kit-panel-compat-'));
  const gateway={mountPath:'/projects/greta/bugs/',signInPath:'/projects/open/greta',logoutPath:'/projects/logout',preserveLegacy:true};
  const config={projects:[{id:'site',widgetKey:'fixture',reporterAuth:true,panelAccess:true}],
    reporterAuthSecret:'synthetic-fixture-secret-at-least-32-characters',teamTokens:[{token:'fixture-team',projects:['site']}],panelGateway:gateway};
  const app=createApp(config,{database:join(directory,'reports.sqlite')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));app.db.close();rmSync(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port;
  const legacy=await (await fetch(base+'/')).text();
  assert.match(legacy,/id="login-pin"/);
  assert.doesNotMatch(legacy,/data-panel-mount=/);
  for(const path of ['/projects/greta/bugs/','/projects/greta/bugs/reports/11111111-1111-4111-8111-111111111111']){
    const html=await (await fetch(base+path)).text();
    assert.match(html,/data-panel-mount="\/projects\/greta\/bugs\/"/);
    assert.doesNotMatch(html,/id="login-pin"/);
    assert.doesNotMatch(html,/fixture-team/);
  }
  assert.equal((await fetch(base+'/projects/greta/bugs/dashboard.js')).status,200);
  assert.equal((await fetch(base+'/api/reports')).status,401);
  assert.equal((await fetch(base+'/api/reports',{headers:{'X-Panel-Gateway':'true'}})).status,401);
  assert.throws(()=>createApp({...config,panelGateway:{...gateway,preserveLegacy:'true'}},{database:join(directory,'bad.sqlite')}),/panelGateway/);
  assert.throws(()=>createApp({...config,teamTokens:[config.teamTokens[0],{...config.teamTokens[0],projects:['other']}]},{database:join(directory,'bad.sqlite')}),/Duplicate team token/);
});
