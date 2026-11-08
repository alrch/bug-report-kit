// Opt in with an already verified, locally present immutable public Kit image.
// This fixture never selects existing service names, host config, or real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync, execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {createDocker, createStandaloneAdapter} from '../runtime/deploy/docker.mjs';
import {deploy} from '../runtime/deploy/installer.mjs';
const base=process.env.BUG_KIT_DOCKER_TEST_IMAGE;
const enabled=/^sha256:[a-f0-9]{64}$/.test(base??'');
const raw=(args)=>execFileSync('docker',args,{encoding:'utf8',timeout:90000,stdio:['ignore','pipe','pipe']}).trim();
test('actual Docker: bootstrap, update, retry, preserve data/auth, same-copy previous rejection, rollback, automatic recovery', {skip:!enabled,timeout:240000}, async()=>{
 const root=mkdtempSync(join(process.platform==='darwin'?'/private/tmp':realpathSync(tmpdir()),'bug-kit-disposable-'));
 const token=root.split('-').at(-1).toLowerCase();const instance=`fixture-${token}`;const name=`bug-kit-${instance}`;
 const data=join(root,'data');mkdirSync(data,{mode:0o700});mkdirSync(join(data,'uploads'),{mode:0o700});
 writeFileSync(join(data,'uploads/historical.bin'),'synthetic attachment remains',{mode:0o600});
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const configRef=join(root,'config.json');
 const config={port,database:'./data/reports.sqlite',reporterAuthSecret:'SYNTHETIC_TEST_SECRET_32_CHARACTERS_ONLY',projects:[{id:'fixture',widgetKey:'fixture-public-key',voiceEnabled:false,allowedOrigins:[]}],teamTokens:[{name:'fixture',role:'admin',token:'SYNTHETIC_FIXTURE_PRIVATE',projects:['fixture']}]};
 writeFileSync(configRef,JSON.stringify(config),{mode:0o600});const originalConfig=readFileSync(configRef);
 const spec={schema:1,profile:'docker-server',instance,artifact:{image:base},stateDirectory:join(root,'state'),configRef,data:{type:'bind',source:data},runtime:{uid:0,gid:0,port},proxy:{healthUrl:`http://127.0.0.1:${port}/healthz`}};
 const configPath=join(root,'deployment.json');const images=[];const baseAlias=`bug-kit-disposable-${token}:base`;raw(['tag',base,baseAlias]);
 const cli=(action,image=spec.artifact.image)=>{spec.artifact.image=image;writeFileSync(configPath,JSON.stringify(spec),{mode:0o600});const r=spawnSync(process.execPath,['scripts/deploy.mjs',action,configPath],{cwd:process.cwd(),encoding:'utf8',timeout:90000});return {status:r.status,stdout:r.stdout,stderr:r.stderr,result:r.stdout?JSON.parse(r.stdout):null}};
 function makeImage(label,patch=''){
  const context=join(root,label);mkdirSync(context,{mode:0o700});
  const original="import {writeFileSync as fixtureWrite} from 'node:fs';\n"+readFileSync('server/app.mjs','utf8');
  const extra=patch||`if(db.prepare("SELECT name FROM sqlite_master WHERE name='installer_incompatible'").get())throw Error('fixture incompatible');`;
  writeFileSync(join(context,'app.mjs'),original.replace('const db = new DatabaseSync(databasePath);',`const db = new DatabaseSync(databasePath);${extra}`));
  writeFileSync(join(context,'Dockerfile'),`FROM ${baseAlias}\nCOPY app.mjs /app/server/app.mjs\nLABEL fixture.installer=${token}-${label}\n`);
  const image=raw(['build','--platform','linux/amd64','--pull=false','--network','none','--quiet',context]);assert.match(image,/^sha256:[a-f0-9]{64}$/);images.push(image);return image;
 }
 function readMarker(){return raw(['run','--rm','--network','none','--user','0:0','--mount',`type=bind,source=${data},target=/data`,base,'node','-e',"const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/reports.sqlite',{readOnly:true});console.log(d.prepare('SELECT value FROM installer_marker').get().value);d.close()"])}
 try{
  const previous=makeImage('previous');const candidate=makeImage('candidate');
  const tampering=makeImage('tampering',`try{fixtureWrite('/kit-installer-projection.json','{\"tables\":[],\"files\":[]}')}catch{};db.exec('DELETE FROM installer_marker');`);
  const incompatible=makeImage('incompatible',`db.exec('CREATE TABLE IF NOT EXISTS installer_incompatible (value TEXT)');`);
  raw(['run','--rm','--network','none','--user','0:0','--mount',`type=bind,source=${data},target=/data`,base,'node','-e',"const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/reports.sqlite');d.exec(\"CREATE TABLE installer_marker(value TEXT);INSERT INTO installer_marker VALUES('before-install')\");d.close()"]);
  assert.equal(cli('plan',previous).result.installed,false);assert.equal(existsSync(spec.stateDirectory),false);
  let r=cli('install',previous);assert.equal(r.status,0,r.stderr);assert.equal(r.result.changed,true);assert.equal(readMarker(),'before-install');
  const baseline=raw(['inspect','--format','{{.Id}}',name]);
  r=cli('install',previous);assert.equal(r.status,0,r.stderr);assert.equal(r.result.changed,false);assert.equal(raw(['inspect','--format','{{.Id}}',name]),baseline);
  r=cli('update',candidate);assert.equal(r.status,0,r.stderr);assert.equal(r.result.changed,true);
  assert.notEqual(raw(['inspect','--format','{{.Id}}',name]),baseline);
  const upgraded=raw(['inspect','--format','{{.Id}}',name]);r=cli('update',candidate);assert.equal(r.status,0,r.stderr);assert.equal(r.result.changed,false);assert.equal(raw(['inspect','--format','{{.Id}}',name]),upgraded);
  raw(['exec',name,'node','-e',"const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/reports.sqlite');d.exec(\"UPDATE installer_marker SET value='after-upgrade'\");d.close()"]);
  r=cli('rollback',candidate);assert.equal(r.status,0,r.stderr);assert.equal(readMarker(),'after-upgrade');assert.equal(raw(['inspect','--format','{{.Image}}',name]),previous);
  const beforeReject=raw(['inspect','--format','{{.Id}}',name]);r=cli('update',incompatible);assert.equal(r.status,1);assert.deepEqual(JSON.parse(r.stderr),{ok:false,code:'COMPATIBILITY_FAILED'});assert.equal(raw(['inspect','--format','{{.Id}}',name]),beforeReject);assert.equal(readMarker(),'after-upgrade');
  r=cli('update',tampering);assert.equal(r.status,1);assert.deepEqual(JSON.parse(r.stderr),{ok:false,code:'COMPATIBILITY_FAILED'});assert.equal(raw(['inspect','--format','{{.Id}}',name]),beforeReject);assert.equal(readMarker(),'after-upgrade');
  // Real driver, injected verification failure after actual recreation: binary
  // restoration must keep writes made after the original upgrade/backup.
  spec.artifact.image=candidate;const docker=createDocker();const adapter=createStandaloneAdapter({spec,docker});const verify=adapter.verify;let rejected=false;
  adapter.verify=async args=>{if(args.imageId===candidate&&!rejected){rejected=true;throw Error('synthetic proxy failure')}return verify(args)};
  await assert.rejects(deploy('update',spec,{docker,adapter}),/ACTIVATION_FAILED_RESTORED/);
  assert.equal(raw(['inspect','--format','{{.Image}}',name]),previous);assert.equal(readMarker(),'after-upgrade');
  assert.deepEqual(readFileSync(configRef),originalConfig);assert.equal(readFileSync(join(data,'uploads/historical.bin'),'utf8'),'synthetic attachment remains');
  assert.equal(existsSync(join(spec.stateDirectory,'transaction.json')),false);
  // Leave a genuine unfinished transaction after a failed automatic restore,
  // then recover through a NEW CLI PROCESS without rewinding intervening data.
  const interrupted=createStandaloneAdapter({spec,docker});const activate=interrupted.activate;
  interrupted.activate=async args=>{if(args.rollback)throw Error('synthetic restoration unavailable');return activate(args)};
  interrupted.verify=async()=>{throw Error('synthetic public health failure')};
  await assert.rejects(deploy('update',spec,{docker,adapter:interrupted}),/RECOVERY_REQUIRED/);
  assert.equal(existsSync(join(spec.stateDirectory,'transaction.json')),true);
  raw(['exec',name,'node','-e',"const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/reports.sqlite');d.exec(\"UPDATE installer_marker SET value='after-interruption'\");d.close()"]);
  r=cli('recover',candidate);assert.equal(r.status,0,r.stderr);assert.equal(r.result.recovered,true);assert.equal(readMarker(),'after-interruption');
  assert.equal(raw(['inspect','--format','{{.Image}}',name]),previous);assert.equal(existsSync(join(spec.stateDirectory,'transaction.json')),false);
  const backups=readdirSync(spec.stateDirectory).filter(n=>n.startsWith('backup-'));assert.ok(backups.length>=4);
  for(const backup of backups){assert.equal(JSON.parse(readFileSync(join(spec.stateDirectory,backup,'manifest.json'))).complete,true);assert.deepEqual(readFileSync(join(spec.stateDirectory,backup,'config.json')),originalConfig)}
  r=cli('verify',previous);assert.equal(r.status,0,r.stderr);
 }finally{
  // Exact uniquely generated name/image IDs only; no prune or production target.
  try{const owned=raw(['inspect','--format','{{index .Config.Labels "org.bug-report-kit.installer"}}',name]);if(owned===instance)raw(['rm','-f',name])}catch{}
  for(const image of images)try{raw(['image','rm',image])}catch{}
  try{raw(['image','rm',baseAlias])}catch{}
  rmSync(root,{recursive:true,force:true});
 }
});
