import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, existsSync, realpathSync, mkdirSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateConfig, readConfig} from '../runtime/deploy/config.mjs';
import {deploy} from '../runtime/deploy/installer.mjs';
import {createStandaloneAdapter} from '../runtime/deploy/docker.mjs';
import {createHash} from 'node:crypto';
const A = `sha256:${'a'.repeat(64)}`, B = `sha256:${'b'.repeat(64)}`;
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kit-installer-unit-'));
  const configRef = join(root, 'config.json'); writeFileSync(configRef, '{"private":"PRIVATE_SENTINEL"}', {mode:0o600});
  const data = join(root, 'data'); mkdirSync(data, {mode:0o700});
  const spec = {schema:1,profile:'docker-server',instance:'unit',artifact:{image:A},stateDirectory:join(root,'state'),configRef,
    data:{type:'bind',source:data},runtime:{uid:1000,gid:1000,port:7337},proxy:{healthUrl:'http://127.0.0.1:7337/healthz'}};
  return {root,spec};
}
test('strict data schema rejects commands, mutable images, voice/native profiles and path aliases', () => {
  const {root,spec}=fixture();try {
    assert.equal(validateConfig(spec),spec);
    for(const patch of [{command:['sh','-c','whoami']},{artifact:{image:'kit:latest'}},{profile:'macos'},{runtime:{...spec.runtime,command:'x'}},{stateDirectory:spec.data.source}])
      assert.throws(()=>validateConfig({...spec,...patch}));
    const path=join(root,'spec.json');writeFileSync(path,JSON.stringify(spec),{mode:0o600});assert.equal(readConfig(path).instance,'unit');
    symlinkSync(path,join(root,'alias.json'));assert.throws(()=>readConfig(join(root,'alias.json')));
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('plan has no persistent writes; exact existing image adoption is idempotent',async()=>{
  const {root,spec}=fixture();let activates=0,verifies=0;
  const current={id:'c'.repeat(64),imageId:A,imageRef:A};
  const docker={run:async args=>{assert.deepEqual(args.slice(0,3),['image','inspect','--format']);return A}};
  const adapter={identity:'fixture-v1',inspect:async()=>current,activate:async()=>{activates++},verify:async()=>{verifies++}};
  try {
    const plan=await deploy('plan',spec,{docker,adapter});assert.equal(plan.change,false);assert.equal(existsSync(spec.stateDirectory),false);
    assert.equal((await deploy('install',spec,{docker,adapter})).changed,false);
    const receipt=readFileSync(join(spec.stateDirectory,'receipt.json'));
    assert.equal((await deploy('update',spec,{docker,adapter})).changed,false);
    assert.deepEqual(readFileSync(join(spec.stateDirectory,'receipt.json')),receipt);
    assert.equal((await deploy('install',spec,{docker,adapter})).changed,false);assert.equal(activates,0);assert.equal(verifies,3);
    const changedDocker={run:async()=>B};await assert.rejects(deploy('install',{...spec,artifact:{image:B}},{docker:changedDocker,adapter}),/INVALID_TRANSITION/);
    writeFileSync(spec.configRef,'{"private":"changed"}',{mode:0o600});
    await assert.rejects(deploy('update',spec,{docker,adapter}),/STATE_BINDING_CHANGED/);assert.equal(activates,0);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('interrupted operation requires recover; recovery restores binary with original frozen guard',async()=>{
 const {root,spec}=fixture();let current={id:'c'.repeat(64),imageId:A,imageRef:A,guard:{neighbors:{edge:'original'}}};
 const docker={run:async()=>A};let received;
 const adapter={identity:'fixture-v1',inspect:async()=>current,verify:async()=>{},activate:async args=>{received=args;current={...current,imageId:args.image,imageRef:args.image}}};
 try{
  await deploy('install',spec,{docker,adapter});
  const receipt=JSON.parse(readFileSync(join(spec.stateDirectory,'receipt.json')));
  const transaction={schema:1,binding:receipt.binding,configHash:receipt.configHash,baseline:receipt.current,before:receipt,target:B,phase:'activating'};
  writeFileSync(join(spec.stateDirectory,'transaction.json'),JSON.stringify(transaction),{mode:0o600});
  current={id:'d'.repeat(64),imageId:B,imageRef:B,guard:{neighbors:{edge:'later'}}};
  await assert.rejects(deploy('update',spec,{docker,adapter}),/RECOVERY_REQUIRED/);
  const result=await deploy('recover',spec,{docker,adapter});assert.equal(result.recovered,true);
  assert.equal(received.rollback,true);assert.deepEqual(received.guard,transaction.baseline.guard);assert.equal(received.image,A);
  assert.equal(existsSync(join(spec.stateDirectory,'transaction.json')),false);
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('active lock rejects a competing mutation without touching receipt',async()=>{
 const {root,spec}=fixture();try{
  mkdirSync(spec.stateDirectory,{mode:0o700});mkdirSync(join(spec.stateDirectory,'lock'),{mode:0o700});
  writeFileSync(join(spec.stateDirectory,'lock/owner.json'),JSON.stringify({pid:process.pid,token:'owner'}),{mode:0o600});
  const adapter={identity:'fixture-v1',inspect:async()=>null,activate:async()=>assert.fail('must not activate'),verify:async()=>{}};
  for(const action of ['install','recover'])await assert.rejects(deploy(action,spec,{docker:{},adapter}),/LOCKED/);
  assert.equal(existsSync(join(spec.stateDirectory,'receipt.json')),false);
 }finally{rmSync(root,{recursive:true,force:true})}
});
test('CLI never echoes malformed private JSON or adapter exceptions',()=>{
 const {root,spec}=fixture();try{
  const invalid=join(root,'invalid.json');writeFileSync(invalid,'{"secret":"PRIVATE_SENTINEL', {mode:0o600});
  const result=spawnSync(process.execPath,['scripts/deploy.mjs','plan',invalid],{encoding:'utf8'});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.deepEqual(JSON.parse(result.stderr),{ok:false,code:'DEPLOYMENT_FAILED'});
  assert.equal(result.stderr.includes('PRIVATE_SENTINEL'),false);
  const valid=join(root,'spec.json'),module=join(root,'adapter.mjs');writeFileSync(valid,JSON.stringify(spec),{mode:0o600});
  writeFileSync(module,"export function createAdapter(){throw Error('PRIVATE_SENTINEL')}");
  const adapterResult=spawnSync(process.execPath,['scripts/deploy.mjs','plan',valid,'--adapter',module],{encoding:'utf8'});
  assert.equal(adapterResult.status,1);assert.deepEqual(JSON.parse(adapterResult.stderr),{ok:false,code:'DEPLOYMENT_FAILED'});assert.equal(adapterResult.stderr.includes('PRIVATE_SENTINEL'),false);
 }finally{rmSync(root,{recursive:true,force:true})}
});

test('standalone ownership binds the one instance to its state/config/data/runtime',async()=>{
 const {root,spec}=fixture();try{
  const binding=createHash('sha256').update(JSON.stringify([spec.instance,spec.stateDirectory,spec.configRef,spec.data.type,spec.data.source,spec.runtime.uid,spec.runtime.gid,spec.runtime.port])).digest('hex');
  const labels={'org.bug-report-kit.installer':spec.instance,'org.bug-report-kit.installer.binding':binding};
  const mounts=[{Destination:'/app/config.local.json',Source:spec.configRef,RW:false},{Destination:'/app/data',Source:spec.data.source,RW:true}];
  const docker={run:async args=>args[0]==='ps'?'c'.repeat(64):[JSON.stringify('c'.repeat(64)),JSON.stringify(A),JSON.stringify(labels),JSON.stringify(mounts)].join('|')};
  assert.equal((await createStandaloneAdapter({spec,docker}).inspect()).imageId,A);
  await assert.rejects(createStandaloneAdapter({spec:{...spec,stateDirectory:join(root,'other-state')},docker}).inspect(),/FOREIGN_RESOURCE/);
 }finally{rmSync(root,{recursive:true,force:true})}
});
