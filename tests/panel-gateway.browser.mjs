import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {chromium} from 'playwright';
import {createApp} from '../server/app.mjs';

const panelGateway = {mountPath: '/team/bugs/', signInPath: '/team/', logoutPath: '/team/logout'};
const gatewayToken = 'server-side-reviewer-fixture';
const agentToken = 'private-agent-fixture';
const file = Buffer.from('private attachment fixture');
const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, config) {
  const directory = mkdtempSync(join(tmpdir(), 'kit-panel-gateway-'));
  const app = createApp({
    projects: [{id: 'site', name: 'Fixture site', widgetKey: 'public-key', allowedOrigins: [],
      reporterAuth: true, panelAccess: !config.panelGateway}],
    reporterAuthSecret: 'private-isolated-reporter-secret-for-tests',
    teamTokens: [
      {name: 'Gateway reviewer', token: gatewayToken, role: 'reviewer', projects: ['site']},
      {name: 'Agent', token: agentToken, role: 'developer', projects: ['site']},
    ],
    ...config,
  }, {database: join(directory, 'reports.sqlite')});
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    app.db.close();
    rmSync(directory, {recursive: true, force: true});
  });
  return listen(app.server);
}

test('gateway panel uses the session, preserves report links, and never sends a browser bearer', async t => {
  const reportOrigin = 'http://localhost:7338';
  const backend = await fixture(t, {panelGateway:{...panelGateway,preserveLegacy:true}, projects:[{id:'site', name:'Fixture site', widgetKey:'public-key',
    allowedOrigins:[reportOrigin], reporterAuth:true, panelAccess:false}]});
  let sessionValid = true;
  const received = [];
  const proxy = createServer(handler);
  const origin = await listen(proxy);
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const reporterHeaders = {Origin:reportOrigin,'X-Project-Key':'public-key','Content-Type':'application/json'};
  function handler(req, res) {
    received.push([req.method, req.url, req.headers.authorization]);
    if (req.url === panelGateway.signInPath) return res.end('Fixture start');
    if (req.url === panelGateway.logoutPath && req.method === 'POST') {
      sessionValid = false;
      res.writeHead(303, {Location: panelGateway.signInPath}); return res.end();
    }
    const headers = {...req.headers};
    let path = req.url;
    if (path.startsWith(panelGateway.mountPath)) {
      const relative = '/' + path.slice(panelGateway.mountPath.length);
      if (relative.startsWith('/api/') && (!sessionValid || req.headers.cookie !== 'fixture_session=valid')) {
        res.writeHead(403, {'Content-Type':'text/html'}); return res.end('<p>Forbidden</p>');
      }
      delete headers.authorization;
      if (relative.startsWith('/api/')) { headers.authorization = `Bearer ${gatewayToken}`; path = relative; }
    }
    delete headers.cookie;
    const forward = request(backend + path, {method:req.method, headers}, reply => {
      res.writeHead(reply.statusCode, reply.headers); reply.pipe(res);
    });
    req.pipe(forward);
  }
  const registered = await fetch(origin + '/api/reporter/register', {method:'POST', headers:reporterHeaders,
    body:JSON.stringify({name:'Ordinary reporter',pin:'1234'})});
  assert.equal(registered.status, 201);
  const {token} = await registered.json();
  const created = await fetch(origin + '/api/reports', {method:'POST', headers:{...reporterHeaders,'X-Reporter-Token':token},
    body:JSON.stringify({description:'Private fixture report', pageUrl:reportOrigin+'/page', screenshot,
      attachment:{name:'private.txt',data:`data:text/plain;base64,${file.toString('base64')}`}})});
  assert.equal(created.status, 201);
  const {id} = await created.json();
  for (const suffix of ['', '/attachment', '/screenshot']) {
    const path = `api/reports/${id}${suffix}`;
    assert.equal((await fetch(origin + '/' + path, {headers:{Authorization:`Bearer ${token}`}})).status, 401);
    assert.equal((await fetch(origin + panelGateway.mountPath + path)).status, 403);
  }

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.addInitScript(() => sessionStorage.setItem('bug-kit-panel-token','stale-bearer-fixture'));
  await context.addCookies([{name:'fixture_session',value:'valid',domain:'127.0.0.1',path:'/team/',httpOnly:true}]);
  const page = await context.newPage();
  const base = origin + panelGateway.mountPath;
  await page.goto(origin+'/');
  assert.equal(await page.getByLabel('PIN', {exact:true}).count(), 1);
  const response = await page.goto(base + 'reports/' + id);
  assert.doesNotMatch(await response.text(), /login-pin|server-side-reviewer-fixture/);
  await page.getByRole('heading', {name:'Private fixture report'}).waitFor();
  assert.equal(await page.getByLabel('PIN', {exact:true}).count(), 0);
  assert.equal(await page.locator('#actor').textContent(), 'Gateway reviewer');
  assert.match(await page.locator('img.report-image').getAttribute('src'), /^blob:/);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', {name:'Скачать файл'}).click();
  const download = await downloaded;
  assert.equal(download.suggestedFilename(), 'private.txt');
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), file);
  await page.goto(base);
  await page.getByRole('button', {name:/Private fixture report/}).click();
  assert.equal(page.url(), base + 'reports/' + id);
  const filtered = page.waitForResponse(reply => reply.url().startsWith(base + 'api/reports?') &&
    new URL(reply.url()).searchParams.get('status') === 'new');
  await page.locator('#filter').selectOption('new');
  await filtered;
  assert.equal(await page.evaluate(() => sessionStorage.getItem('bug-kit-panel-token')), 'stale-bearer-fixture');

  const beforeInvalidLink = received.length;
  await page.goto(base + 'reports/%2e%2e%2fme');
  await page.getByText('Неверный номер карточки.').waitFor();
  assert.equal(received.slice(beforeInvalidLink).some(([, path]) => path.includes('/api/reports/')), false);
  assert.equal(await page.locator('#workspace').isVisible(), true);

  const logoutUrl = origin + panelGateway.logoutPath;
  await page.route(logoutUrl, route => route.fulfill({status:200,body:'false success fixture'}));
  await page.getByRole('link', {name:'Выйти'}).click();
  await page.getByText('Не удалось выйти. Повторите попытку.').waitFor();
  assert.equal(page.url(), base + 'reports/%2e%2e%2fme');
  assert.equal((await context.request.get(base + 'api/me')).status(), 200);
  await page.unroute(logoutUrl);

  let captured, release, finished;
  const capturedList = new Promise(resolve => { captured = resolve; });
  const releaseList = new Promise(resolve => { release = resolve; });
  const finishedList = new Promise(resolve => { finished = resolve; });
  const listUrl = url => url.pathname === new URL(base + 'api/reports').pathname;
  await page.route(listUrl, async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    captured();
    await releaseList;
    try { await route.fulfill({response}); }
    finally { finished(); }
  }, {times: 1});
  await page.getByRole('button', {name:'Обновить очередь'}).click();
  await capturedList;
  sessionValid = false;
  await page.getByRole('button', {name:'Обновить очередь'}).click();
  await page.getByRole('link', {name:'Перейти ко входу'}).waitFor();
  release();
  await finishedList;
  await page.waitForFunction(() => document.querySelector('#message').textContent.includes('Для доступа'));
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#workspace').getByText('Private fixture report').count(), 0);
  assert.equal(await page.locator('#actor').textContent(), '');

  sessionValid = true;
  await page.reload();
  await page.getByRole('link', {name:'Выйти'}).click();
  await page.waitForURL(origin + panelGateway.signInPath);
  await page.goto(base + 'reports/' + id);
  await page.getByRole('link', {name:'Перейти ко входу'}).waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.ok(received.some(([method, path]) => method === 'POST' && path === panelGateway.logoutPath));
  assert.ok(received.filter(([,path]) => path.startsWith(panelGateway.mountPath)).every(([, ,authorization]) => authorization === undefined));
  assert.equal((await fetch(origin + '/api/me', {headers:{Authorization:`Bearer ${agentToken}`}})).status, 200);
});

test('standard panel still signs in with PIN and sends its own bearer', async t => {
  const origin = await fixture(t, {});
  const registered = await fetch(origin + '/api/panel/register', {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({projectId:'site', name:'Legacy reviewer', pin:'1234'})});
  assert.equal(registered.status, 201);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByLabel('Имя', {exact:true}).fill('Legacy reviewer');
  await page.getByLabel('PIN', {exact:true}).fill('1234');
  const me = page.waitForRequest(req => req.url() === origin + '/api/me');
  await page.getByRole('button', {name:'Войти',exact:true}).click();
  assert.match((await me).headers().authorization, /^Bearer [A-Za-z0-9_-]{43}$/);
  await page.locator('#workspace').waitFor();
  assert.match(await page.evaluate(() => sessionStorage.getItem('bug-kit-panel-token')), /^[A-Za-z0-9_-]{43}$/);
  await page.getByRole('link', {name:'Выйти'}).click();
  await page.locator('#login').waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('bug-kit-panel-token')), null);
});
