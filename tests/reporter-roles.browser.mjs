import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, request} from 'node:http';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createApp} from '../server/app.mjs';
import {setPanelAccess} from '../scripts/panel-access.mjs';

test('ordinary user registers and reports; only maintainers can open the inbox', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-roles-browser-'));
  const project = {id: 'fixture', name: 'Isolated fixture', widgetKey: 'fixture-key',
    reporterAuth: true, panelAccess: true, voiceEnabled: false, allowedOrigins: []};
  const app = createApp({projects: [project], reporterAuthSecret: 'browser-only-isolated-secret-over-thirty-two-characters',
    teamTokens: [{name: 'Fixture developer', token: 'fixture-team', role: 'developer', projects: ['fixture']}]},
  {rootDir: process.cwd(), database: join(directory, 'reports.sqlite')});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const kitBase = `http://127.0.0.1:${app.server.address().port}`;
  const site = createServer((req, res) => {
    if (req.url === '/fixture') {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><body style="margin:0;background:#f6f5f2">
        <main style="margin:40px;padding:30px;height:400px;background:white"><h1>Изолированная проверка баг-репортов</h1><p>Только временные данные.</p></main>
        <script src="/widget.js" data-server-url="${origin}" data-project-key="fixture-key" data-reporter-auth="true" data-voice-enabled="false"></script></body></html>`);
      return;
    }
    const proxy = request(kitBase + (req.url === '/bugs/' ? '/' : req.url), {method: req.method, headers: req.headers}, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    proxy.on('error', () => {res.writeHead(502); res.end();}); req.pipe(proxy);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  project.allowedOrigins.push(origin);
  const browser = await chromium.launch({headless: true});
  t.after(async () => {
    await browser.close(); await new Promise(resolve => site.close(resolve));
    await new Promise(resolve => app.server.close(resolve)); app.db.close();
    rmSync(directory, {recursive: true, force: true});
  });
  const contexts = [];
  t.after(async () => {await Promise.all(contexts.map(context => context.close()));});
  const pageFor = async () => {
    const context = await browser.newContext({viewport: {width: 1100, height: 800}}); contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    return page;
  };
  const errors = [];
  const evidence = process.env.BUG_KIT_TEST_EVIDENCE;
  if (evidence) mkdirSync(evidence, {recursive: true});
  const screenshot = async (page, name) => {if (evidence) await page.screenshot({path: join(evidence, name + '.png'), fullPage: true});};
  const page = await pageFor();
  await page.goto(origin + '/fixture');
  await page.getByRole('button', {name: 'Сообщить о баге', exact: true}).click();
  await page.getByLabel('Имя или ник', {exact: true}).fill('Обычный участник');
  await page.getByLabel('PIN из 4 цифр', {exact: true}).fill('1234');
  await screenshot(page, 'registration');
  await page.getByRole('button', {name: 'Создать имя', exact: true}).click();
  await page.locator('.overlay:not(.is-preparing)').waitFor();
  await page.mouse.move(70, 70); await page.mouse.down(); await page.mouse.move(550, 330, {steps: 6}); await page.mouse.up();
  await page.getByRole('button', {name: 'Подтвердить выделение', exact: true}).click();
  await page.getByRole('textbox', {name: /Суть бага/}).fill('Проверка: новый участник отправляет баг со снимком');
  await screenshot(page, 'report-form');
  await page.getByRole('button', {name: 'Отправить', exact: true}).click();
  await page.getByText('Баг отправлен', {exact: false}).waitFor();
  const row = app.db.prepare('SELECT reporter_name,screenshot FROM reports').get();
  assert.equal(row.reporter_name, 'Обычный участник'); assert.ok(row.screenshot.length > 0);
  assert.equal(app.db.prepare('SELECT role FROM reporter_accounts').get().role, 'reporter');
  const panel = await pageFor();
  await panel.goto(origin + '/bugs/');
  assert.equal(await panel.getByRole('button', {name: 'Создать имя', exact: true}).count(), 0);
  await panel.locator('#login-name').fill('Обычный участник'); await panel.locator('#login-pin').fill('1234');
  await panel.getByRole('button', {name: 'Войти', exact: true}).click();
  await panel.getByText(/может только отправлять баги/).waitFor();
  assert.equal(await panel.locator('#workspace').isVisible(), false);
  await screenshot(panel, 'ordinary-panel-denied');
  // The host operator grants a fixture maintainer by immutable account ID.
  const response = await fetch(origin + '/api/reporter/register', {method: 'POST', headers: {
    Origin: origin, 'X-Project-Key': 'fixture-key', 'Content-Type': 'application/json'},
    body: JSON.stringify({name: 'Сопровождающий', pin: '5678'})});
  const maintainer = await response.json(); setPanelAccess(app.db, 'fixture', maintainer.reporter.id, true);
  await panel.locator('#login-name').fill('Сопровождающий'); await panel.locator('#login-pin').fill('5678');
  await panel.getByRole('button', {name: 'Войти', exact: true}).click();
  await panel.locator('#workspace').waitFor({state: 'visible'});
  await panel.getByText('Проверка: новый участник отправляет баг со снимком', {exact: false}).first().waitFor();
  await screenshot(panel, 'maintainer-inbox');
  const failure = await pageFor(); await failure.goto(origin + '/fixture');
  await failure.route('**/api/reporter/register', route => route.fulfill({status: 403, contentType: 'text/html', body: '<html><h1>403 Forbidden</h1></html>'}));
  await failure.getByRole('button', {name: 'Сообщить о баге', exact: true}).click();
  await failure.getByLabel('Имя или ник', {exact: true}).fill('Сохранённое имя');
  await failure.getByLabel('PIN из 4 цифр', {exact: true}).fill('1234');
  await failure.getByRole('button', {name: 'Создать имя', exact: true}).click();
  await failure.getByText(/Сервер запретил это действие/).waitFor();
  assert.equal(await failure.getByLabel('Имя или ник', {exact: true}).inputValue(), 'Сохранённое имя');
  assert.equal(await failure.getByLabel('PIN из 4 цифр', {exact: true}).inputValue(), '1234');
  await screenshot(failure, 'readable-html-error');
  assert.deepEqual(errors, []);
});
