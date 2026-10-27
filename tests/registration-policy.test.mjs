import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';

test('closing registration preserves accounts and login while denying both creation routes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kit-registration-'));
  const origin = 'http://localhost:7338';
  const project = {id: 'site', name: 'Site', widgetKey: 'site-key', reporterAuth: true,
    panelAccess: true, allowedOrigins: [origin]};
  const config = {reporterAuthSecret: 'fixture-secret-at-least-thirty-two-characters', projects: [project],
    teamTokens: [{name: 'Fixture developer', token: 'fixture-team-token', projects: ['site']}]};
  let app;
  let base;
  const start = async () => {
    app = createApp(config, {rootDir: directory, database: './reports.sqlite'});
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const stop = async () => { await new Promise(resolve => app.server.close(resolve)); app.db.close(); };
  t.after(async () => {
    if (app?.server.listening) await stop();
    rmSync(directory, {recursive: true, force: true});
  });
  const post = (path, body = {}, requestOrigin = origin, key = 'site-key') => fetch(base + path, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: requestOrigin, 'X-Project-Key': key},
    body: JSON.stringify(body),
  });
  await start();
  assert.deepEqual(await (await post('/api/reporter/options')).json(), {registrationEnabled: true});
  const registered = await post('/api/reporter/register', {name: 'Existing', pin: '1234'});
  assert.equal(registered.status, 201);
  const session = await registered.json();
  await stop();
  project.reporterRegistration = false;
  await start();
  assert.deepEqual(await (await post('/api/reporter/options')).json(), {registrationEnabled: false});
  assert.equal((await post('/api/reporter/options', {}, 'https://foreign.invalid')).status, 403);
  assert.equal((await post('/api/reporter/options', {}, origin, 'other-project')).status, 403);
  assert.deepEqual(await (await fetch(base + '/api/panel/projects')).json(),
    [{id: 'site', name: 'Site', reporterRegistration: false}]);
  for (const path of ['/api/reporter/register', '/api/panel/register']) {
    const denied = await post(path, {projectId: 'site', name: 'Uninvited', pin: '5678'});
    assert.equal(denied.status, 403);
    const body = await denied.json();
    assert.equal(body.code, 'registration_closed');
    assert.match(body.error, /регистрация закрыта/);
  }
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM reporter_accounts').get().n, 1);
  for (const path of ['/api/reporter/login', '/api/panel/login']) {
    const login = await post(path, {projectId: 'site', name: 'Existing', pin: '1234'});
    assert.equal(login.status, 200);
    assert.equal((await login.json()).reporter.id, session.reporter.id);
  }
  const missing = await post('/api/reporter/login', {name: 'Uninvited', pin: '5678'});
  const missingBody = await missing.json();
  assert.equal(missingBody.code, 'name_not_found');
  assert.doesNotMatch(missingBody.error, /создайте/);
  assert.match(missingBody.error, /сопровождающему/);
  const me = await fetch(base + '/api/reporter/me', {method: 'POST', headers: {Origin: origin,
    'X-Project-Key': 'site-key', 'X-Reporter-Token': session.token}});
  assert.equal(me.status, 200);
});
