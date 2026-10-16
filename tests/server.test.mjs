import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/app.mjs';
const execFileAsync = promisify(execFile);

test('reporter creates a report; team reads, updates, and views HTML', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const config = {
    projects: [{id: 'site', name: 'Site', widgetKey: 'public-widget-key',
      allowedOrigins: ['http://localhost:7338']}],
    teamTokens: [
      {name: 'Developer', role: 'developer', token: 'private-team-token', projects: ['site']},
      {name: 'Reviewer', role: 'reviewer', token: 'reviewer-token', projects: ['site']},
    ],
  };
  const app = createApp(config, {rootDir: directory, database: './reports.sqlite'});
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), {ok: true});
  const preflight = await fetch(`${base}/api/reports`, {method: 'OPTIONS', headers: {
    Origin: 'http://localhost:7338', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-project-key,x-request-id',
  }});
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /\bX-Request-Id\b/i);
  assert.match(await (await fetch(`${base}/widget.css`)).text(), /\.launcher/);
  const auth = {Authorization: 'Bearer private-team-token'};
  const reviewer = {Authorization: 'Bearer reviewer-token'};
  const screenshot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const fileBytes = Buffer.from('broken document bytes');
  const attachment = {name: 'export & check.docx',
    data: `data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${fileBytes.toString('base64')}`};
  const created = await fetch(`${base}/api/reports`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: 'http://localhost:7338',
      'X-Project-Key': 'public-widget-key'},
    body: JSON.stringify({title: 'Кнопка не нажимается', description: 'Кнопка не нажимается',
      steps: 'Нажать кнопку', expected: 'Откроется форма', actual: 'Ничего',
      diagnostics: [{type: 'error', message: 'Bearer hidden-token failed',
        eventType: 'CLIENT_REQUEST_ERROR', method: 'POST', path: '/save?token=secret',
        statusCode: 500, requestId: 'REQ-123'}],
      pageUrl: 'http://localhost:7338/page?token=secret',
      appVersion: 'dev-123', screenshot, attachment, selection: {x: 1, y: 2, width: 30, height: 40},
      reporterName: 'Иван <Тест>', reporterContact: 'ivan@example.test', reporterId: 'user-42'}),
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
  assert.equal(detail.attachmentAvailable, true);
  assert.equal(detail.attachmentName, 'export & check.docx');
  assert.equal(detail.attachmentSize, fileBytes.length);
  const fileResponse = await fetch(`${base}/api/reports/${id}/attachment`, {headers: auth});
  assert.equal(fileResponse.status, 200);
  assert.equal(fileResponse.headers.get('content-type'), 'application/octet-stream');
  assert.match(fileResponse.headers.get('content-disposition'), /attachment; filename=/);
  assert.deepEqual(Buffer.from(await fileResponse.arrayBuffer()), fileBytes);
  assert.equal(detail.steps, 'Нажать кнопку');
  assert.equal(detail.reporterName, 'Иван <Тест>');
  assert.equal(detail.reporterContact, 'ivan@example.test');
  assert.equal(detail.reporterId, 'user-42');
  const listed = await (await fetch(`${base}/api/reports`, {headers: auth})).json();
  assert.equal(listed[0].reporterName, 'Иван <Тест>');
  assert.equal(listed[0].reporterId, 'user-42');
  assert.equal(listed[0].attachmentName, 'export & check.docx');
  assert.equal(detail.diagnostics[0].message, 'Bearer [redacted] failed');
  assert.equal(detail.diagnostics[0].path, '/save');
  assert.equal(detail.diagnostics[0].statusCode, 500);
  assert.equal(detail.diagnostics[0].requestId, 'REQ-123');
  const helper = fileURLToPath(new URL('../scripts/bug-kit-agent.mjs', import.meta.url));
  const cli = await execFileAsync(process.execPath, [helper, 'show', id], {
    env: {...process.env, BUG_KIT_URL: base, BUG_KIT_TOKEN: 'private-team-token'},
  });
  assert.equal(JSON.parse(cli.stdout).id, id);
  assert.equal(JSON.parse(cli.stdout).reporterName, 'Иван <Тест>');
  assert.equal(JSON.parse(cli.stdout).reporterId, 'user-42');
  const savedFile = join(directory, 'downloaded.docx');
  await execFileAsync(process.execPath, [helper, 'attachment', id, savedFile], {
    env: {...process.env, BUG_KIT_URL: base, BUG_KIT_TOKEN: 'private-team-token'},
  });
  assert.deepEqual(readFileSync(savedFile), fileBytes);
  const action = (revision, name, values = {}, headers = auth) => fetch(`${base}/api/reports/${id}`, {
    method: 'PATCH', headers: {...headers, 'Content-Type': 'application/json'},
    body: JSON.stringify({revision, action: name, ...values}),
  });
  const directClose = await action(0, 'accept', {note: 'Проверено'}, reviewer);
  assert.equal(directClose.status, 409);
  const bypass = await fetch(`${base}/api/reports/${id}`, {method: 'PATCH',
    headers: {...reviewer, 'Content-Type': 'application/json'},
    body: JSON.stringify({revision: 0, status: 'closed'})});
  assert.equal(bypass.status, 400);
  assert.equal((await action(0, 'claim')).status, 200);
  assert.equal((await action(1, 'start')).status, 200);
  assert.equal((await action(2, 'ask', {note: 'На каком устройстве?'})).status, 200);
  const blockedResolve = await action(3, 'resolve', {rootCause: 'Причина', resolution: 'Исправлено'});
  assert.equal(blockedResolve.status, 409);
  assert.equal((await action(3, 'answer', {note: 'На ноутбуке'}, reviewer)).status, 200);
  const failedCheck = await action(4, 'resolve', {
    rootCause: 'Обработчик не привязан', resolution: 'Привязали обработчик',
    fixEvidence: {repositories: [{name: 'site-web', ref: 'abc123'}],
      checks: [{name: 'smoke', result: 'failed'}]},
  });
  assert.equal(failedCheck.status, 400);
  const resolved = await action(4, 'resolve', {
    rootCause: 'Обработчик не привязан', resolution: 'Привязали обработчик',
    fixEvidence: {repositories: [{name: 'site-web', ref: 'abc123'}],
      checks: [{name: 'smoke', result: 'passed'}]},
  });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).status, 'ready_for_check');
  assert.equal((await action(5, 'accept', {note: 'Сам проверил'})).status, 409);
  assert.equal((await action(5, 'accept', {note: 'Проверено на dev'}, reviewer)).status, 200);
  const stale = await fetch(`${base}/api/reports/${id}`, {
    method: 'PATCH', headers: {...auth, 'Content-Type': 'application/json'},
    body: JSON.stringify({revision: 0, action: 'claim'}),
  });
  assert.equal(stale.status, 409);
  const html = await (await fetch(`${base}/api/reports/${id}/html`, {headers: auth})).text();
  assert.match(html, /Обработчик не привязан/);
  assert.match(html, /Иван &lt;Тест&gt;/);
  assert.match(html, /ivan@example\.test/);
  assert.match(html, /user-42/);
  assert.doesNotMatch(html, /Иван <Тест>/);
  assert.match(html, /dev-123/);
  assert.match(html, /data:image\/png;base64/);
  assert.match(html, /export &amp; check\.docx/);
  assert.match(html, /data:application\/octet-stream;base64/);
  assert.doesNotMatch(html, /token=secret/);
  assert.doesNotMatch(html, /hidden-token/);
  const day = new Date().toISOString().slice(0, 10);
  const summary = await (await fetch(`${base}/api/summary?from=${day}&to=${day}&groupBy=environment`,
    {headers: reviewer})).json();
  assert.equal(summary.created, 1);
  assert.equal(summary.fixed, 1);
  assert.equal(summary.fixedGroups[0].key, 'local');
  const periodHtml = await (await fetch(`${base}/api/summary/html?from=${day}&to=${day}`,
    {headers: reviewer})).text();
  assert.match(periodHtml, /Привязали обработчик/);
  const second = await fetch(`${base}/api/reports`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://localhost:7338',
      'X-Project-Key': 'public-widget-key'},
    body: JSON.stringify({title: 'Кнопка не нажимается', description: 'Другой случай',
      pageUrl: 'http://localhost:7338/page'}),
  });
  const secondId = (await second.json()).id;
  const related = await (await fetch(`${base}/api/reports/${secondId}/related`, {headers: reviewer})).json();
  assert.equal(related[0].id, id);
  const grouped = await fetch(`${base}/api/reports/${secondId}`, {method: 'PATCH',
    headers: {...reviewer, 'Content-Type': 'application/json'},
    body: JSON.stringify({revision: 0, action: 'group', duplicateOf: id, note: 'Один корень'}),
  });
  assert.equal(grouped.status, 200);
  assert.equal((await grouped.json()).duplicateOf, id);
  const groupedSummary = await (await fetch(`${base}/api/summary?from=${day}&to=${day}&groupBy=group`,
    {headers: reviewer})).json();
  assert.equal(groupedSummary.created, 2);
  assert.equal(groupedSummary.createdGroups.length, 1);
  assert.equal(groupedSummary.createdGroups[0].count, 2);
});

test('existing version 0.1 database is migrated without losing reports', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, 'reports.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE reports (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
    description TEXT NOT NULL, page_url TEXT NOT NULL, origin TEXT NOT NULL,
    environment TEXT NOT NULL, app_version TEXT NOT NULL DEFAULT '',
    viewport TEXT NOT NULL, selection TEXT NOT NULL, screenshot BLOB,
    screenshot_mime TEXT, root_cause TEXT NOT NULL DEFAULT '',
    resolution TEXT NOT NULL DEFAULT '', history TEXT NOT NULL);`);
  old.prepare(`INSERT INTO reports (id,project_id,created_at,updated_at,revision,status,
    description,page_url,origin,environment,app_version,viewport,selection,history)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy', 'site', '2026-01-01T12:00:00.000Z',
    '2026-01-01T12:00:00.000Z', 0, 'new', 'Старый баг', 'https://site.example/page',
    'https://site.example', 'site.example', 'v1', '{}', '{}', '[]');
  old.close();
  const app = createApp({projects: [{id: 'site', widgetKey: 'key', allowedOrigins: ['https://site.example']}],
    teamTokens: [{name: 'Reviewer', role: 'reviewer', token: 'reviewer', projects: ['site']},
      {name: 'Developer', role: 'developer', token: 'developer', projects: ['site']}]},
  {rootDir: directory, database: './reports.sqlite'});
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await new Promise((resolve) => app.server.close(resolve)); app.db.close();});
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/reports/legacy`, {headers: {Authorization: 'Bearer reviewer'}});
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.title, 'Старый баг');
  assert.equal(report.description, 'Старый баг');
  assert.equal(report.priority, 'normal');
  assert.equal(report.status, 'new');
  assert.equal(report.reporterName, 'Анонимный пользователь');
  assert.equal(report.reporterContact, '');
  assert.equal(report.reporterId, '');
  assert.equal(report.attachmentAvailable, false);
  app.db.prepare("UPDATE reports SET status='in_progress' WHERE id='legacy'").run();
  const claimed = await fetch(`${base}/api/reports/legacy`, {method: 'PATCH',
    headers: {Authorization: 'Bearer developer', 'Content-Type': 'application/json'},
    body: JSON.stringify({revision: 0, action: 'claim'})});
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).assignee, 'Developer');
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
  const fakeImage = await fetch(`${base}/api/reports`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://localhost:7338',
      'X-Project-Key': 'public-widget-key'},
    body: JSON.stringify({description: 'Broken image', pageUrl: 'http://localhost:7338/page',
      screenshot: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64')}),
  });
  assert.equal(fakeImage.status, 400);
  const oversizedAttachment = await fetch(`${base}/api/reports`, {
    method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://localhost:7338',
      'X-Project-Key': 'public-widget-key'},
    body: JSON.stringify({description: 'Large file', pageUrl: 'http://localhost:7338/page',
      attachment: {name: 'big.bin', data: `data:;base64,${Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64')}`}}),
  });
  assert.equal(oversizedAttachment.status, 400);
  assert.match((await oversizedAttachment.json()).error, /5 МБ/);
  const forbiddenList = await fetch(`${base}/api/reports?project=site`, {
    headers: {Authorization: 'Bearer other-token'},
  });
  assert.equal(forbiddenList.status, 403);
});
