import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium, webkit} from 'playwright';
import {createApp} from '../server/app.mjs';

async function fixture(t, engine=chromium, speech={}, sameOrigin=false) {
  const directory=mkdtempSync(join(tmpdir(),'kit-voice-submit-'));
  let kitBase;
  const site=createServer((req,res)=>{
    if(sameOrigin && (req.url.startsWith('/api/') || req.url.startsWith('/widget.'))) {
      const upstream=httpRequest(kitBase+req.url,{method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});
      upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);return;
    }
    const publicBase=sameOrigin ? origin : kitBase;
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body><h1>TEST synthetic voice</h1><script src="${publicBase}/widget.js" data-server-url="${publicBase}" data-project-key="fixture"></script>`);
  });
  await new Promise(r=>site.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${site.address().port}`;
  const script=join(directory,'asr.mjs');writeFileSync(script,`import{writeFileSync}from'node:fs';setTimeout(()=>${speech.fail ? 'process.exit(1)' : `writeFileSync(process.argv[3],${JSON.stringify(speech.text || 'TEST распознанные слова')})`},${speech.delay || 60});`);
  const app=createApp({transcription:{command:[process.execPath,script]},projects:[{id:directory,widgetKey:'fixture',allowedOrigins:[origin]}],teamTokens:[{token:'fixture-developer',role:'developer',projects:[directory]}]},{rootDir:process.cwd(),database:join(directory,'reports.sqlite')});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));kitBase=`http://127.0.0.1:${app.server.address().port}`;
  const browser=await engine.launch(engine===chromium?{headless:true,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']}:{headless:true});
  t.after(async()=>{await browser.close();await new Promise(r=>site.close(r));await new Promise(r=>app.server.close(r));app.db.close();rmSync(directory,{recursive:true,force:true});});
  const context=await browser.newContext({viewport:{width:390,height:699},isMobile:true,hasTouch:true,permissions:engine===chromium?['microphone']:[]});
  const page=await context.newPage();page.setDefaultTimeout(8000);
  // Both engines retain the real MediaRecorder. Chromium uses its test device;
  // WebKit encodes Web Audio instead of requesting the room microphone.
  await page.goto(origin);
  await page.evaluate(useWebAudio=>{
    const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.voiceStreams=[];
    Object.defineProperty(Object.getPrototypeOf(navigator.mediaDevices),'getUserMedia',{configurable:true,writable:true,value:async function syntheticVoiceStream(...args){
      let stream;
      if(useWebAudio){const audio=new AudioContext();const tone=audio.createOscillator();const dest=audio.createMediaStreamDestination();tone.connect(dest);tone.start();await audio.resume();stream=dest.stream;}
      else stream=await get(...args);
      voiceStreams.push(stream);return stream;
    }});
  },engine===webkit);
  const open=async(screenshot=false)=>{
    await page.getByRole('button',{name:'Сообщить о баге',exact:true}).click();
    await page.locator('.overlay:not(.is-preparing)').waitFor();
    if(screenshot){await page.mouse.move(30,150);await page.mouse.down();await page.mouse.move(270,250,{steps:4});await page.mouse.up();await page.getByRole('button',{name:'Подтвердить выделение',exact:true}).click();}
    else await page.getByRole('button',{name:'Продолжить без снимка',exact:true}).click();
    await page.locator('.report-card').waitFor();
  };
  const recording=async()=>{await page.getByRole('button',{name:'Записать голос',exact:true}).click();await page.getByRole('button',{name:'Остановить запись',exact:true}).waitFor();await page.waitForTimeout(200);};
  const post=()=>page.waitForResponse(r=>r.url()===(sameOrigin ? origin : kitBase)+'/api/reports'&&r.request().method()==='POST');
  const auth={Authorization:'Bearer fixture-developer'};
  const ready=async()=>{await page.getByText('Расшифровка добавлена. Проверьте текст перед отправкой.',{exact:true}).waitFor();};
  const done=async()=>{await page.getByRole('button',{name:'Готово',exact:true}).click();await ready();};
  return {page,open,recording,post,kitBase,auth,ready,done,app,script};
}

test('voice controls and footer remain stationary through recording, preview and content scrolling',async t=>{
  const {page,open,recording}=await fixture(t);await open(true);
  const bounds=()=>page.locator('.report-footer .primary').boundingBox();
  const initial=await bounds();assert.ok(initial.y+initial.height<=699);
  await page.locator('.report-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  const button=()=>page.locator('.voice-input button').first().boundingBox();
  const before=await button();await recording();const during=await button();
  assert.ok(Math.abs(before.y-during.y)<1,'record button must not jump when timer appears');
  assert.ok(Math.abs(initial.y-(await bounds()).y)<1,'footer moves when recording begins');
  await page.waitForTimeout(250); // allow actual samples to reach the synthetic device encoder
  await page.getByRole('button',{name:'Остановить запись',exact:true}).click();await page.getByText('Запись готова. Можно прослушать.',{exact:true}).waitFor();
  assert.ok(Math.abs(initial.y-(await bounds()).y)<1,'audio preview must not displace send');
  await page.locator('.report-body').evaluate(el=>{el.scrollTop=0;});assert.ok(Math.abs(initial.y-(await bounds()).y)<1);
  await page.setViewportSize({width:390,height:430});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.locator('.report-body').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  const short=await bounds();assert.ok(short.y>=0&&short.y+short.height<=430,'footer remains inside a short viewport');
});

test('Done recognizes before report creation and send retry retains exact audio',async t=>{
  const {page,open,recording,post,kitBase,auth,done}=await fixture(t);await open();await recording();
  let attempts=0,firstAudio;
  await page.route('**/api/reports',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    const data=route.request().postDataJSON();assert.ok(data.audio?.startsWith('data:audio/webm;base64,'));
    if(++attempts===1){firstAudio=data.audio;await new Promise(r=>setTimeout(r,180));return route.abort();}
    assert.equal(data.audio,firstAudio,'retry must reuse the completed recording');await route.continue();
  });
  // Delay final FileReader so a second click arrives while completion is pending.
  await page.evaluate(()=>{const read=FileReader.prototype.readAsDataURL;FileReader.prototype.readAsDataURL=function(...args){setTimeout(()=>read.apply(this,args),150);};});
  await done();assert.equal(attempts,0);
  await page.getByRole('button',{name:'Отправить',exact:true}).click();
  await page.getByRole('button',{name:'Отправить',exact:true}).dispatchEvent('click');
  await page.getByText(/Данные остались в форме/).waitFor();assert.equal(attempts,1);
  assert.equal(await page.evaluate(()=>voiceStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
  const audio=await page.locator('.voice-input audio').getAttribute('src');assert.ok(audio?.startsWith('blob:'));
  const response=post();await page.getByRole('button',{name:'Отправить',exact:true}).click();const res=await response;assert.equal(res.status(),201);const {id}=await res.json();
  const stored=await fetch(`${kitBase}/api/reports/${id}/audio`,{headers:auth});assert.equal(stored.status,200);
  const original=Buffer.from(firstAudio.split(',')[1],'base64');assert.deepEqual(Buffer.from(await stored.arrayBuffer()),original);
  assert.ok(original.length>100);assert.equal(attempts,2);await page.locator('.report-card').waitFor({state:'detached'});
});

test('Done during pending microphone permission recognizes without sending',async t=>{
  const {page,open,post,done,app}=await fixture(t);await open();
  await page.evaluate(()=>{const get=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async(...args)=>{await new Promise(r=>setTimeout(r,180));return get(...args);};});
  await page.getByRole('button',{name:'Записать голос',exact:true}).click();
  await done();assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);
  assert.equal(await page.evaluate(()=>voiceStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
});

test('failed final audio read never sends a text-only report and the form recovers',async t=>{
  const {page,open,recording,post,done,ready}=await fixture(t);await open();await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').fill('TEST completion failure');await recording();
  let posts=0;page.on('request',r=>{if(r.url().endsWith('/api/reports')&&r.method()==='POST')posts++;});
  await page.evaluate(()=>{const Original=window.FileReader;window.FileReader=class extends Original{readAsDataURL(){window.FileReader=Original;queueMicrotask(()=>this.onerror(new Event('error')));}};});
  await page.getByRole('button',{name:'Готово',exact:true}).click();await page.locator('#bug-kit-report-status').filter({hasText:'Не удалось прочитать запись'}).waitFor();
  assert.equal(posts,0);assert.equal(await page.getByRole('button',{name:'Отправить',exact:true}).isEnabled(),true);assert.equal(await page.getByPlaceholder('Суть бага, шаги для воспроизведения и что ожидалось').inputValue(),'TEST completion failure');
  assert.equal(await page.evaluate(()=>voiceStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
  await recording();await done();const response=post();await page.getByRole('button',{name:'Отправить',exact:true}).click();assert.equal((await response).status(),201);
});

test('manual stop waits for final audio then recognizes before sending',async t=>{
  const {page,open,recording,post,done,ready}=await fixture(t);await open();await recording();await page.waitForTimeout(200);
  await page.evaluate(()=>{const read=FileReader.prototype.readAsDataURL;FileReader.prototype.readAsDataURL=function(...args){setTimeout(()=>read.apply(this,args),200);};});
  await page.getByRole('button',{name:'Остановить запись',exact:true}).click();
  await ready();const response=post();await page.getByRole('button',{name:'Отправить',exact:true}).click();const res=await response;assert.equal(res.status(),201);assert.ok(res.request().postDataJSON().audio);
});

test('destroy during final audio read stops tracks and never sends the detached form',async t=>{
  const {page,open,recording}=await fixture(t);await open();await recording();await page.waitForTimeout(200);
  let posts=0;page.on('request',r=>{if(r.url().endsWith('/api/reports')&&r.method()==='POST')posts++;});
  await page.evaluate(()=>{const read=FileReader.prototype.readAsDataURL;FileReader.prototype.readAsDataURL=function(...args){setTimeout(()=>read.apply(this,args),200);};});
  await page.getByRole('button',{name:'Готово',exact:true}).click();await page.evaluate(()=>BugReportKit.instance.destroy());
  await page.waitForTimeout(300);assert.equal(posts,0);assert.equal(await page.locator('.report-card').count(),0);
  assert.equal(await page.evaluate(()=>voiceStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);
});


test('WebKit mobile encodes and sends active voice; footer remains visible',async t=>{
  const {page,open,recording,post,kitBase,auth,done}=await fixture(t,webkit);await open();
  const before=await page.locator('.report-footer .primary').boundingBox();await recording();
  const during=await page.locator('.report-footer .primary').boundingBox();assert.ok(Math.abs(before.y-during.y)<1);assert.ok(during.y+during.height<=699);
  await page.waitForTimeout(350);await done();const response=post();await page.getByRole('button',{name:'Отправить',exact:true}).click();const res=await response;assert.equal(res.status(),201);
  const original=Buffer.from(res.request().postDataJSON().audio.split(',')[1],'base64');const {id}=await res.json();
  const audio=await fetch(`${kitBase}/api/reports/${id}/audio`,{headers:auth});assert.equal(audio.status,200);assert.deepEqual(Buffer.from(await audio.arrayBuffer()),original);assert.ok(original.length>100);
  assert.equal(await page.evaluate(()=>voiceStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true);await page.locator('.report-card').waitFor({state:'detached'});
});

for (const [name,engine] of [['Chromium',chromium],['WebKit',webkit]]) {
  test(`compact voice controls immediately follow the screenshot in mobile ${name}`,async t=>{
    const {page,open,recording}=await fixture(t,engine);await open(true);
    const state=await page.locator('.report-body').evaluate(body=>({order:[...body.children].map(el=>el.className),background:getComputedStyle(body.querySelector('.voice-input')).backgroundColor}));
    assert.deepEqual(state.order.slice(0,3),['preview-frame','voice-input','report-fields']);
    assert.equal(state.background,'rgba(0, 0, 0, 0)','voice belongs to a compact row, not a separate panel');
    const record=page.getByRole('button',{name:'Записать голос',exact:true});assert.equal(await record.locator('svg').count(),1);
    const button=await record.boundingBox();assert.equal(button.width,44);assert.equal(button.height,44);
    const preview=await page.locator('.preview-frame').boundingBox();assert.ok(button.y>=preview.y+preview.height&&button.y-preview.y-preview.height<30);
    const send=page.locator('.report-footer .primary');const initial=await send.boundingBox();
    await recording();const stop=page.getByRole('button',{name:'Остановить запись',exact:true});assert.equal(await stop.getAttribute('aria-pressed'),'true');
    await page.getByText(/Идёт запись: 0:0[1-9] \/ 2:00/).waitFor();assert.ok(Math.abs(initial.y-(await send.boundingBox()).y)<1);
    await stop.click();await page.getByText('Запись готова. Можно прослушать.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Перезаписать голос',exact:true}).getAttribute('aria-pressed'),'false');
    await page.getByRole('button',{name:'Удалить запись',exact:true}).click();await page.getByText('Голосом · до 2 мин',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Записать голос',exact:true}).isEnabled(),true);
  });
}


test('same-origin draft ASR keeps one live field, merges concurrent typing and stores corrected text separately',async t=>{
 const {page,open,recording,done,post,app}=await fixture(t,chromium,{delay:800},true);await open();
 const input=page.locator('.report-fields textarea'),send=page.getByRole('button',{name:'Отправить',exact:true});
 assert.equal(await input.count(),1);assert.equal(await send.isDisabled(),true);
 const style=()=>send.evaluate(el=>{const s=getComputedStyle(el);return {opacity:s.opacity,shadow:s.boxShadow,background:s.backgroundColor,cursor:s.cursor,height:el.getBoundingClientRect().height};});
 const disabled=await style();assert.equal(disabled.opacity,'0.45');assert.equal(disabled.shadow,'none');assert.equal(disabled.cursor,'not-allowed');
 await send.hover();assert.equal((await style()).background,disabled.background);
 await input.fill('Проверка доступной кнопки');const enabled=await style();assert.equal(enabled.opacity,'1');assert.notEqual(enabled.shadow,'none');assert.equal(enabled.height,disabled.height);
 await input.fill('   ');assert.equal(await send.isDisabled(),true);await input.fill('До записи');
 await input.evaluate(el=>{window.originalDescription=el;});
 await recording();await page.getByRole('button',{name:'Готово',exact:true}).click();
 await page.getByText('Идёт расшифровка…',{exact:true}).waitFor();
 await input.fill('Изменено во время ожидания');
 await page.getByText('Расшифровка добавлена. Проверьте текст перед отправкой.',{exact:true}).waitFor();
 assert.equal(await input.evaluate(el=>el===window.originalDescription),true);
 assert.equal(await input.inputValue(),'Изменено во время ожидания\n\nTEST распознанные слова');
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);
 await input.fill('Исправленный текст с ожиданием');const pending=post();await send.click();const {id}=await(await pending).json();
 assert.equal(app.db.prepare('SELECT description FROM reports WHERE id=?').get(id).description,'Исправленный текст с ожиданием');
 assert.equal(app.audio.metadata(id).transcription.text,'TEST распознанные слова');
});

test('ASR overflow preserves entire text until shortening; empty remains disabled even with audio',async t=>{
 const text='я'.repeat(4500);const {page,open,recording,done,post,app}=await fixture(t,chromium,{text});await open();await recording();await done();
 const input=page.locator('.report-fields textarea'),send=page.getByRole('button',{name:'Отправить',exact:true});
 assert.equal((await input.inputValue()).length,4500);assert.equal(await send.isDisabled(),true);
 assert.match(await page.locator('#bug-kit-description-count').textContent(),/4500.*сократите/);
 await input.fill('');assert.equal(await send.isDisabled(),true);await input.fill('Сокращено пользователем');
 const pending=post();await send.click();const {id}=await(await pending).json();assert.equal(app.audio.metadata(id).transcription.text.length,4500);
});

test('failed ASR retains original and typed text; retry recognizes without creating a report',async t=>{
 const {page,open,recording,app,script}=await fixture(t,chromium,{fail:true});await open();
 const input=page.locator('.report-fields textarea');await input.fill('Мой текст');await recording();await page.getByRole('button',{name:'Готово',exact:true}).click();
 const retry=page.getByRole('button',{name:'Повторить распознавание',exact:true});await retry.waitFor();
 assert.equal(await input.inputValue(),'Мой текст');assert.equal(await page.locator('.voice-input audio').isVisible(),true);
 assert.equal(await page.locator('#bug-kit-transcription-status').isHidden(),true,'failed ASR must stop the spinner');
 await input.fill('');assert.equal(await page.getByRole('button',{name:'Отправить',exact:true}).isDisabled(),true);
 writeFileSync(script,"import{writeFileSync}from'node:fs';writeFileSync(process.argv[3],'После повтора');");await retry.click();
 await page.getByText('Расшифровка добавлена. Проверьте текст перед отправкой.',{exact:true}).waitFor();assert.equal(await input.inputValue(),'После повтора');
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);
});

test('cancel during recognition removes draft and prevents late edits or report creation',async t=>{
 const {page,open,recording,app}=await fixture(t,chromium,{delay:1500});await open();
 const input=page.locator('.report-fields textarea');await input.fill('Сохранённый текст');await input.evaluate(el=>window.cancelledDescription=el);
 await recording();await page.getByRole('button',{name:'Готово',exact:true}).click();await page.getByText('Идёт расшифровка…',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Отмена',exact:true}).click();await page.waitForTimeout(1800);
 assert.equal(await page.locator('.report-card').count(),0);assert.equal(await page.evaluate(()=>window.cancelledDescription.value),'Сохранённый текст');
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM transcription_drafts').get().n,0);assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);
});


test('polling network failure permits manual text send while stopping the abandoned ASR job',async t=>{
 const {page,open,recording,post,app}=await fixture(t,chromium,{delay:2500});await open();
 const input=page.locator('.report-fields textarea');await input.fill('Ручное описание и ожидание');
 await page.route('**/api/transcription-drafts/*/status',route=>route.abort());await recording();await page.getByRole('button',{name:'Готово',exact:true}).click();
 await page.getByRole('button',{name:'Повторить распознавание',exact:true}).waitFor();
 const pending=post();await page.getByRole('button',{name:'Отправить',exact:true}).click();const response=await pending;assert.equal(response.status(),201);const {id}=await response.json();
 assert.equal(app.audio.metadata(id).transcription.state,'failed');assert.equal(app.audio.metadata(id).audioAvailable,true);
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM transcription_drafts').get().n,0);
});


test('expired ready draft recovers final send with original audio and reviewed text intact',async t=>{
 const {page,open,recording,done,post,app}=await fixture(t);await open();await recording();await done();
 const input=page.locator('.report-fields textarea');await input.fill('Проверенный текст после ожидания');
 const original=await page.locator('.voice-input audio').getAttribute('src');app.db.prepare('UPDATE transcription_drafts SET expires_at=0').run();
 await page.getByRole('button',{name:'Отправить',exact:true}).click();await page.getByText(/Черновик распознавания истёк.*нажмите/).waitFor();
 assert.equal(await input.inputValue(),'Проверенный текст после ожидания');assert.equal(await page.locator('.voice-input audio').getAttribute('src'),original);
 const pending=post();await page.getByRole('button',{name:'Отправить',exact:true}).click();const response=await pending;assert.equal(response.status(),201);const {id}=await response.json();
 assert.equal(app.audio.metadata(id).audioAvailable,true);assert.equal(app.db.prepare('SELECT description FROM reports WHERE id=?').get(id).description,'Проверенный текст после ожидания');
});

test('lost status response resumes a ready draft without retrying ASR or appending text twice',async t=>{
 const {page,open,recording,app}=await fixture(t);await open();let creates=0,retries=0;
 page.on('request',req=>{if(req.url().endsWith('/api/transcription-drafts'))creates++;if(req.url().endsWith('/retry'))retries++;});
 await page.route('**/api/transcription-drafts/*/status',route=>route.abort());await recording();await page.getByRole('button',{name:'Готово',exact:true}).click();
 const retry=page.getByRole('button',{name:'Повторить распознавание',exact:true});await retry.waitFor();await page.unroute('**/api/transcription-drafts/*/status');await retry.click();
 await page.getByText('Расшифровка добавлена. Проверьте текст перед отправкой.',{exact:true}).waitFor();
 assert.equal(await page.locator('.report-fields textarea').inputValue(),'TEST распознанные слова');assert.equal(creates,1);assert.equal(retries,0);
 assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);assert.equal(await page.locator('#bug-kit-report-status').getAttribute('class'),'meta');
});


test('speech feedback remains visible with a blue spinner then confirms insertion in mobile browsers',async t=>{
 for(const [name,engine] of [['Chromium',chromium],['WebKit',webkit]])await t.test(name,async t=>{
  const {page,open,recording,ready,app}=await fixture(t,engine,{delay:800});await open(true);
  const notice=page.locator('#bug-kit-transcription-status'),input=page.locator('.report-fields textarea');
  assert.equal(await notice.isHidden(),true);
  let release;const gate=new Promise(r=>release=r);t.after(()=>release());
  await page.route('**/api/transcription-drafts/*/status',async route=>{await gate;await route.continue();});
  await recording();await page.getByRole('button',{name:'Готово',exact:true}).click();
  await page.getByText('Идёт расшифровка…',{exact:true}).waitFor();
  assert.equal(await notice.getAttribute('role'),'status');assert.equal(await notice.getAttribute('aria-live'),'polite');
  const spinner=await notice.locator('.speech-icon').evaluate(el=>{const s=getComputedStyle(el);return {color:s.borderTopColor,radius:s.borderTopLeftRadius,animation:s.animationName,hidden:el.getAttribute('aria-hidden')};});
  assert.equal(spinner.color,'rgb(32, 71, 217)');assert.equal(spinner.radius,'50%');assert.equal(spinner.animation,'speech-turn');assert.equal(spinner.hidden,'true');
  const visible=async()=>{await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const r=await notice.boundingBox(),f=await page.locator('.report-footer').boundingBox();assert.ok(r.y>=0&&r.y+r.height<=f.y,'speech feedback must stay above the footer');};
  await input.fill('Ручной текст');await page.locator('.report-body').evaluate(el=>el.scrollTop=el.scrollHeight);await visible();
  if(process.env.KIT_UI_EVIDENCE)await page.screenshot({path:join(process.env.KIT_UI_EVIDENCE,name+'-pending.png')});
  await page.setViewportSize({width:390,height:430});await visible();assert.equal(await page.getByRole('button',{name:'Отправить',exact:true}).isDisabled(),true);
  release();await ready();await visible();assert.equal(await notice.getAttribute('data-state'),'ready');
  assert.equal(await notice.locator('.speech-icon').textContent(),'✓');assert.equal(await notice.locator('.speech-icon').evaluate(el=>getComputedStyle(el).animationName),'none');
  assert.equal(await input.inputValue(),'Ручной текст\n\nTEST распознанные слова');
  await page.setViewportSize({width:390,height:699});if(process.env.KIT_UI_EVIDENCE)await page.screenshot({path:join(process.env.KIT_UI_EVIDENCE,name+'-ready.png')});
  await page.getByRole('button',{name:'Перезаписать голос',exact:true}).click();assert.equal(await notice.isHidden(),true,'new recording clears old success');
  await page.getByRole('button',{name:'Остановить запись',exact:true}).waitFor();await page.waitForTimeout(200);await page.getByRole('button',{name:'Остановить запись',exact:true}).click();await ready();
  await page.getByRole('button',{name:'Удалить запись',exact:true}).click();assert.equal(await notice.isHidden(),true);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM reports').get().n,0);
 });
});
