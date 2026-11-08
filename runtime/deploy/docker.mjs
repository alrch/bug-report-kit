import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID, createHash} from 'node:crypto';
import {mkdirSync, copyFileSync, chmodSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fail, imageReference} from './config.mjs';
const execute = promisify(execFile);
const id = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
const owner = 'org.bug-report-kit.installer';
const mount = spec => `type=${spec.data.type},source=${spec.data.source},target=/app/data`;
const configMount = spec => `type=bind,source=${spec.configRef},target=/app/config.local.json,readonly`;
export function createDocker({binary = 'docker'} = {}) {
  return {async run(args) {
    try {
      const {stdout} = await execute(binary, args, {encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024,
        env: {PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.DOCKER_HOST ? {DOCKER_HOST: process.env.DOCKER_HOST} : {})}});
      return stdout.trim();
    } catch { fail('DOCKER_FAILED'); }
  }};
}
export async function resolveImage(docker, image) {
  if (!imageReference(image)) fail('UNPINNED_IMAGE');
  const actual = await docker.run(['image', 'inspect', '--format', '{{.Id}}', image]);
  if (!id(actual) || image.startsWith('sha256:') && actual !== image) fail('IMAGE_IDENTITY');
  return actual;
}
export async function publicHealth(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(3000)});
      const text = await response.text();
      if (response.ok && text.length <= 1024 && JSON.parse(text).ok === true) return;
    } catch { /* Fixed diagnostics only; no response bodies escape. */ }
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 500));
  }
  fail('HEALTH_FAILED');
}
export function createStandaloneAdapter({spec, docker}) {
  const name = `bug-kit-${spec.instance}`;
  const stateBinding = createHash('sha256').update(JSON.stringify([spec.instance,spec.stateDirectory,spec.configRef,spec.data.type,spec.data.source,spec.runtime.uid,spec.runtime.gid,spec.runtime.port])).digest('hex');
  async function inspect() {
    const found = await docker.run(['ps', '-aq', '--filter', `name=^/${name}$`]);
    if (!found) return null;
    const raw = await docker.run(['container', 'inspect', '--format', '{{json .Id}}|{{json .Image}}|{{json .Config.Labels}}|{{json .Mounts}}', name]);
    const [containerId, imageId, labels, mounts] = raw.split('|').map(part => JSON.parse(part));
    if (!/^[a-f0-9]{64}$/.test(containerId) || !id(imageId) || labels?.[owner] !== spec.instance || labels?.[`${owner}.binding`] !== stateBinding ||
        mounts.length !== 2 || !mounts.some(m => m.Destination === '/app/config.local.json' && m.Source === spec.configRef && !m.RW) ||
        !mounts.some(m => m.Destination === '/app/data' && m.RW && (spec.data.type === 'volume' ? m.Name === spec.data.source : m.Source === spec.data.source))) fail('FOREIGN_RESOURCE');
    return {id: containerId, imageId, imageRef: imageId};
  }
  return {identity: 'standalone-docker-v1', inspect,
    async activate({image, expected}) {
      const current = await inspect();
      if (JSON.stringify(current) !== JSON.stringify(expected)) fail('RESOURCE_CHANGED');
      if (current) {
        await docker.run(['stop', '--time', '20', current.id]);
        await docker.run(['rm', current.id]);
      }
      // Never remove data, uploads, the config or another container.
      await docker.run(['run', '-d', '--name', name, '--label', `${owner}=${spec.instance}`, '--label', `${owner}.binding=${stateBinding}`, '--restart', 'unless-stopped',
        '--user', `${spec.runtime.uid}:${spec.runtime.gid}`, '--env', 'BUG_KIT_HOST=0.0.0.0', '--env', 'BUG_KIT_SPEECH_ENABLED=0',
        '--env', 'BUG_KIT_SERVICE_STATE=/tmp/bug-kit-service', '--publish', `127.0.0.1:${spec.runtime.port}:${spec.runtime.port}`, '--mount', mount(spec), '--mount', configMount(spec), image]);
    },
    async verify({imageId}) {
      const current = await inspect();
      if (!current || current.imageId !== imageId) fail('IMAGE_IDENTITY');
      let ready = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { await docker.run(['exec', current.id, 'node', '-e', `fetch('http://127.0.0.1:${spec.runtime.port}/healthz').then(async r=>{if(!r.ok||(await r.json()).ok!==true)process.exit(1)}).catch(()=>process.exit(1))`]); ready = true; break; }
        catch { if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 200)); }
      }
      if (!ready) fail('HEALTH_FAILED');
      await publicHealth(spec.proxy.healthUrl);
    }};
}
// Snapshot and projection programs are fixed code, never taken from deployment data.
const projection = `
function projection(db, schema) {
  const quote=s=>'"'+s.replaceAll('"','""')+'"';
  schema ||= db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(t=>({name:t.name,columns:db.prepare('PRAGMA table_info('+quote(t.name)+')').all().map(c=>c.name)}));
  return schema.map(t=>{const rows=db.prepare('SELECT '+t.columns.map(quote).join(',')+' FROM '+quote(t.name)).all();
    const canonical=rows.map(row=>JSON.stringify(row,(_,v)=>typeof v==='bigint'?String(v):v)).sort();
    return {...t,hash:crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')};});
}`;
const backupScript = `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync,backup}=require('node:sqlite');
${projection}
(async()=>{const c=JSON.parse(fs.readFileSync('/app/config.local.json','utf8'));
if(c.port!==PORT||c.transcription||c.projects?.some(p=>p.voiceEnabled===true))throw Error();
const p=path.resolve('/app',c.database||'./data/reports.sqlite');if(!p.startsWith('/app/data/'))throw Error();
const target='/probe/data/'+path.relative('/app/data',p);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
let files=0;function copy(source,destination){for(const entry of fs.readdirSync(source,{withFileTypes:true})){
 const from=path.join(source,entry.name),to=path.join(destination,entry.name);
 if([p,p+'-wal',p+'-shm'].includes(from))continue;if(++files>100000||entry.isSymbolicLink())throw Error();
 if(entry.isDirectory()){fs.mkdirSync(to,{recursive:true,mode:0o700});copy(from,to)}else if(entry.isFile()){fs.copyFileSync(from,to);fs.chmodSync(to,0o600)}else throw Error();}}
copy('/app/data','/probe/data');
let existing=[];if(fs.existsSync(p)){const db=new DatabaseSync(p,{readOnly:true});try{await backup(db,target);fs.chmodSync(target,0o600)}finally{db.close()}
const check=new DatabaseSync(target,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error();existing=projection(check)}finally{check.close()}}
const historical=[];function list(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())list(p);else if(![target,target+'-wal',target+'-shm'].includes(p))historical.push({file:path.relative('/probe/data',p),hash:crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')})}}list('/probe/data');
fs.writeFileSync('/probe/projection.json',JSON.stringify({tables:existing,files:historical}),{mode:0o600});
})().catch(()=>process.exit(1));`;
const checkScript = `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
${projection}
(async()=>{const c=JSON.parse(fs.readFileSync('/app/config.local.json','utf8'));
const response=await fetch('http://127.0.0.1:PORT/healthz',{signal:AbortSignal.timeout(2000)});
if(!response.ok||(await response.json()).ok!==true)throw Error();
const db=new DatabaseSync(path.resolve('/app',c.database||'./data/reports.sqlite'),{readOnly:true});
try{if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error();
const before=JSON.parse(fs.readFileSync('/kit-installer-projection.json','utf8'));
if(JSON.stringify(projection(db,before.tables))!==JSON.stringify(before.tables))throw Error();
for(const entry of before.files){const file=path.join('/app/data',entry.file);if(fs.lstatSync(file).isSymbolicLink()||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==entry.hash)throw Error();}}finally{db.close()}
for(const f of ['dist/widget.js','dist/loader.js','dist/client.mjs','runtime/service.mjs'])if(!fs.statSync('/app/'+f).isFile())throw Error();
})().catch(()=>process.exit(1));`;
export async function rehearse({spec, docker, candidate, previous}) {
  const token = randomUUID();
  const name = `bug-kit-check-${spec.instance}-${token}`;
  const backupDirectory = join(spec.stateDirectory, `backup-${token}`);
  if (spec.data.type === 'volume' && await docker.run(['volume', 'inspect', '--format', '{{.Name}}', spec.data.source]) !== spec.data.source) fail('FOREIGN_RESOURCE');
  mkdirSync(backupDirectory, {mode: 0o700});
  copyFileSync(spec.configRef, join(backupDirectory, 'config.json'));
  chmodSync(join(backupDirectory, 'config.json'), 0o600);
  writeFileSync(join(backupDirectory, 'manifest.json'), JSON.stringify({schema:1,instance:spec.instance,previous,candidate,complete:false}), {mode:0o600});
  let created = false;
  async function isolated(args, check) {
    const containerName = `${name}-${randomUUID().slice(0, 8)}`;
    try {
      const result = await docker.run(['run', '--rm', '--name', containerName, '--label', `${owner}=${token}`, ...args]);
      if (check) { if (!/^[a-f0-9]{64}$/.test(result)) fail('DOCKER_FAILED'); await check(result); }
      return result;
    } finally {
      const remaining = await docker.run(['ps', '-aq', '--no-trunc', '--filter', `name=^/${containerName}$`]);
      if (remaining) {
        const actual = await docker.run(['container', 'inspect', '--format', `{{.Id}}|{{index .Config.Labels "${owner}"}}`, remaining]);
        if (actual !== `${remaining}|${token}` || !/^[a-f0-9]{64}$/.test(remaining)) fail('FOREIGN_RESOURCE');
        await docker.run(['rm', '-f', remaining]);
      }
    }
  }
  try {
    // Durable private backup comes before rehearsal and any live activation.
    // The online SQLite backup includes screenshots, attachments and old audio BLOBs.
    await isolated(['--network', 'none', '--read-only', '--user', '0:0',
      '--mount', `${mount(spec)},readonly`, '--mount', configMount(spec),
      '--mount', `type=bind,source=${backupDirectory},target=/probe`, previous || candidate,
      'node', '-e', backupScript.replaceAll('PORT', String(spec.runtime.port))]);
    writeFileSync(join(backupDirectory, 'manifest.json'), JSON.stringify({schema:1,instance:spec.instance,previous,candidate,complete:true}), {mode:0o600});
    await docker.run(['volume', 'create', '--label', `${owner}=${token}`, name]); created = true;
    await isolated(['--network', 'none', '--user', '0:0', '--mount', `type=volume,source=${name},target=/copy`,
      '--mount', `type=bind,source=${backupDirectory},target=/backup,readonly`, candidate, 'node', '-e',
      `const fs=require('node:fs'),p=require('node:path');fs.cpSync('/backup/data','/copy',{recursive:true});function own(d){fs.chownSync(d,${spec.runtime.uid},${spec.runtime.gid});if(fs.statSync(d).isDirectory())for(const f of fs.readdirSync(d))own(p.join(d,f))}own('/copy')`]);
    // Start each REAL image CMD/watchdog; downgrade runs on the candidate-mutated SAME copy.
    for (const image of [candidate, ...(previous ? [previous] : [])]) {
      await isolated(['-d', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
        '--user', `${spec.runtime.uid}:${spec.runtime.gid}`, '--env', 'BUG_KIT_HOST=0.0.0.0', '--env', 'BUG_KIT_SPEECH_ENABLED=0',
        '--env', 'BUG_KIT_SERVICE_STATE=/tmp/bug-kit-service', '--mount', `type=volume,source=${name},target=/app/data`,
        '--mount', configMount(spec), '--mount', `type=bind,source=${backupDirectory}/projection.json,target=/kit-installer-projection.json,readonly`, image], async container => {
          let ready = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            try { await docker.run(['exec', '--user', '0:0', container, 'node', '-e', checkScript.replaceAll('PORT', String(spec.runtime.port))]); ready = true; break; }
            catch { if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 200)); }
          }
          if (!ready) fail('COMPATIBILITY_FAILED');
        });
    }
    return backupDirectory;
  } finally {
    if (created) {
      const label = await docker.run(['volume', 'inspect', '--format', `{{index .Labels "${owner}"}}`, name]);
      if (label !== token) fail('FOREIGN_RESOURCE');
      await docker.run(['volume', 'rm', name]);
    }
  }
}
