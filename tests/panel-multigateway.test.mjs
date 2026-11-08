import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.mjs';

const one = {mountPath:'/projects/one/bugs/', signInPath:'/projects/open/one', logoutPath:'/projects/logout', preserveLegacy:true};
const two = {mountPath:'/projects/two/bugs/', signInPath:'/projects/open/two', logoutPath:'/projects/logout', preserveLegacy:true};
const fixture = {projects:[{id:'one',widgetKey:'one'},{id:'two',widgetKey:'two'}], teamTokens:[{token:'fixture',projects:['one']}]};

test('several project panels share one runtime while the original PIN page remains', async t => {
  const dir=mkdtempSync(join(tmpdir(),'kit-multigateway-'));
  const app=createApp({...fixture,panelGateways:[one,two]},{database:join(dir,'reports.sqlite')});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve)); app.db.close(); rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port;
  const legacy=await (await fetch(base+'/')).text();
  assert.match(legacy,/id="login-pin"/);
  assert.doesNotMatch(legacy,/data-panel-mount=/);
  for(const gateway of [one,two]){
    const html=await (await fetch(base+gateway.mountPath)).text();
    assert.ok(html.includes('data-panel-mount="'+gateway.mountPath+'"'));
    assert.ok(html.includes('href="'+gateway.signInPath+'"'));
    assert.equal((await fetch(base+gateway.mountPath+'dashboard.js')).status,200);
    assert.equal((await fetch(base+gateway.mountPath+'reports/11111111-1111-4111-8111-111111111111')).status,200);
  }
  assert.equal((await fetch(base+'/api/reports')).status,401);
});

test('overlapping routes and ambiguous or unsafe gateway modes fail before startup', () => {
  const dir=mkdtempSync(join(tmpdir(),'kit-multigateway-invalid-'));
  try {
    for(const config of [
      {panelGateways:[]},
      {panelGateways:[one,one]},
      {panelGateways:[one,{...two,mountPath:one.mountPath+'child/'}]},
      {panelGateways:[one,{...two,preserveLegacy:false}]},
      {panelGateways:[one,{...two,mountPath:'/api/bugs/'}]},
      {panelGateways:[one,{...two,signInPath:two.mountPath+'login'}]},
      {panelGateways:[one,{...two,signInPath:one.mountPath.slice(0,-1)}]},
      {panelGateways:[one],panelGateway:one},
      {panelGateways:[null]},
    ]) {
      assert.throws(()=>createApp({...fixture,...config},{database:join(dir,'bad.sqlite')}),/panelGateway/);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
