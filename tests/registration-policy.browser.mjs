import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createApp} from '../server/app.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => server.close(resolve));

test('registration policy and reverse proxy errors in widget and panel', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kit-registration-browser-'));
  let kitBase;
  const site = createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end(`<!doctype html><html lang="ru"><body>Local fixture
      <script src="${kitBase}/widget.js" data-project-key="fixture-key" data-reporter-auth="true"></script>`);
  });
  await listen(site);
  const siteBase = `http://127.0.0.1:${site.address().port}`;
  const project = {id: 'fixture', widgetKey: 'fixture-key', reporterAuth: true, panelAccess: true, allowedOrigins: [siteBase]};
  const app = createApp({projects: [project], reporterAuthSecret: 'fixture-secret-at-least-thirty-two-characters',
    teamTokens: [{name: 'Fixture developer', token: 'fixture-team-token', projects: ['fixture']}]},
  {rootDir: process.cwd(), database: join(directory, 'reports.sqlite')});
  await listen(app.server);
  kitBase = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(kitBase + '/api/reporter/register', {method: 'POST',
    headers: {Origin: siteBase, 'Content-Type': 'application/json', 'X-Project-Key': 'fixture-key'},
    body: JSON.stringify({name: 'Existing', pin: '1234'})});
  assert.equal(response.status, 201);
  project.reporterRegistration = false;
  const browser = await chromium.launch({headless: true});
  t.after(async () => {
    await browser.close(); await close(app.server); app.db.close(); await close(site);
    rmSync(directory, {recursive: true, force: true});
  });
  const widget = async () => {
    const page = await browser.newPage();
    await page.goto(siteBase);
    await page.getByRole('button', {name: 'Сообщить о баге', exact: true}).click();
    await page.getByRole('dialog').waitFor();
    return page;
  };
  const fill = async (page, name = 'Existing') => {
    await page.getByPlaceholder('Имя или ник').fill(name);
    await page.getByLabel('PIN из 4 цифр').fill('1234');
  };
  await t.test('closed registration gives login, never suggests creation, and preserves existing login', async () => {
    const page = await widget();
    try {
      await page.getByText('Самостоятельная регистрация закрыта.', {exact: false}).waitFor();
      assert.equal(await page.getByRole('button', {name: 'Создать имя'}).count(), 0);
      let registrations = 0;
      page.on('request', request => {if (request.url().endsWith('/api/reporter/register')) registrations++;});
      await fill(page, 'Unknown');
      await page.getByRole('button', {name: 'Войти', exact: true}).click();
      await page.getByRole('status').filter({hasText: 'Проверьте выданное имя'}).waitFor();
      await page.getByLabel('PIN из 4 цифр').press('Enter');
      await page.getByRole('status').filter({hasText: 'Проверьте выданное имя'}).waitFor();
      assert.equal(registrations, 0);
      await fill(page);
      await page.getByRole('button', {name: 'Войти', exact: true}).click();
      await page.locator('.overlay').waitFor();
      await page.getByRole('button', {name: 'Отмена'}).click();
    } finally { await page.close(); }
  });
  await t.test('HTML gateway failure becomes readable text and retains inputs', async () => {
    const page = await widget();
    try {
      await page.route('**/api/reporter/login', route => route.fulfill({status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>'}));
      await fill(page);
      await page.getByRole('button', {name: 'Войти', exact: true}).click();
      await page.getByRole('status').filter({hasText: 'HTTP 502'}).waitFor();
      assert.doesNotMatch(await page.getByRole('status').innerText(), /Unexpected|<html>|JSON/);
      assert.equal(await page.getByPlaceholder('Имя или ник').inputValue(), 'Existing');
    } finally { await page.close(); }
  });
  await t.test('unavailable policy keeps registration hidden and login usable', async () => {
    const page = await browser.newPage();
    try {
      await page.route('**/api/reporter/options', route => route.fulfill({status: 503, body: '<html>Unavailable</html>'}));
      await page.goto(siteBase);
      await page.getByRole('button', {name: 'Сообщить о баге', exact: true}).click();
      await page.getByRole('dialog').waitFor();
      assert.equal(await page.getByRole('button', {name: 'Создать имя'}).count(), 0);
      await fill(page);
      await page.getByRole('button', {name: 'Войти', exact: true}).click();
      await page.locator('.overlay').waitFor();
    } finally { await page.close(); }
  });
  await t.test('open project keeps registration, HTML 403 shows a useful refusal', async () => {
    project.reporterRegistration = true;
    const page = await widget();
    try {
      await page.getByRole('button', {name: 'Создать имя'}).waitFor();
      await page.route('**/api/reporter/register', route => route.fulfill({status: 403, contentType: 'text/html', body: '<html>Forbidden</html>'}));
      await fill(page, 'New reporter');
      await page.getByRole('button', {name: 'Создать имя'}).click();
      await page.getByRole('status').filter({hasText: 'Самостоятельная регистрация закрыта'}).waitFor();
      assert.doesNotMatch(await page.getByRole('status').innerText(), /Unexpected|<html>|JSON/);
      assert.equal(await page.getByRole('button', {name: 'Создать имя'}).count(), 0);
    } finally { project.reporterRegistration = false; await page.close(); }
  });
  await t.test('panel hides creation and existing account can enter', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(kitBase);
      await page.locator('#login-hint').filter({hasText: 'Самостоятельная регистрация закрыта'}).waitFor();
      assert.equal(await page.getByRole('button', {name: 'Создать имя'}).count(), 0);
      await page.locator('#login-name').fill('Existing');
      await page.locator('#login-pin').fill('1234');
      await page.getByRole('button', {name: 'Войти', exact: true}).click();
      await page.locator('#workspace').waitFor({state: 'visible'});
      assert.equal(await page.locator('#actor').innerText(), 'Existing');
    } finally { await page.close(); }
  });
  await t.test('same-origin widget policy receives Origin on POST', async () => {
    project.allowedOrigins.push(kitBase);
    const page = await browser.newPage();
    try {
      await page.goto(kitBase);
      await page.addScriptTag({url: kitBase + '/widget.js'});
      const policyRequest = page.waitForRequest(request => request.url().endsWith('/api/reporter/options'));
      await page.evaluate(base => window.BugReportKit.init({serverUrl: base, projectKey: 'fixture-key', reporterAuth: true}), kitBase);
      await page.getByRole('button', {name: 'Сообщить о баге', exact: true}).click();
      await page.locator('.auth-card .meta').filter({hasText: 'Самостоятельная регистрация закрыта'}).waitFor();
      assert.equal((await (await policyRequest).allHeaders()).origin, kitBase);
    } finally { project.allowedOrigins = [siteBase]; await page.close(); }
  });
  await t.test('panel handles HTML gateway failure without a JSON parser message', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(kitBase);
      await page.locator('#login-hint').filter({hasText: 'Самостоятельная регистрация закрыта'}).waitFor();
      await page.route('**/api/panel/login', route => route.fulfill({status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>'}));
      await page.locator('#login-name').fill('Existing');
      await page.locator('#login-pin').fill('1234');
      await page.getByRole('button', {name: 'Войти', exact: true}).click();
      await page.locator('#login-error').filter({hasText: 'HTTP 502'}).waitFor();
      assert.doesNotMatch(await page.locator('#login-error').innerText(), /Unexpected|<html>|JSON/);
    } finally { await page.close(); }
  });
});
