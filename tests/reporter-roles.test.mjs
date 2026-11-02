import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.mjs';
import {setPanelAccess} from '../scripts/panel-access.mjs';
import {readJsonResponse} from '../shared/http-response.mjs';

test('legacy maintainers keep access; public registration never grants panel permissions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-roles-'));
  const database = join(directory, 'reports.sqlite');
  const origin = 'http://localhost:17339';
  const config = {
    reporterAuthSecret: 'isolated-test-secret-at-least-thirty-two-characters',
    projects: [{id: 'site', widgetKey: 'fixture-key', reporterAuth: true, panelAccess: true,
      allowedOrigins: [origin]}],
    teamTokens: [{name: 'Developer', token: 'fixture-team', role: 'developer', projects: ['site']}],
  };
  let app, base;
  const start = async () => {
    app = createApp(config, {rootDir: directory, database});
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const stop = async () => {await new Promise(resolve => app.server.close(resolve)); app.db.close();};
  t.after(async () => {if (app?.server.listening) await stop(); rmSync(directory, {recursive: true, force: true});});
  const post = (path, body, token) => fetch(base + path, {method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: origin, 'X-Project-Key': 'fixture-key',
      ...(token ? {'X-Reporter-Token': token} : {})}, body: JSON.stringify(body)});
  const register = async name => {
    const response = await post('/api/reporter/register', {name, pin: '1234', role: 'reviewer',
      id: 'forged-admin-id', project_id: 'other', panelAccess: true});
    assert.equal(response.status, 201); return response.json();
  };
  const auth = session => ({Authorization: `Bearer ${session.token}`});
  await start();
  const owner = await register('Owner fixture'), admin = await register('Admin fixture');
  const original = app.db.prepare('SELECT id,name,pin_hash,pin_salt FROM reporter_accounts ORDER BY id').all();
  // Reproduce the exact pre-upgrade schema without the new permission column.
  await stop();
  const legacy = new DatabaseSync(database);
  legacy.exec('ALTER TABLE reporter_accounts DROP COLUMN role'); legacy.close();
  await start();
  assert.deepEqual(app.db.prepare('SELECT id,name,pin_hash,pin_salt FROM reporter_accounts ORDER BY id').all(), original);
  for (const maintainer of [owner, admin]) {
    assert.equal((await fetch(base + '/api/me', {headers: auth(maintainer)})).status, 200);
    const response = await post('/api/panel/login', {projectId: 'site', name: maintainer.reporter.name, pin: '1234'});
    assert.equal(response.status, 200);
    await fetch(base + '/api/panel/logout', {method: 'POST', headers: auth(await response.json())});
  }
  const user = await register('Ordinary fixture');
  assert.notEqual(user.reporter.id, 'forged-admin-id');
  assert.equal(app.db.prepare('SELECT role FROM reporter_accounts WHERE id=?').get(user.reporter.id).role, 'reporter');
  const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const report = {description: 'Isolated role-boundary report', pageUrl: origin + '/page', screenshot,
    attachment: {name: 'private.txt', data: 'data:text/plain;base64,cHJpdmF0ZQ=='}};
  const created = await post('/api/reports', report, user.token);
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.reportUrl, undefined);
  const other = await post('/api/reports', {...report, description: 'Maintainer-only report'}, owner.token);
  const otherReport = await other.json();
  assert.match(otherReport.reportUrl, /^\/reports\//);
  const sessionsBefore = app.db.prepare('SELECT COUNT(*) AS n FROM reporter_sessions').get().n;
  const denied = await post('/api/panel/login', {projectId: 'site', name: user.reporter.name, pin: '1234'});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'panel_access_denied');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM reporter_sessions').get().n, sessionsBefore);
  assert.equal((await post('/api/panel/register', {projectId: 'site', name: 'Escalation fixture', pin: '1234'})).status, 403);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM reporter_accounts').get().n, 3);
  for (const path of ['/api/me', '/api/projects', '/api/reports', '/api/reports?project=site',
    '/api/summary', '/api/summary/html', ...[result.id, otherReport.id].flatMap(id =>
      ['', '/html', '/screenshot', '/attachment', '/audio', '/transcription', '/related'].map(suffix => `/api/reports/${id}${suffix}`))]) {
    const response = await fetch(base + path, {headers: auth(user)});
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), {error: 'Войдите в панель'});
  }
  for (const [method, suffix] of [['PATCH', ''], ['POST', '/transcription']]) {
    assert.equal((await fetch(`${base}/api/reports/${otherReport.id}${suffix}`, {method,
      headers: {...auth(user), 'Content-Type': 'application/json'}, body: JSON.stringify({revision: 0, action: 'triage'})})).status, 401);
  }
  assert.equal((await fetch(`${base}/api/reports/${result.id}/attachment`, {headers: auth(admin)})).status, 200);
  assert.equal((await fetch(`${base}/api/reports/${otherReport.id}`, {headers: auth(owner)})).status, 200);
  assert.equal((await fetch(`${base}/api/reports/${otherReport.id}`, {headers: {Authorization: 'Bearer fixture-team'}})).status, 200);
  await stop(); await start();
  assert.equal((await post('/api/reporter/me', {}, user.token)).status, 200);
  assert.equal((await fetch(base + '/api/me', {headers: auth(user)})).status, 401, 'restart must not elevate new reporters');
  setPanelAccess(app.db, 'site', user.reporter.id, true);
  assert.equal((await fetch(base + '/api/me', {headers: auth(user)})).status, 200);
  setPanelAccess(app.db, 'site', user.reporter.id, false);
  assert.equal((await fetch(base + '/api/me', {headers: auth(user)})).status, 401, 'revocation applies to already issued tokens');
  assert.equal((await post('/api/reports', report, user.token)).status, 201, 'revocation retains reporting');
  assert.throws(() => setPanelAccess(app.db, 'other', user.reporter.id, true), /не найдена/);
});

test('HTML proxy failures produce readable messages without reflecting server HTML', async () => {
  for (const status of [403, 502, 200]) {
    await assert.rejects(readJsonResponse(new Response('<html><h1>proxy internals</h1></html>', {status})),
      error => !/Unexpected token|<html>|proxy internals/.test(error.message) && /Сервис|Сервер/.test(error.message));
  }
  assert.deepEqual(await readJsonResponse(Response.json({error: 'Неверный PIN'})), {error: 'Неверный PIN'});
});
