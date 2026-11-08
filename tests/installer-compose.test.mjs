import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createComposeAdapter} from '../runtime/deploy/compose.mjs';
const definition = {
  identity:'fixture-compose-v1',instance:'fixture',name:'fixture-bug-report-kit-1',edge:'fixture-edge-1',
  config:'/synthetic/config.json',override:'/synthetic/override.json',state:'/synthetic/state',
  base:'/synthetic/compose.json',env:'/synthetic/private.env',dataVolume:'fixture_bugreports',
  runtime:{uid:1000,gid:1000,port:7337},healthUrl:'https://fixture.invalid/healthz',
  checkpoint:'fixture-previous-override.json',compose:['compose','--project-name','fixture'],
};
const createFixtureAdapter=options=>createComposeAdapter({...options,definition});

const oldImage = `sha256:${'a'.repeat(64)}`;
const newImage = `sha256:${'b'.repeat(64)}`;
const id = '1'.repeat(64);
const edge = '2'.repeat(64);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kit-compose-adapter-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = {config: path.join(root,'config.json'), override: path.join(root,'override.json'), state: path.join(root,'state'),
    base:path.join(root,'compose.json'),env:path.join(root,'private.env')};
  const bytes = Buffer.from(`{ "services": { "bug-report-kit": { "image": "${oldImage}", "environment": {"KEEP":"synthetic","BUG_KIT_SPEECH_ENABLED":"0","BUG_KIT_SERVICE_STATE":"/tmp/bug-report-kit-service"} } } }\n`);
  await fs.writeFile(paths.config, '{"synthetic":true}', {mode:0o600});
  await fs.writeFile(paths.override, bytes, {mode:0o600});
  await fs.writeFile(paths.base,'{"syntheticCompose":true}',{mode:0o644});
  await fs.writeFile(paths.env,'SYNTHETIC=true\n',{mode:0o600});
  const spec = {instance:'fixture', stateDirectory:paths.state, configRef:paths.config,
    data:{type:'volume', source:'fixture_bugreports'}, runtime:{uid:1000,gid:1000,port:7337},
    proxy:{healthUrl:'https://fixture.invalid/healthz'}};
  const state = {image:oldImage, id, edge, calls:[], publicCalls:0, foreign:false, failedUp:false};
  const docker = {run:async args => {
    state.calls.push(args);
    if (args[0] === 'inspect') return JSON.stringify({id:state.id,imageId:state.image,imageRef:state.image,
      labels:{'com.docker.compose.project':state.foreign?'foreign':'fixture','com.docker.compose.service':'bug-report-kit'},
      mounts:[{Destination:'/app/config.local.json',Source:paths.config,Type:'bind',RW:false},
        {Destination:'/app/data',Source:'/synthetic/docker-volume',Type:'volume',Name:'fixture_bugreports',RW:true}]});
    if (args[0] === 'ps' && args.includes('--filter')) return state.id;
    if (args[0] === 'ps') return `${state.id?`fixture-bug-report-kit-1\t${state.id}\n`:''}fixture-edge-1\t${state.edge}\nforeign-bot\t${'3'.repeat(64)}\n`;
    if (args[0] === 'compose' && args.includes('up')) {
      if (state.failedUp) throw new Error('synthetic failure');
      state.image = JSON.parse(await fs.readFile(paths.override)).services['bug-report-kit'].image;
      state.id = (state.id[0] === '1' ? '4' : '1').repeat(64);
    }
    return '';
  }};
  const adapter = await createFixtureAdapter({spec,docker,paths,publicHealth:async()=>{state.publicCalls++;},pause:async()=>{}});
  return {adapter,state,paths,bytes,spec,docker};
}

test('candidate update targets only Kit; rollback in a fresh process restores exact override bytes', async t => {
  const f = await fixture(t);
  const previous = await f.adapter.inspect();
  await f.adapter.activate({image:newImage,expected:previous,rollback:false});
  await f.adapter.verify({imageId:newImage});
  const next = JSON.parse(await fs.readFile(f.paths.override));
  assert.equal(next.services['bug-report-kit'].environment.KEEP,'synthetic');
  assert.equal(next.services['bug-report-kit'].pull_policy,'never');
  const up = f.state.calls.find(args=>args[0]==='compose' && args.includes('up'));
  assert.deepEqual(up.slice(-7), ['up','-d','--no-build','--no-deps','--pull','never','bug-report-kit']);
  assert(f.state.calls.some(args=>args.join(' ')==='exec fixture-edge-1 nginx -s reload'));
  const fresh = await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,publicHealth:async()=>{},pause:async()=>{}});
  await fresh.activate({image:oldImage,expected:await fresh.inspect(),rollback:true,guard:previous.guard});
  assert.deepEqual(await fs.readFile(f.paths.override),f.bytes);
  assert.equal(f.state.image,oldImage);
  assert.deepEqual(await fs.readFile(f.paths.config),Buffer.from('{"synthetic":true}'));
});

test('rejects foreign Compose identity, changed config, stale container and changed neighbors before activation', async t => {
  const f = await fixture(t);
  f.state.foreign = true;
  await assert.rejects(f.adapter.inspect());
  f.state.foreign = false;
  const before = await f.adapter.inspect();
  f.state.id='5'.repeat(64);
  await assert.rejects(f.adapter.activate({image:newImage,expected:before}));
  f.state.id=id; f.state.edge='6'.repeat(64);
  await assert.rejects(f.adapter.inspect());
  f.state.edge=edge;
  await fs.writeFile(f.paths.config,'{"changed":true}');
  await assert.rejects(f.adapter.inspect());
  assert(!f.state.calls.some(args=>args.includes('up')));
  assert.deepEqual(await fs.readFile(f.paths.override),f.bytes);
});

test('failed Compose activation restores original override and leaves an exact rollback checkpoint', async t => {
  const f = await fixture(t);
  const before=await f.adapter.inspect(); f.state.failedUp=true;
  await assert.rejects(f.adapter.activate({image:newImage,expected:before}));
  assert.deepEqual(await fs.readFile(f.paths.override),f.bytes);
  const saved=JSON.parse(await fs.readFile(path.join(f.paths.state,'fixture-previous-override.json')));
  assert.equal(saved.previousImage,oldImage);
  assert.deepEqual(Buffer.from(saved.overrideBase64,'base64'),f.bytes);
});

test('public health retries transient nginx upstream reload failures', async t => {
  const f=await fixture(t); let attempts=0;
  const adapter=await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,pause:async()=>{},
    publicHealth:async()=>{if(++attempts<3)throw new Error('synthetic 502');}});
  await adapter.activate({image:newImage,expected:await adapter.inspect()});
  assert.equal(attempts,3);
});

test('refuses an unowned data mount and public private-file permissions', async t => {
  const f=await fixture(t);
  await fs.chmod(f.paths.config,0o644);
  await assert.rejects(createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths}));
  await fs.chmod(f.paths.config,0o600);
  await assert.rejects(createFixtureAdapter({spec:{...f.spec,data:{type:'volume',source:'foreign'}},docker:f.docker,paths:f.paths}));
});

test('fresh-process recovery rejects original neighbor, config and mount guard drift before writes', async t => {
  const f=await fixture(t); const before=await f.adapter.inspect();
  await f.adapter.activate({image:newImage,expected:before});
  const candidateBytes=await fs.readFile(f.paths.override);
  f.state.edge='7'.repeat(64);
  const fresh=await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,publicHealth:async()=>{},pause:async()=>{}});
  await assert.rejects(fresh.activate({image:oldImage,expected:await fresh.inspect(),rollback:true,guard:before.guard}));
  assert.deepEqual(await fs.readFile(f.paths.override),candidateBytes);
  f.state.edge=edge;
  await fs.writeFile(f.paths.config,'{"newConfig":true}');
  const changed=await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,publicHealth:async()=>{},pause:async()=>{}});
  await assert.rejects(changed.activate({image:oldImage,expected:await changed.inspect(),rollback:true,guard:before.guard}));
  assert.deepEqual(await fs.readFile(f.paths.override),candidateBytes);
  await fs.writeFile(f.paths.config,'{"synthetic":true}');
  const badGuard={...before.guard,mounts:before.guard.mounts.map(m=>({...m,source:'/foreign'}))};
  const restored=await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,publicHealth:async()=>{},pause:async()=>{}});
  await assert.rejects(restored.activate({image:oldImage,expected:await restored.inspect(),rollback:true,guard:badGuard}));
  assert.deepEqual(await fs.readFile(f.paths.override),candidateBytes);
});

test('missing container can recover only from private checkpoint and frozen guard', async t => {
  const f=await fixture(t); const before=await f.adapter.inspect();
  await f.adapter.activate({image:newImage,expected:before});
  f.state.id='';
  const fresh=await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,publicHealth:async()=>{},pause:async()=>{}});
  assert.equal(await fresh.inspect(),null);
  await fresh.activate({image:oldImage,expected:null,rollback:true,guard:before.guard});
  assert.deepEqual(await fs.readFile(f.paths.override),f.bytes);
  const empty=await fixture(t); empty.state.id='';
  await assert.rejects(empty.adapter.inspect());
});

test('image update preserves every environment value and rejects unsupported previous override', async t => {
  const f=await fixture(t); const before=await f.adapter.inspect();
  await f.adapter.activate({image:newImage,expected:before});
  assert.deepEqual(JSON.parse(await fs.readFile(f.paths.override)).services['bug-report-kit'].environment,
    JSON.parse(f.bytes).services['bug-report-kit'].environment);
  const g=await fixture(t); const prior=JSON.parse(g.bytes); delete prior.services['bug-report-kit'].environment.BUG_KIT_SPEECH_ENABLED;
  await fs.writeFile(g.paths.override,JSON.stringify(prior));
  await assert.rejects(g.adapter.activate({image:newImage,expected:await g.adapter.inspect()}));
  assert(!g.state.calls.some(args=>args.includes('up')));
});

test('fresh missing-container recovery rejects changed base Compose, env and override before writes', async t => {
  const f=await fixture(t);const before=await f.adapter.inspect();
  await f.adapter.activate({image:newImage,expected:before});
  const bytes=await fs.readFile(f.paths.override);f.state.id='';
  for (const [file,changed,original] of [[f.paths.base,'{"foreignVolume":true}','{"syntheticCompose":true}'],
    [f.paths.env,'SYNTHETIC=changed\n','SYNTHETIC=true\n']]) {
    await fs.writeFile(file,changed);
    const fresh=await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,publicHealth:async()=>{},pause:async()=>{}});
    const calls=f.state.calls.length;
    await assert.rejects(fresh.activate({image:oldImage,expected:null,rollback:true,guard:before.guard}));
    assert(!f.state.calls.slice(calls).some(args=>args.includes('up')));
    assert.deepEqual(await fs.readFile(f.paths.override),bytes);
    await fs.writeFile(file,original);
  }
  await fs.writeFile(f.paths.override,'{"foreignOverride":true}');
  const fresh=await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,publicHealth:async()=>{},pause:async()=>{}});
  await assert.rejects(fresh.activate({image:oldImage,expected:null,rollback:true,guard:before.guard}));
  assert.equal(await fs.readFile(f.paths.override,'utf8'),'{"foreignOverride":true}');
});

test('an owned atomic-write failure removes only its own pending file and permits retry', async t => {
  const f=await fixture(t);const before=await f.adapter.inspect();
  const originalOpen=fs.open;let once=true;
  fs.open=async (...args)=>{
    const handle=await originalOpen(...args);
    if(once && String(args[0])===`${f.paths.override}.common-pending`){once=false;
      return {writeFile:async()=>{throw new Error('synthetic write failure');},sync:()=>handle.sync(),close:()=>handle.close()};}
    return handle;
  };
  try {await assert.rejects(f.adapter.activate({image:newImage,expected:before}));}
  finally {fs.open=originalOpen;}
  assert.deepEqual(await fs.readFile(f.paths.override),f.bytes);
  await assert.rejects(fs.stat(`${f.paths.override}.common-pending`),{code:'ENOENT'});
  await f.adapter.activate({image:newImage,expected:before});
  await fs.writeFile(`${f.paths.override}.common-pending`,'foreign',{mode:0o600});
  await assert.rejects(f.adapter.activate({image:oldImage,expected:await f.adapter.inspect(),rollback:true,guard:before.guard}));
  assert.equal(await fs.readFile(`${f.paths.override}.common-pending`,'utf8'),'foreign');
});

test('established UID1000 runtime config is allowed while UID1000 operator override is rejected', async t => {
  const f=await fixture(t);const original=fs.lstat;let spoofOverride=false;
  fs.lstat=async (...args)=>{
    const stat=await original(...args);
    if(String(args[0])===f.paths.config || spoofOverride && String(args[0])===f.paths.override)
      return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{uid:1000});
    return stat;
  };
  try {
    const fresh=await createFixtureAdapter({spec:f.spec,docker:f.docker,paths:f.paths,publicHealth:async()=>{},pause:async()=>{}});
    const before=await fresh.inspect();assert.equal(before.imageId,oldImage);
    spoofOverride=true;
    await assert.rejects(fresh.activate({image:newImage,expected:before}));
    assert(!f.state.calls.some(args=>args.includes('up')));
  } finally {fs.lstat=original;}
});
