import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';
import {DatabaseSync} from 'node:sqlite';
import {parseAudio, audioStore} from '../server/audio.mjs';
import {updateRect} from '../widget/selection.js';
const wav = Buffer.alloc(46); wav.write('RIFF');wav.writeUInt32LE(38,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(2,40);
const recording = `data:audio/wav;base64,${wav.toString('base64')}`;
const waitFor = async (read, state) => {
  for (let i=0;i<100;i++) {const x = await read(); if (x.transcription?.state === state) return x; await new Promise(r=>setTimeout(r,30));}
  assert.fail(`transcription never became ${state}`);
};
test('audio is independent, private, durable and transcribed without overwriting human text', async t => {
  const directory=mkdtempSync(join(tmpdir(),'kit-audio-')); t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const transcriber=join(directory,'transcribe.mjs');
  writeFileSync(transcriber,"import{writeFileSync}from'node:fs';writeFileSync(process.argv[3],'Проверка голосового сообщения');");
  const config={projects:[{id:'audio',voiceEnabled:true,widgetKey:'audio-key',allowedOrigins:['https://fixture.test']}],teamTokens:[{name:'Developer',role:'developer',token:'dev',projects:['audio']},{name:'Other',role:'developer',token:'other',projects:['other']}],transcription:{command:[process.execPath,transcriber]}};
  const app=createApp(config,{rootDir:directory});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const auth={Authorization:'Bearer dev'};
  const create=values=>fetch(base+'/api/reports',{method:'POST',headers:{Origin:'https://fixture.test','X-Project-Key':'audio-key','Content-Type':'application/json'},body:JSON.stringify({pageUrl:'https://fixture.test/',...values})});
  const response=await create({description:'Мои слова',audio:recording,attachment:{name:'file.txt',data:'data:text/plain;base64,ZmlsZQ=='}});
  assert.equal(response.status,201); const {id}=await response.json();
  const read=async()=>await(await fetch(`${base}/api/reports/${id}`,{headers:auth})).json();
  const result=await waitFor(read,'ready'); assert.equal(result.description,'Мои слова'); assert.equal(result.transcription.text,'Проверка голосового сообщения');assert.equal(result.audioAvailable,true);assert.equal(result.attachmentAvailable,true);
  for (const [headers,status] of [[{},401],[{Authorization:'Bearer other'},403],[auth,200]]) {
    const res=await fetch(`${base}/api/reports/${id}/audio`,{headers}); assert.equal(res.status,status);
    if(status===200) assert.deepEqual(Buffer.from(await res.arrayBuffer()),wav);
  }
  const html=await(await fetch(`${base}/api/reports/${id}/html`,{headers:auth})).text();assert.match(html,/<audio controls/);assert.match(html,/Проверка голосового сообщения/);
  const list=await(await fetch(base+'/api/reports',{headers:auth})).json();assert.equal(list[0].audioAvailable,true);
  assert.equal((await create({audio:recording})).status,201);
  assert.equal((await create({description:'bad',audio:'data:audio/wav;base64,YmFk'})).status,400);
  assert.equal((await create({})).status,400);
  const count=app.db.prepare('SELECT count(*) AS n FROM reports').get().n; assert.equal(count,2);
  // A malformed model input/process failure leaves original bytes and an explicit retry.
  writeFileSync(transcriber,'process.exit(1)');
  const failureId=(await(await create({audio:recording})).json()).id;
  const failedRead=async()=>await(await fetch(`${base}/api/reports/${failureId}`,{headers:auth})).json();
  await waitFor(failedRead,'failed');
  assert.deepEqual(Buffer.from(await(await fetch(`${base}/api/reports/${failureId}/audio`,{headers:auth})).arrayBuffer()),wav);
  writeFileSync(transcriber,"import{writeFileSync}from'node:fs';writeFileSync(process.argv[3],'Восстановлено');");
  assert.equal((await fetch(`${base}/api/reports/${failureId}/transcription`,{method:'POST',headers:auth})).status,202);
  assert.equal((await waitFor(failedRead,'ready')).transcription.text,'Восстановлено');
});
test('unconfigured recognition keeps the audio and reports its state',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'kit-audio-disabled-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const db = new DatabaseSync(':memory:'); db.exec("CREATE TABLE reports(id TEXT PRIMARY KEY); INSERT INTO reports VALUES ('fixture')");
  const audio = audioStore(db);
  audio.insert('fixture',parseAudio(recording));
  assert.equal(audio.metadata('fixture').transcription.state,'unavailable');
  assert.deepEqual(audio.read('fixture').data,new Uint8Array(wav));
  assert.equal(audio.retry('fixture'),false);
  audio.close();db.close();
});
test('selection movement and resize remain within screenshot bounds',()=>{
  const rect={x:20,y:30,width:100,height:80};
  assert.deepEqual(updateRect({x:380,y:690,width:2,height:2},'se',1,1,390,699),{x:366,y:675,width:24,height:24});
  assert.deepEqual(updateRect(rect,'move',-999,999,390,699),{x:0,y:619,width:100,height:80});
  assert.deepEqual(updateRect(rect,'nw',999,999,390,699),{x:96,y:86,width:24,height:24});
  assert.deepEqual(updateRect(rect,'se',999,999,390,699),{x:20,y:30,width:370,height:669});
});
test('audio and interrupted jobs survive reopening SQLite and stale leases recover',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'kit-audio-restart-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const path=join(directory,'db.sqlite');
  let db=new DatabaseSync(path);db.exec("CREATE TABLE reports(id TEXT PRIMARY KEY);INSERT INTO reports VALUES('restart')");
  let audio=audioStore(db);audio.insert('restart',parseAudio(recording));
  db.prepare("UPDATE report_audio SET state='processing',lease='interrupted',started_at=0 WHERE report_id='restart'").run();audio.close();db.close();
  const script=join(directory,'transcribe.mjs');writeFileSync(script,"import{writeFileSync}from'node:fs';writeFileSync(process.argv[3],'После перезапуска');");
  db=new DatabaseSync(path);audio=audioStore(db,{command:[process.execPath,script],timeoutMs:1000});
  t.after(()=>{audio.close();db.close();});
  assert.deepEqual(audio.read('restart').data,new Uint8Array(wav));
  await audio.pump();assert.equal(audio.metadata('restart').transcription.state,'ready');assert.equal(audio.metadata('restart').transcription.text,'После перезапуска');
});
