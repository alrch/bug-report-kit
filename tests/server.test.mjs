import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';

test('reporter creates a report; team reads, updates, and views HTML', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const config = {
    projects: [{id: 'site', name: 'Site', widgetKey: 'public-widget-key',
      allowedOrigins: ['http://localhost:7338']}],
    teamTokens: [{name: 'Developer', token: 'private-team-token', projects: ['site']}],
  };
  const app = createApp(config, {rootDir: directory, database: './reports.sqlite'});
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = {Authorization: 'Bearer private-team-token'};
  const screenshot = 'data:image/png;base64,' + Buffer.from('tiny image').toString('base64');
  const created = await fetch(`${base}/api/reports`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: 'http://localhost:7338',
      'X-Project-Key': 'public-widget-key'},
    body: JSON.stringify({description: 'Кнопка не нажимается',
      pageUrl: 'http://localhost:7338/page?token=secret',
      appVersion: 'dev-123', screenshot, selection: {x: 1, y: 2, width: 30, height: 40}}),
  });
  assert.equal(created.status, 201);
  const {id} = await created.json();
  const blocked = await fetch(`${base}/api/reports/${id}`);
  assert.equal(blocked.status, 401);
  const detail = await (await fetch(`${base}/api/reports/${id}`, {headers: auth})).json();
  assert.equal(detail.environment, 'local');
  assert.equal(detail.appVersion, 'dev-123');
  assert.equal(detail.pageUrl, 'http://localhost:7338/page');
  assert.equal(detail.screenshotAvailable, true);
  const updated = await fetch(`${base}/api/reports/${id}`, {
    method: 'PATCH', headers: {...auth, 'Content-Type': 'application/json'},
    body: JSON.stringify({revision: 0, status: 'ready_for_check',
      rootCause: 'Обработчик не привязан', resolution: 'Привязали обработчик', note: 'Проверено'}),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).history.length, 2);
  const stale = await fetch(`${base}/api/reports/${id}`, {
    method: 'PATCH', headers: {...auth, 'Content-Type': 'application/json'},
    body: JSON.stringify({revision: 0, status: 'closed'}),
  });
  assert.equal(stale.status, 409);
  const html = await (await fetch(`${base}/api/reports/${id}/html`, {headers: auth})).text();
  assert.match(html, /Обработчик не привязан/);
  assert.match(html, /dev-123/);
  assert.match(html, /data:image\/png;base64/);
  assert.doesNotMatch(html, /token=secret/);
});

test('status filtering happens before pagination', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const app = createApp({
    projects: [{id: 'site', name: 'Site', widgetKey: 'public-widget-key',
      allowedOrigins: ['http://localhost:7338']}],
    teamTokens: [{name: 'Developer', token: 'private-team-token', projects: ['site']}],
  }, {rootDir: directory, database: './reports.sqlite'});
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const created = await fetch(`${base}/api/reports`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://localhost:7338',
      'X-Project-Key': 'public-widget-key'},
    body: JSON.stringify({description: 'Old open bug', pageUrl: 'http://localhost:7338/page'}),
  });
  const {id} = await created.json();
  const insert = app.db.prepare(`INSERT INTO reports
    (id,project_id,created_at,updated_at,revision,status,description,page_url,origin,
     environment,app_version,viewport,selection,history)
    SELECT ?,project_id,?,updated_at,revision,'closed',description,page_url,origin,
     environment,app_version,viewport,selection,history FROM reports WHERE id=?`);
  for (let index = 0; index < 201; index += 1) {
    insert.run(`newer-${index}`, '2099-01-01T00:00:00.000Z', id);
  }
  const headers = {Authorization: 'Bearer private-team-token'};
  const filtered = await (await fetch(`${base}/api/reports?status=new`, {headers})).json();
  assert.deepEqual(filtered.map((report) => report.id), [id]);
  const secondPage = await (await fetch(`${base}/api/reports?status=closed&offset=100`, {headers})).json();
  assert.equal(secondPage.length, 100);
});

test('origin and project access are enforced', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const app = createApp({
    projects: [{id: 'site', name: 'Site', widgetKey: 'public-widget-key',
      allowedOrigins: ['http://localhost:7338']}],
    teamTokens: [{name: 'Other', token: 'other-token', projects: ['other']}],
  }, {rootDir: directory, database: './reports.sqlite'});
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const rejected = await fetch(`${base}/api/reports`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: 'http://evil.example',
      'X-Project-Key': 'public-widget-key'},
    body: JSON.stringify({description: 'Hello', pageUrl: 'http://evil.example'}),
  });
  assert.equal(rejected.status, 403);
  const forbiddenList = await fetch(`${base}/api/reports?project=site`, {
    headers: {Authorization: 'Bearer other-token'},
  });
  assert.equal(forbiddenList.status, 403);
});
