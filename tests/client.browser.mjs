import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';

test('shared SPA client preserves ownership and separate work/personal configurations', async t => {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/^\/bug-kit(?=\/)/, '');
    const assets = {'/voice.mjs':'widget/voice.js', '/client.mjs': 'dist/client.mjs', '/loader.js': 'dist/loader.js',
      '/widget.js': 'dist/widget.js', '/widget.css': 'widget/widget.css'};
    res.setHeader('Cache-Control', 'no-store');
    if (assets[pathname]) {
      res.setHeader('Content-Type', pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      let body = readFileSync(assets[pathname], 'utf8');
      if (pathname === '/widget.js') body += ';{const init=window.BugReportKit.init;window.BugReportKit.init=o=>{window.received=o;return init(o)}}';
      res.end(body); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><p>TEST isolated client</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true});
  t.after(async () => {await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function pageFor(run) {
    const page = await browser.newPage();
    try {
      await page.goto(origin);
      await page.evaluate(async () => {window.api = await import('/client.mjs'); window.config = {serverUrl: location.origin, projectKey: 'work-public', voiceEnabled: false};});
      await run(page);
    } finally {await page.close();}
  }
  const acquire = page => page.evaluate(() => {window.a = api.acquireKit(config);});
  const ready = page => page.evaluate(() => a.ready);

  await t.test('leases share one instance; last release cleans; duplicate release is harmless', () => pageFor(async page => {
    await acquire(page); await ready(page);
    assert.deepEqual(await page.evaluate(async () => {
      const sdk = window.BugReportKit.instance;
      const b = api.acquireKit(config); await b.ready;
      a.release(); a.release(); await Promise.resolve();
      const kept = sdk === window.BugReportKit.instance;
      b.release(); await Promise.resolve();
      return {kept, remaining: document.querySelectorAll('[data-bug-report-kit]').length};
    }), {kept: true, remaining: 0});
  }));
  await t.test('StrictMode re-entry keeps SDK and unfinished report state', () => pageFor(async page => {
    await acquire(page); await ready(page);
    assert.equal(await page.evaluate(async () => {
      const sdk = window.BugReportKit.instance;
      const host = document.querySelector('[data-bug-report-kit]');
      const draft = document.createElement('textarea'); draft.value = 'TEST unfinished report'; host.shadowRoot.append(draft);
      a.release(); const b = api.acquireKit(config); await b.ready;
      return sdk === window.BugReportKit.instance && draft.value === 'TEST unfinished report' && draft.isConnected;
    }), true);
  }));
  await t.test('two shipped module copies share the same client state', () => pageFor(async page => {
    await acquire(page); await ready(page);
    assert.equal(await page.evaluate(async () => {
      const sdk = window.BugReportKit.instance;
      const other = await import('/client.mjs?second-bundle');
      const b = other.acquireKit(config); await b.ready;
      a.release(); await Promise.resolve(); return sdk === window.BugReportKit.instance;
    }), true);
  }));
  await t.test('incompatible endpoints, keys, flags, callbacks and nonce never change active owner', () => pageFor(async page => {
    await acquire(page); await ready(page);
    const result = await page.evaluate(() => {
      const sdk = window.BugReportKit.instance;
      const changes = [{serverUrl: location.origin+'/bug-kit'}, {projectKey: 'personal-public'},
        {voiceEnabled: true}, {reporterAuth: true}, {captureFetchErrors: true}, {appVersion: 'other'},
        {label: 'other'}, {launcherStyle: 'other'}, {reporterName: 'other'}, {reporterContact: 'other'},
        {getReporter: () => ({name: 'other'})}];
      const failures = changes.map(change => {try {api.acquireKit({...config, ...change}); return false;} catch {return true;}});
      try {api.acquireKit(config, {nonce: 'other'}); failures.push(false);} catch {failures.push(true);}
      return {allRejected: failures.every(Boolean), same: sdk === window.BugReportKit.instance};
    });
    assert.deepEqual(result, {allRejected: true, same: true});
  }));
  await t.test('latest user is read from stable reporter provider', () => pageFor(async page => {
    await page.evaluate(() => {window.user = {id:'one',name:'First'}; window.provider = () => user; config.getReporter = provider; a = api.acquireKit(config);});
    await ready(page);
    assert.deepEqual(await page.evaluate(() => {user = {id:'two',name:'Second'}; return received.getReporter();}), {id:'two',name:'Second'});
  }));
  await t.test('unknown pre-existing loader and SDK are rejected and preserved', () => pageFor(async page => {
    assert.deepEqual(await page.evaluate(() => {
      let destroyed = 0;
      const foreign = {destroy: () => destroyed++};
      window.BugReportKit = {instance: foreign};
      let sdkRejected = false; try {api.acquireKit(config);} catch {sdkRejected = true;}
      const sdkKept = window.BugReportKit.instance === foreign; delete window.BugReportKit.instance;
      window.BugReportKitLoader = {instance: foreign};
      let loaderRejected = false; try {api.acquireKit(config);} catch {loaderRejected = true;}
      return {sdkRejected, loaderRejected, sdkKept, loaderKept: window.BugReportKitLoader.instance === foreign, destroyed};
    }), {sdkRejected: true, loaderRejected: true, sdkKept: true, loaderKept: true, destroyed: 0});
  }));
  await t.test('importing a second module is side-effect-free for an existing foreign API', () => pageFor(async page => {
    assert.deepEqual(await page.evaluate(async () => {
      const foreignInit = () => {}, foreignInstance = {destroy() {}};
      const foreign = {init:foreignInit,instance:foreignInstance};window.BugReportKitLoader=foreign;
      const other = await import('/client.mjs?foreign-before-import');
      let rejected=false;try{other.acquireKit(config);}catch{rejected=true;}
      return {sameObject:window.BugReportKitLoader===foreign,sameInit:window.BugReportKitLoader.init===foreignInit,sameInstance:window.BugReportKitLoader.instance===foreignInstance,rejected};
    }), {sameObject:true,sameInit:true,sameInstance:true,rejected:true});
  }));
  await t.test('BFCache events preserve a real editable form and submission after return', () => pageFor(async page => {
    await acquire(page);await ready(page);
    await page.route('**/api/reports',async route=>{
      await page.evaluate(body=>window.sentReport=body,route.request().postDataJSON());
      await route.fulfill({status:201,contentType:'application/json',body:'{"id":"test-only"}'});
    });
    await page.getByRole('button',{name:'Сообщить о баге',exact:true}).click();
    await page.getByRole('button',{name:'Продолжить без снимка',exact:true}).click();
    await page.locator('.report-fields textarea').fill('TEST BFCache draft');
    assert.equal(await page.evaluate(async () => {
      const sdk=window.BugReportKit.instance;
      window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
      const b=api.acquireKit(config);await b.ready;b.release();
      return window.BugReportKit.instance===sdk;
    }),true);
    assert.equal(await page.locator('.report-fields textarea').inputValue(),'TEST BFCache draft');
    await page.getByRole('button',{name:'Отправить',exact:true}).click();
    await page.waitForFunction(()=>Boolean(window.sentReport),{},{timeout:2000});
    assert.equal(await page.evaluate(()=>sentReport.description),'TEST BFCache draft');
  }));
  await t.test('late microphone permission after BFCache cannot start recording or alter a newer attempt', () => pageFor(async page => {
    assert.deepEqual(await page.evaluate(async () => {
      const {voiceInput}=await import('/voice.mjs');
      const requests=[];let stopped=0,started=0;
      Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise(resolve=>requests.push(resolve))}});
      window.MediaRecorder=class {static isTypeSupported(){return true} state='inactive';start(){started++;this.state='recording'}stop(){this.state='inactive'}};
      const voice=voiceInput({enabled:true});document.body.append(voice.element);
      const button=voice.element.querySelector('button');button.click();
      window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));
      const enabledAfterReturn=!button.disabled;
      button.click();
      requests[0]({getTracks:()=>[{stop(){stopped++}}]});await Promise.resolve();await Promise.resolve();
      const afterOld={started,stopped,busy:voice.busy()};
      requests[1]({getTracks:()=>[{stop(){stopped++}}]});await Promise.resolve();await Promise.resolve();
      const afterNew={started,busy:voice.busy()};voice.dispose();
      return {enabledAfterReturn,afterOld,afterNew};
    }),{enabledAfterReturn:true,afterOld:{started:0,stopped:1,busy:true},afterNew:{started:1,busy:true}});
  }));
  await t.test('a foreign SDK appearing during network load is not adopted or destroyed', () => pageFor(async page => {
    let release; const gate = new Promise(resolve => release = resolve);
    await page.route('**/widget.js', async route => {await gate; await route.continue().catch(() => {});});
    await acquire(page);
    await page.evaluate(() => {window.foreign = {destroy() {window.foreignDestroyed = true;}}; window.BugReportKit = {...window.BugReportKit, instance: foreign};});
    release();
    assert.equal(await page.evaluate(() => a.ready.then(() => false, () => true)), true);
    assert.deepEqual(await page.evaluate(async () => {a.release(); await Promise.resolve(); return {kept: window.BugReportKit.instance === foreign, destroyed: Boolean(window.foreignDestroyed)};}), {kept: true, destroyed: false});
  }));
  await t.test('final release while JS is pending cannot resurrect a late widget', () => pageFor(async page => {
    let release; const gate = new Promise(resolve => release = resolve);
    await page.route('**/widget.js', async route => {await gate; await route.continue().catch(() => {});});
    await acquire(page);
    const request = page.waitForResponse('**/widget.js').catch(() => null);
    await page.evaluate(async () => {a.release(); await Promise.resolve();}); release(); await request;
    assert.equal(await page.locator('[data-bug-report-kit]').count(), 0);
    assert.equal(await page.locator('[data-rr-kit-loading]').count(), 0);
  }));
  await t.test('final release while CSS is pending removes only its own SDK and indicator', () => pageFor(async page => {
    let release;const gate=new Promise(resolve=>release=resolve);
    await page.route('**/widget.css',async route=>{await gate;await route.continue().catch(()=>{});});
    await acquire(page);await page.locator('[data-bug-report-kit]').waitFor({state:'attached'});
    const response=page.waitForResponse('**/widget.css').catch(()=>null);
    await page.evaluate(async()=>{a.release();await Promise.resolve();});release();await response;
    assert.equal(await page.locator('[data-bug-report-kit]').count(),0);
    assert.equal(await page.locator('[data-rr-kit-loading]').count(),0);
  }));
  await t.test('retry before body remains attached to the original readiness promise', () => pageFor(async page => {
    assert.equal(await page.evaluate(async () => {
      document.body.remove();
      const early=api.acquireKit(config), before=early.ready, after=early.retry();
      document.documentElement.append(document.createElement('body'));
      document.dispatchEvent(new Event('DOMContentLoaded'));
      await Promise.all([before,after]);
      return before===after && document.querySelectorAll('[data-bug-report-kit]').length===1;
    }),true);
  }));
  await t.test('retry resolves the current ready; released handles cannot retry the next generation', () => pageFor(async page => {
    let calls = 0;
    await page.route('**/widget.js', route => ++calls === 1 ? route.abort() : route.continue());
    await acquire(page); assert.equal(await page.evaluate(() => a.ready.then(() => false, () => true)), true);
    await page.evaluate(() => a.retry());
    assert.equal(await page.locator('[data-bug-report-kit]').count(), 1);
    assert.equal(await page.evaluate(async () => {
      a.release(); const next = api.acquireKit({...config, projectKey:'personal-public'}); await next.ready;
      try {a.retry(); return false;} catch {return received.projectKey === 'personal-public';}
    }), true);
  }));
  await t.test('personal same-origin prefix and voice remain separate from work settings', async () => {
    const work = await browser.newPage(), personal = await browser.newPage();
    try {
      await Promise.all([work.goto(origin),personal.goto(origin)]);
      await work.evaluate(async () => {const {acquireKit} = await import('/client.mjs');window.lease=acquireKit({projectKey:'work-public',voiceEnabled:false});await lease.ready;});
      await personal.evaluate(async () => {const {acquireKit} = await import('/bug-kit/client.mjs');window.lease=acquireKit({serverUrl:'/bug-kit',projectKey:'personal-public',voiceEnabled:true});await lease.ready;});
      assert.deepEqual(await work.evaluate(() => ({key:received.projectKey,voice:received.voiceEnabled,url:received.serverUrl})), {key:'work-public',voice:false,url:origin});
      assert.deepEqual(await personal.evaluate(() => ({key:received.projectKey,voice:received.voiceEnabled,url:received.serverUrl})), {key:'personal-public',voice:true,url:origin+'/bug-kit'});
      await personal.evaluate(async () => {lease.release();await Promise.resolve();});
      assert.equal(await work.locator('[data-bug-report-kit]').count(),1);
    } finally {await work.close();await personal.close();}
  });
});
