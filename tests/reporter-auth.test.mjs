import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';

test('reporter PIN account owns report identity and survives server restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-auth-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const origin = 'http://localhost:7338';
  const config = {
    reporterAuthSecret: 'test-secret-with-more-than-thirty-two-characters',
    projects: [
      {id: 'site', widgetKey: 'site-key', allowedOrigins: [origin], reporterAuth: true, panelAccess: true},
      {id: 'other', widgetKey: 'other-key', allowedOrigins: [origin], reporterAuth: true},
    ],
    teamTokens: [{name: 'Developer', token: 'team-token', projects: ['site', 'other']}],
  };
  let app;
  const start = async () => {
    app = createApp(config, {rootDir: directory, database: './reports.sqlite'});
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${app.server.address().port}`;
  };
  const stop = async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  };
  t.after(async () => {if (app.server.listening) await stop();});
  let base = await start();
  const post = (path, key, body, token) => fetch(`${base}${path}`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: origin,
      'X-Project-Key': key, ...(token ? {'X-Reporter-Token': token} : {})},
    body: JSON.stringify(body),
  });
  const register = await post('/api/reporter/register', 'site-key', {name: 'Мария', pin: '1234'});
  assert.equal(register.status, 201);
  const {token, reporter} = await register.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(reporter.name, 'Мария');
  assert.deepEqual(await (await fetch(`${base}/api/panel/projects`)).json(), [{id: 'site', name: 'site'}]);
  const panelPost = (mode, body) => fetch(`${base}/api/panel/${mode}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
  });
  assert.equal((await panelPost('login', {projectId: 'site', name: 'Мария', pin: '9999'})).status, 401);
  assert.equal((await panelPost('login', {projectId: 'other', name: 'Мария', pin: '1234'})).status, 403);
  const panelLogin = await panelPost('login', {projectId: 'site', name: 'Мария', pin: '1234'});
  assert.equal(panelLogin.status, 200);
  const panelToken = (await panelLogin.json()).token;
  const panelHeaders = {Authorization: `Bearer ${panelToken}`};
  assert.deepEqual(await (await fetch(`${base}/api/me`, {headers: panelHeaders})).json(),
    {name: 'Мария', role: 'reviewer'});
  assert.deepEqual(await (await fetch(`${base}/api/projects`, {headers: panelHeaders})).json(),
    [{id: 'site', repositories: []}]);
  assert.equal((await fetch(`${base}/api/reports?project=other`, {headers: panelHeaders})).status, 403);
  const duplicateName = await post('/api/reporter/register', 'site-key', {name: 'мАРИЯ', pin: '5678'});
  assert.equal(duplicateName.status, 409);
  const duplicateBody = await duplicateName.json();
  assert.equal(duplicateBody.code, 'name_taken');
  assert.match(duplicateBody.error, /войти|другое имя/i);
  assert.equal((await post('/api/reporter/register', 'site-key', {name: 'Мария', pin: '123'})).status, 400);
  const unknownLogin = await post('/api/reporter/login', 'site-key', {name: 'Несуществующее имя', pin: '9999'});
  assert.equal(unknownLogin.status, 401);
  const unknownBody = await unknownLogin.json();
  assert.equal(unknownBody.code, 'name_not_found');
  assert.match(unknownBody.error, /создайте имя/i);
  const wrongPin = await post('/api/reporter/login', 'site-key', {name: 'Мария', pin: '9999'});
  assert.equal(wrongPin.status, 401);
  const wrongPinBody = await wrongPin.json();
  assert.equal(wrongPinBody.code, 'wrong_pin');
  assert.match(wrongPinBody.error, /проверьте (?:PIN|четыре цифры)/i);
  assert.equal((await post('/api/reporter/login', 'site-key', {name: 'мАРИЯ', pin: '1234'})).status, 200);
  const spoofed = {description: 'Ошибка в форме', title: 'Ошибка', pageUrl: `${origin}/page`,
    reporterName: 'Чужое имя', reporterId: 'forged', reporterContact: 'forged@example.test', appUser: {id:'lms-42',name:'Ученик',role:'student',contact:'student@example.test',token:'SECRET'}};
  assert.equal((await post('/api/reports', 'site-key', spoofed)).status, 401);
  assert.equal((await post('/api/reports', 'other-key', spoofed, token)).status, 401);
  const created = await post('/api/reports', 'site-key', spoofed, token);
  assert.equal(created.status, 201);
  const {id} = await created.json();
  assert.equal((await fetch(`${base}/api/reports/${id}`, {headers: panelHeaders})).status, 200);
  assert.equal((await fetch(`${base}/api/reports/${id}/html`, {headers: panelHeaders})).status, 200);
  const triage = await fetch(`${base}/api/reports/${id}`, {method: 'PATCH',
    headers: {...panelHeaders, 'Content-Type': 'application/json'},
    body: JSON.stringify({revision: 0, action: 'triage', priority: 'normal'})});
  assert.equal(triage.status, 200);
  assert.equal((await triage.json()).history.at(-1).actor, 'Мария');
  const detail = await (await fetch(`${base}/api/reports/${id}`, {headers: {Authorization: 'Bearer team-token'}})).json();
  assert.equal(detail.reporterName, 'Мария');
  assert.equal(detail.reporterId, reporter.id);
  assert.equal(detail.reporterContact, '');
  assert.deepEqual(detail.appUser, {id:'lms-42', name:'Ученик', role:'student', contact:'student@example.test'});
  const listed = await (await fetch(`${base}/api/reports?project=site`, {headers: panelHeaders})).json();
  assert.deepEqual(listed.find(item => item.id === id).appUser, detail.appUser);
  const html = await (await fetch(`${base}/api/reports/${id}/html`,
    {headers: {Authorization: 'Bearer team-token'}})).text();
  assert.match(html, /Мария/);
  assert.match(html, /lms-42/);
  assert.match(html, /student/);
  assert.doesNotMatch(html, /SECRET/);
  assert.match(html, new RegExp(reporter.id));
  assert.doesNotMatch(html, /Чужое имя|forged@example\.test/);
  await stop();
  base = await start();
  const me = await fetch(`${base}/api/reporter/me`, {headers: {Origin: origin,
    'X-Project-Key': 'site-key', 'X-Reporter-Token': token}});
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).reporter, reporter);
  const sameOriginCheck = await post('/api/reporter/me', 'site-key', {}, token);
  assert.equal(sameOriginCheck.status, 200);
  assert.deepEqual((await sameOriginCheck.json()).reporter, reporter);
  for (const requestOrigin of ['', 'https://foreign.example']) {
    const denied = await fetch(`${base}/api/reporter/me`, {method:'POST', headers:{
      ...(requestOrigin ? {Origin:requestOrigin} : {}),
      'X-Project-Key':'site-key','X-Reporter-Token':token,
    }});
    assert.equal(denied.status, 403, 'Origin remains mandatory and allowlisted');
  }

  assert.equal((await post('/api/reporter/logout', 'site-key', {}, token)).status, 200);
  assert.equal((await post('/api/reports', 'site-key', spoofed, token)).status, 401);
  assert.equal((await fetch(`${base}/api/me`, {headers: panelHeaders})).status, 200);
  assert.equal((await fetch(`${base}/api/panel/logout`, {method: 'POST', headers: panelHeaders})).status, 200);
  assert.equal((await fetch(`${base}/api/me`, {headers: panelHeaders})).status, 401);
  assert.equal((await post('/api/reporter/login', 'site-key', {name: 'Мария', pin: '1234'})).status, 200);
});

test('explicit panel membership preserves an existing PIN account and denies new reporters', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-panel-members-'));
  const origin = 'http://localhost:7338';
  const project = {id: 'site', widgetKey: 'site-key', allowedOrigins: [origin], reporterAuth: true, panelAccess: true};
  const config = {reporterAuthSecret: 'test-secret-with-more-than-thirty-two-characters', projects: [project],
    teamTokens: [{token: 'team-token', projects: ['site']}]};
  let app;
  const start = async () => {
    app = createApp(config, {rootDir: directory, database: './reports.sqlite'});
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${app.server.address().port}`;
  };
  const stop = async () => { await new Promise(resolve => app.server.close(resolve)); app.db.close(); };
  t.after(async () => { if (app?.server.listening) await stop(); rmSync(directory, {recursive: true, force: true}); });
  let base = await start();
  const post = (path, body, extra = {}) => fetch(base + path, {method: 'POST',
    headers: {'Content-Type':'application/json', Origin: origin, 'X-Project-Key':'site-key', ...extra}, body: JSON.stringify(body)});
  const old = await (await post('/api/reporter/register', {name:'Staff', pin:'1234'})).json();
  await stop();
  project.panelAccountIds = [old.reporter.id];
  base = await start();
  const staff = await post('/api/panel/login', {projectId:'site', name:'Staff', pin:'1234'});
  assert.equal(staff.status, 200);
  const staffToken = (await staff.json()).token;
  const fresh = await (await post('/api/reporter/register', {name:'New reporter', pin:'5678'})).json();
  const created = await post('/api/reports', {description:'Fixture report', pageUrl: origin + '/page'}, {'X-Reporter-Token':fresh.token});
  assert.equal(created.status, 201);
  const {id} = await created.json();
  assert.equal((await fetch(base + '/api/reports/' + id, {headers:{Authorization:'Bearer ' + staffToken}})).status, 200);
  for (const path of ['/api/me', '/api/reports', '/api/reports/' + id, '/api/reports/' + id + '/screenshot', '/api/reports/' + id + '/attachment']) {
    assert.equal((await fetch(base + path, {headers:{Authorization:'Bearer ' + fresh.token}})).status, 401);
  }
  assert.equal((await fetch(base + '/api/reports/' + id, {method:'PATCH', headers:{Authorization:'Bearer ' + fresh.token, 'Content-Type':'application/json'}, body:'{}'})).status, 401);
  assert.equal((await post('/api/panel/login', {projectId:'site', name:'New reporter', pin:'5678'})).status, 403);
  assert.equal((await post('/api/panel/register', {projectId:'site', name:'Other', pin:'5678'})).status, 403);
  assert.equal((await fetch(base + '/api/reports', {headers:{Authorization:'Bearer team-token'}})).status, 200);
  await stop();
  project.panelAccountIds = ['00000000-0000-4000-8000-000000000000'];
  assert.throws(() => createApp(config, {rootDir: directory, database:'./reports.sqlite'}), /Unknown panel account/);
  project.panelAccountIds = null;
  assert.throws(() => createApp(config, {rootDir: directory, database:'./reports.sqlite'}), /Invalid panel account allowlist/);
});
