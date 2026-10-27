import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';
import {DatabaseSync} from 'node:sqlite';
import {audioStore,parseAudio} from '../server/audio.mjs';
const bytes=Buffer.alloc(46);bytes.write('RIFF');bytes.write('WAVE',8);
const audio=`data:audio/wav;base64,${bytes.toString('base64')}`;
const origin='https://draft-fixture.test';
async function setup(t,{auth=false,script,other=false}={}) {
 const dir=mkdtempSync(join(tmpdir(),'kit-draft-'));
 const transcriber=join(dir,'asr.mjs');
 const count=join(dir,'runs');
 writeFileSync(transcriber,script || `import{writeFileSync,appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(count)},'x');writeFileSync(process.argv[3],'Машинный текст');`);
 const app=createApp({reporterAuthSecret:'TEST-only-isolated-fixture-secret-32-bytes',projects:[{id:dir,widgetKey:dir,allowedOrigins:[origin],reporterAuth:auth},...(other?[{id:dir+'other',widgetKey:dir+'other',allowedOrigins:[origin]}]:[])],teamTokens:[{token:'dev',projects:[dir]}],transcription:{command:[process.execPath,transcriber],timeoutMs:1000}},{rootDir:dir});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 const headers=(token='',draft='',key=dir)=>({'Content-Type':'application/json',Origin:origin,'X-Project-Key':key,...(token?{'X-Reporter-Token':token}:{}),...(draft?{'X-Draft-Token':draft}:{})});
 const request=(path,body,token='',draft='',key=dir)=>fetch(base+path,{method:'POST',headers:headers(token,draft,key),body:JSON.stringify(body)});
 const create=async(token='')=>{const res=await request('/api/transcription-drafts',{audio,pageUrl:origin+'/'},token);assert.equal(res.status,202);return res.json();};
 const ready=async(draft,token='',state='ready')=>{for(let i=0;i<100;i++){const res=await request(`/api/transcription-drafts/${draft.id}/status`,{},token,draft.draftToken);assert.equal(res.status,200);const row=await res.json();if(row.state===state)return row;await new Promise(r=>setTimeout(r,25));}assert.fail('draft did not finish');};
 return {app,base,dir,count,headers,request,create,ready,transcriber};
}
test('draft status before report, ready transfer without duplicate ASR, bytes and 4000 boundary',async t=>{
 const {app,base,dir,count,request,create,ready}=await setup(t);
 const draft=await create();const result=await ready(draft);assert.equal(result.text,'Машинный текст');
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);
 const submit=description=>request('/api/reports',{description,audio,pageUrl:origin+'/',transcriptionDraft:{id:draft.id,token:draft.draftToken}});
 assert.equal((await submit('x'.repeat(4001))).status,400);
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);
 const res=await submit('x'.repeat(4000));assert.equal(res.status,201);const {id}=await res.json();
 const report=await(await fetch(base+'/api/reports/'+id,{headers:{Authorization:'Bearer dev'}})).json();
 assert.equal(report.description.length,4000);assert.equal(report.transcription.text,'Машинный текст');assert.equal(report.transcription.state,'ready');
 const saved=await fetch(base+'/api/reports/'+id+'/audio',{headers:{Authorization:'Bearer dev'}});assert.deepEqual(Buffer.from(await saved.arrayBuffer()),bytes);
 await app.audio.pump();assert.equal(readFileSync(count,'utf8'),'x');
 assert.equal((await request(`/api/transcription-drafts/${draft.id}/status`,{},'',draft.draftToken)).status,404);
});
test('draft origin, reporter ownership, session refresh, token and project boundaries',async t=>{
 const {app,base,dir,headers,request,create,ready}=await setup(t,{auth:true,other:true});
 assert.equal((await request('/api/transcription-drafts',{audio,pageUrl:origin+'/'})).status,401);
 const account=async name=>(await(await request('/api/reporter/register',{name,pin:'1234'})).json()).token;
 const owner=await account('Автор'),other=await account('Другой');const draft=await create(owner);await ready(draft,owner);
 const status=`/api/transcription-drafts/${draft.id}/status`;
 assert.equal((await request(status,{},other,draft.draftToken)).status,404);
 assert.equal((await request(status,{},owner,'wrong')).status,404);
 assert.equal((await request(status,{},'',draft.draftToken,dir+'other')).status,404);
 assert.equal((await fetch(base+status,{method:'POST',headers:{...headers(owner,draft.draftToken),Origin:'https://evil.test'},body:'{}'})).status,403);
 const login=(await(await request('/api/reporter/login',{name:'Автор',pin:'1234'})).json()).token;
 assert.equal((await request(status,{},login,draft.draftToken)).status,200);
 assert.equal((await request(`/api/transcription-drafts/${draft.id}/cancel`,{},login,draft.draftToken)).status,200);
 assert.equal((await request(status,{},login,draft.draftToken)).status,404);
});
test('failed draft retries without a report; expiry cleans bytes; speech rate limit is independent',async t=>{
 const {app,request,create,ready,transcriber}=await setup(t,{script:'process.exit(1)'});
 const draft=await create();await ready(draft,'','failed');
 writeFileSync(transcriber,"import{writeFileSync}from'node:fs';writeFileSync(process.argv[3],'Вторая попытка');");
 assert.equal((await request(`/api/transcription-drafts/${draft.id}/retry`,{},'',draft.draftToken)).status,202);
 assert.equal((await ready(draft)).text,'Вторая попытка');assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);
 app.db.prepare('UPDATE transcription_drafts SET expires_at=0 WHERE id=?').run(draft.id);
 assert.equal((await request(`/api/transcription-drafts/${draft.id}/status`,{},'',draft.draftToken)).status,404);
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM transcription_drafts').get().n,0);
 for(let i=0;i<4;i++) await create();
 assert.equal((await request('/api/transcription-drafts',{audio,pageUrl:origin+'/'})).status,429);
 assert.equal((await request('/api/reports',{description:'Ручной текст',pageUrl:origin+'/'})).status,201);
});
test('draft stale lease recovers after restart and cancelled worker cannot resurrect the draft',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'kit-draft-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'fixture.sqlite'),script=join(dir,'asr.mjs');writeFileSync(script,"import{writeFileSync}from'node:fs';setTimeout(()=>writeFileSync(process.argv[3],'После перезапуска'),80);");
 let db=new DatabaseSync(path);db.exec('CREATE TABLE reports(id TEXT PRIMARY KEY)');let store=audioStore(db);
 const draft=store.createDraft('fixture','',parseAudio(audio));db.prepare("UPDATE transcription_drafts SET state='processing',started_at=0,lease='old' WHERE id=?").run(draft.id);store.close();db.close();
 db=new DatabaseSync(path);store=audioStore(db,{command:[process.execPath,script],timeoutMs:1000});
 try {await store.pump();assert.equal(store.draftFor(draft.id,draft.draftToken,'fixture','').state,'ready');const next=store.createDraft('fixture','',parseAudio(audio));const pending=store.pump();store.cancelDraft(next.id);await pending;assert.equal(store.draftFor(next.id,next.draftToken,'fixture',''),undefined);} finally {store.close();db.close();}
});


test('expired temporary speech directories are cleaned after reopening without touching unrelated paths',t=>{
 const dir=mkdtempSync(join(tmpdir(),'kit-draft-cleanup-')),orphan=mkdtempSync(join(tmpdir(),'bug-kit-speech-'));
 t.after(()=>{rmSync(dir,{recursive:true,force:true});rmSync(orphan,{recursive:true,force:true});});
 const path=join(dir,'fixture.sqlite');let db=new DatabaseSync(path);db.exec('CREATE TABLE reports(id TEXT PRIMARY KEY)');let store=audioStore(db);
 writeFileSync(join(orphan,'recording'),'TEST synthetic audio');const protectedFile=join(dir,'keep.txt');writeFileSync(protectedFile,'keep');
 db.prepare('INSERT INTO speech_workdirs(path,expires_at) VALUES(?,0)').run(orphan);db.prepare('INSERT INTO speech_workdirs(path,expires_at) VALUES(?,0)').run(protectedFile);
 store.close();db.close();db=new DatabaseSync(path);store=audioStore(db);
 try {assert.equal(existsSync(orphan),false);assert.equal(existsSync(protectedFile),true);assert.equal(db.prepare('SELECT count(*) AS n FROM speech_workdirs').get().n,0);} finally {store.close();db.close();}
});
