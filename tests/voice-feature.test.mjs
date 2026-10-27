import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';

test('voice is opt-in per project; disabled projects keep old audio but reject new audio and queued ASR',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'kit-voice-feature-'));
  const marker=join(dir,'runs.txt'),script=join(dir,'asr.mjs');
  writeFileSync(script,`import{appendFileSync,writeFileSync}from'node:fs';appendFileSync(${JSON.stringify(marker)},'x');writeFileSync(process.argv[3],'Разрешённый проект');`);
  const origin='https://fixture.test';
  const app=createApp({projects:[{id:'off',widgetKey:'off',allowedOrigins:[origin]},
    {id:'explicit-off',widgetKey:'explicit-off',voiceEnabled:false,allowedOrigins:[origin]},
    {id:'on',widgetKey:'on',voiceEnabled:true,allowedOrigins:[origin]}],
    teamTokens:[{token:'TEST',role:'developer',projects:['off','explicit-off','on']}],
    transcription:{command:[process.execPath,script]}},{rootDir:process.cwd(),database:join(dir,'fixture.sqlite')});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.db.close();rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const auth={Authorization:'Bearer TEST'};
  const request=(project,path,body)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'X-Project-Key':project,'Content-Type':'application/json'},body:JSON.stringify({pageUrl:origin+'/',...body})});
  const wav=Buffer.alloc(46);wav.write('RIFF');wav.writeUInt32LE(38,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(2,40);
  const audio=`data:audio/wav;base64,${wav.toString('base64')}`;
  for(const project of ['off','explicit-off']){
    const text=await request(project,'/api/reports',{description:'Текст из клавиатурной диктовки'});
    assert.equal(text.status,201);const {id}=await text.json();
    const before=app.db.prepare('SELECT count(*) AS n FROM reports').get().n;
    assert.equal((await request(project,'/api/reports',{description:'Текст',audio})).status,403);
    assert.equal((await request(project,'/api/reports',{description:'Текст',transcriptionDraft:{id:'TEST',token:'TEST'}})).status,403);
    assert.equal((await request(project,'/api/transcription-drafts',{audio})).status,403);
    assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,before);
    // A retained pre-switch recording must remain byte-for-byte readable.
    app.db.prepare("INSERT INTO report_audio(report_id,data,mime,state) VALUES(?,?,'audio/wav','pending')").run(id,wav);
    const read=await fetch(base+`/api/reports/${id}/audio`,{headers:auth});
    assert.equal(read.status,200);assert.deepEqual(Buffer.from(await read.arrayBuffer()),wav);
    assert.equal((await fetch(base+`/api/reports/${id}/transcription`,{method:'POST',headers:auth})).status,403);
    assert.equal(app.audio.retry(id),false);
    const row=await(await fetch(base+`/api/reports/${id}`,{headers:auth})).json();
    assert.equal(row.voiceEnabled,false);assert.equal(row.description,'Текст из клавиатурной диктовки');
  }
  await app.audio.pump();assert.equal(existsSync(marker),false,'disabled saved jobs must not start');
  const enabled=await request('on','/api/transcription-drafts',{audio});assert.equal(enabled.status,202);
  const draft=await enabled.json();
  for(let i=0;i<100;i++){
    const row=app.audio.draftFor(draft.id,draft.draftToken,'on','');
    if(row.state==='ready'){assert.equal(row.transcript,'Разрешённый проект');break;}
    if(i===99)assert.fail('enabled project did not transcribe');
    await new Promise(r=>setTimeout(r,20));
  }
  assert.equal(app.db.prepare("SELECT count(*) AS n FROM report_audio WHERE state='pending'").get().n,2);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM transcription_drafts').get().n,1);
});
