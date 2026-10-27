import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium, webkit} from 'playwright';

for (const [name, engine] of Object.entries({chromium, webkit})) {
  test(`early loader lifecycle (${name})`, async t => {
    const server = createServer((req,res) => {
      if (req.url === '/check-ready.js') {res.setHeader('Content-Type','text/javascript');res.end('window.initialReady=window.BugReportKitLoader.instance.ready;window.initialReady.then(()=>window.initialReadyResolved=true,()=>window.initialReadyResolved=false);');return;}
      const asset = {'/loader.js':'dist/loader.js','/widget.js':'dist/widget.js','/widget.css':'widget/widget.css'}[req.url];
      if (asset) {
        res.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : 'text/javascript');
        let body = readFileSync(asset,'utf8');
        if (req.url === '/widget.js') body += `;{const init=window.BugReportKit.init;window.BugReportKit.init=options=>{window.received=options;return init(options)}}`;
        res.end(body); return;
      }
      res.setHeader('Content-Type','text/html');
      res.setHeader('Content-Security-Policy', "script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'");
      res.end(`<!doctype html><head><meta name="app-version" content="meta-version">${req.url === '/head' ? '' : '</head><body>'}<script src="/loader.js" data-project-key="test" data-reporter-auth="true" data-reporter-name="Alice" data-reporter-contact="alice@example.test" data-capture-fetch-errors="true" data-launcher-style="compact" data-label="Report"></script>${req.url === '/head' ? '<script src="/check-ready.js"></script></head><body>' : ''}`);
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const browser = await engine.launch({headless:true});
    t.after(() => browser.close());
    const page = await browser.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.addInitScript(() => {
      window.violations=[];
      document.addEventListener('securitypolicyviolation',e=>window.violations.push(e.violatedDirective));
    });
    const helper = page.locator('[data-rr-kit-loading]');
    const append = () => page.evaluate(() => new Promise((resolve,reject) => {const s=document.createElement('script');s.src='/loader.js';s.dataset.projectKey='different';s.onload=resolve;s.onerror=reject;document.body.append(s);}));

    let releaseJs, releaseCss;
    const heldJs = new Promise(resolve=>releaseJs=resolve), heldCss = new Promise(resolve=>releaseCss=resolve);
    await page.route('**/widget.js', async route => {await heldJs;await route.continue();});
    await page.route('**/widget.css', async route => {await heldCss;await route.continue();});
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await helper.waitFor({state:'visible'});
    await helper.locator('button').click();
    assert.equal(await page.locator('.overlay').count(),0);
    await page.evaluate(()=>window.originalLoader=window.BugReportKitLoader.instance);
    await append();
    await page.waitForFunction(()=>document.querySelectorAll('script[src="/loader.js"]').length===2);
    assert.equal(await helper.count(),1);
    releaseJs();
    await page.locator('[data-bug-report-kit]').waitFor({state:'attached'});
    assert.equal(await page.locator('[data-bug-report-kit]').evaluate(el=>el.style.visibility),'hidden');
    assert.equal(await helper.isVisible(),true,'helper remains while CSS is held');
    releaseCss();
    await page.evaluate(()=>window.BugReportKitLoader.instance.ready);
    assert.equal(await helper.count(),0);
    assert.equal(await page.locator('.overlay').count(),0,'early click does not open a form later');
    assert.deepEqual(await page.evaluate(()=>({same:window.originalLoader===window.BugReportKitLoader.instance,
      projectKey:received.projectKey, serverUrl:received.serverUrl, reporterAuth:received.reporterAuth,
      reporterName:received.reporterName, reporterContact:received.reporterContact, captureFetchErrors:received.captureFetchErrors,
      appVersion:received.appVersion,label:received.label, launcherStyle:received.launcherStyle, violations:window.violations})),
    {same:true,projectKey:'test',serverUrl:origin,reporterAuth:true,reporterName:'Alice',reporterContact:'alice@example.test',captureFetchErrors:true,appVersion:'meta-version',label:'Report',launcherStyle:'compact',violations:[]});
    // Active report state is untouched by another embed.
    await page.evaluate(()=>{window.sdk=window.BugReportKit.instance;const input=document.createElement('textarea');input.value='unfinished report';input.id='draft';document.querySelector('[data-bug-report-kit]').shadowRoot.append(input);});
    await append();
    await page.waitForFunction(()=>document.querySelectorAll('script[src="/loader.js"]').length===3);
    assert.equal(await page.evaluate(()=>window.sdk===window.BugReportKit.instance),true);
    assert.equal(await page.locator('#draft').inputValue(),'unfinished report');
    await page.evaluate(()=>window.BugReportKitLoader.instance.destroy());
    assert.equal(await page.locator('[data-bug-report-kit]').count(),0);

    await page.unroute('**/widget.js'); await page.unroute('**/widget.css');
    let attempts=0;
    await page.route('**/widget.js', route => ++attempts===1 ? route.abort() : route.continue());
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await page.locator('[data-rr-kit-loading][data-error]').waitFor();
    await helper.locator('button').click();
    await page.evaluate(()=>window.BugReportKitLoader.instance.ready);
    assert.equal(attempts,2);
    assert.equal(await helper.count(),0);

    // CSS failure also retains an explicit retry path.
    await page.unroute('**/widget.js');
    let cssAttempts=0;
    await page.route('**/widget.css',route=>++cssAttempts===1 ? route.abort() : route.continue());
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await page.locator('[data-rr-kit-loading][data-error]').waitFor();
    await helper.locator('button').click();
    await page.evaluate(()=>window.BugReportKitLoader.instance.ready);
    assert.equal(cssAttempts,2);
    assert.equal(await helper.count(),0);
    await page.unroute('**/widget.css');

    // Timeout rejects ready and allows retry without late SDK auto-init.
    await page.unroute('**/widget.js');
    let releaseTimeout;
    const timedOut = new Promise(resolve=>releaseTimeout=resolve);
    await page.route('**/widget.js',async route=>{await timedOut;await route.continue().catch(()=>{});});
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await page.locator('[data-rr-kit-loading][data-error]').waitFor({timeout:20000});
    assert.equal(await page.evaluate(()=>window.BugReportKitLoader.instance.ready.then(()=>false,error=>error.message==='Kit loader timeout')),true);
    releaseTimeout();
    await page.waitForLoadState('load');
    assert.equal(await page.locator('[data-bug-report-kit]').count(),0);
    await page.unroute('**/widget.js');
    await helper.locator('button').click();
    await page.evaluate(()=>window.BugReportKitLoader.instance.ready);
    assert.equal(await helper.count(),0);

    // A pending script completing after destroy must never create an instance.
    await page.unroute('**/widget.js');
    let releaseLate;
    const late = new Promise(resolve=>releaseLate=resolve);
    await page.route('**/widget.js',async route=>{await late;await route.continue().catch(()=>{});});
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await helper.waitFor();
    await page.evaluate(()=>window.BugReportKitLoader.instance.destroy());
    releaseLate();
    await page.waitForLoadState('load');
    assert.equal(await page.locator('[data-bug-report-kit],[data-rr-kit-loading]').count(),0);
    assert.equal(await page.evaluate(()=>Boolean(window.BugReportKit?.instance)),false);

    // CSS wait cleanup removes only the loader-owned instance.
    await page.unroute('**/widget.js');
    let releaseLateCss;
    const lateCss = new Promise(resolve=>releaseLateCss=resolve);
    await page.route('**/widget.css',async route=>{await lateCss;await route.continue().catch(()=>{});});
    await page.goto(origin,{waitUntil:'domcontentloaded'});
    await page.locator('[data-bug-report-kit]').waitFor({state:'attached'});
    await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
    releaseLateCss();
    await page.waitForLoadState('load');
    assert.equal(await page.locator('[data-bug-report-kit],[data-rr-kit-loading]').count(),0);
    await page.unroute('**/widget.css');

    // An independently initialized SDK is preserved by loader destroy.
    await page.goto(origin,{waitUntil:'load'});
    await page.evaluate(async()=>{await window.BugReportKitLoader.instance.ready;window.BugReportKitLoader.instance.destroy();window.external=window.BugReportKit.init({serverUrl:location.origin,projectKey:'external'});window.BugReportKit.instance=window.external;});
    await append();
    await page.waitForFunction(()=>Boolean(window.BugReportKitLoader.instance));
    await page.evaluate(async()=>{await window.BugReportKitLoader.instance.ready;window.BugReportKitLoader.instance.destroy();});
    assert.equal(await page.evaluate(()=>window.BugReportKit.instance===window.external),true);
    assert.equal(await page.locator('[data-bug-report-kit]').count(),1);
    await page.goto(origin+'/head');
    await page.waitForFunction(()=>window.initialReadyResolved===true);
    assert.equal(await page.locator('[data-bug-report-kit]').count(),1,'head embed exposes a ready promise before body exists');
  });
}
