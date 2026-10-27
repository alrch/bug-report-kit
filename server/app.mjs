import {sanitizeReportUrl} from '../shared/report-url.mjs';
import {createServer} from 'node:http';
import {readFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {randomUUID, timingSafeEqual, createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {applyAction, STATUSES} from './workflow.mjs';
import {getPeriodSummary, summaryHtml} from './summary.mjs';
import {createReporterAuth} from './reporter-auth.mjs';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BODY = 11 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_ATTACHMENT = 5 * 1024 * 1024;
const limiter = new Map();
const safeText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const SECRET_KEY = /authorization|cookie|token|password|secret|api.?key|session/i;
const redactString = (value, max) => safeText(value, max)
  .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  .replace(/\b(token|password|secret|api.?key|session)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
  .replace(/([?&](?:token|key|secret|password|session)\s*=)[^&#\s]+/gi, '$1[redacted]');
const DIAGNOSTIC_TEXT = {type: 80, message: 500, source: 240, at: 40,
  occurredAt: 40, level: 20, eventType: 80, requestId: 120, errorId: 120,
  method: 16, path: 600, errorName: 160, stack: 2000};
const diagnosticsFrom = (value) => Array.isArray(value) ? value.slice(0, 20).map((item) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const result = {};
  for (const [key, max] of Object.entries(DIAGNOSTIC_TEXT)) {
    if (item[key] == null) continue;
    const raw = key === 'path' ? String(item[key]).split(/[?#]/)[0] : item[key];
    result[key] = SECRET_KEY.test(key) ? '[redacted]' : redactString(raw, max);
  }
  for (const key of ['statusCode', 'durationMs']) {
    if (Number.isFinite(item[key]) && item[key] >= 0 && item[key] <= 1_000_000) result[key] = item[key];
  }
  return Object.keys(result).length ? result : null;
}).filter(Boolean) : [];
const fingerprintFor = (projectId, page, title) => createHash('sha256')
  .update(`${projectId}\n${page.pathname}\n${title.toLowerCase().replace(/\s+/g, ' ').trim()}`)
  .digest('hex').slice(0, 20);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const STATUS_LABELS = {new: 'Новый', triaged: 'В очереди',
  in_progress: 'Исправляется', ready_for_check: 'Проверить исправление', closed: 'Исправлен',
  cancelled: 'Отменён'};
const htmlText = (title, value) => value ? `<section><h2>${title}</h2><p class="body">${escapeHtml(value)}</p></section>` : '';

function sameToken(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

function environmentFrom(url) {
  const host = url.hostname.toLowerCase();
  return ['localhost', '127.0.0.1', '[::1]'].includes(host) ? 'local' : host;
}

function parseScreenshot(value) {
  if (!value) return null;
  if (typeof value !== 'string') throw new Error('Некорректный снимок');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || !IMAGE_MIMES.has(match[1])) throw new Error('Поддерживаются PNG, JPEG и WebP');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > MAX_IMAGE) throw new Error('Снимок должен быть не больше 2 МБ');
  const valid = match[1] === 'image/png' ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : match[1] === 'image/jpeg' ? data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new Error('Содержимое снимка не соответствует формату');
  return {mime: match[1], data};
}

function parseAttachment(value) {
  if (!value) return null;
  if (typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string'
    || typeof value.data !== 'string') throw new Error('Некорректное вложение');
  const name = value.name.split(/[\\/]/).at(-1).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 180);
  if (!name) throw new Error('Укажите имя вложения');
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value.data);
  if (!match) throw new Error('Некорректные данные вложения');
  if (match[2].length > Math.ceil(MAX_ATTACHMENT / 3) * 4 + 4) throw new Error('Файл должен быть не больше 5 МБ');
  const data = Buffer.from(match[2], 'base64');
  if (data.length > MAX_ATTACHMENT || data.toString('base64') !== match[2]) throw new Error('Файл должен быть не больше 5 МБ или имеет неверный формат передачи');
  return {name, mime: safeText(match[1], 120) || 'application/octet-stream', data};
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const error = new Error('Запрос слишком большой');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = new Error('Некорректный JSON'); error.status = 400; throw error; }
}

function json(res, status, value) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(value));
}

function rowToReport(row) {
  return {
    id: row.id, projectId: row.project_id, createdAt: row.created_at,
    updatedAt: row.updated_at, revision: row.revision, status: row.status,
    title: row.title || row.description.slice(0, 120), description: row.description,
    reporterName: row.reporter_name || 'Анонимный пользователь', reporterContact: row.reporter_contact || '',
    reporterId: row.reporter_id || '',
    steps: row.steps || '', expected: row.expected || '', actual: row.actual || '',
    pageUrl: row.page_url, origin: row.origin, userAgent: row.user_agent || '',
    environment: row.environment, appVersion: row.app_version || '', viewport: JSON.parse(row.viewport),
    selection: JSON.parse(row.selection), screenshotAvailable: Boolean(row.screenshot_available ?? row.screenshot),
    attachmentAvailable: Boolean(row.attachment_available ?? row.attachment),
    attachmentName: row.attachment_name || '', attachmentMime: row.attachment_mime || '',
    attachmentSize: row.attachment_size ?? row.attachment?.length ?? 0,
    priority: row.priority || 'normal', assignee: row.assignee || '', agentState: row.agent_state || 'idle',
    pendingQuestion: row.pending_question || '', fingerprint: row.fingerprint || '', duplicateOf: row.duplicate_of || '',
    diagnostics: JSON.parse(row.diagnostics || '[]'), rootCause: row.root_cause,
    resolution: row.resolution, fixEvidence: JSON.parse(row.fix_evidence || '{}'),
    verificationNote: row.verification_note || '', acceptedAt: row.accepted_at || null,
    history: JSON.parse(row.history),
  };
}

export function createApp(config, {rootDir = process.cwd(), database = config.database || './data/reports.sqlite'} = {}) {
  if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('Настройте проекты');
  if (!Array.isArray(config.teamTokens) || !config.teamTokens.length) throw new Error('Настройте доступ команды');
  const databasePath = resolve(rootDir, database);
  mkdirSync(dirname(databasePath), {recursive: true});
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL, steps TEXT NOT NULL DEFAULT '',
      reporter_name TEXT NOT NULL DEFAULT 'Анонимный пользователь', reporter_contact TEXT NOT NULL DEFAULT '',
      reporter_id TEXT NOT NULL DEFAULT '',
      expected TEXT NOT NULL DEFAULT '', actual TEXT NOT NULL DEFAULT '',
      page_url TEXT NOT NULL, origin TEXT NOT NULL, user_agent TEXT NOT NULL DEFAULT '',
      environment TEXT NOT NULL, app_version TEXT NOT NULL DEFAULT '', viewport TEXT NOT NULL, selection TEXT NOT NULL,
      screenshot BLOB, screenshot_mime TEXT,
      attachment BLOB, attachment_name TEXT NOT NULL DEFAULT '', attachment_mime TEXT NOT NULL DEFAULT '',
      root_cause TEXT NOT NULL DEFAULT '',
      resolution TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'normal',
      assignee TEXT NOT NULL DEFAULT '', agent_state TEXT NOT NULL DEFAULT 'idle',
      pending_question TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '',
      duplicate_of TEXT NOT NULL DEFAULT '', diagnostics TEXT NOT NULL DEFAULT '[]',
      fix_evidence TEXT NOT NULL DEFAULT '{}', verification_note TEXT NOT NULL DEFAULT '',
      accepted_at TEXT, history TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_project_created ON reports(project_id, created_at DESC);`);
  const columns = new Set(db.prepare('PRAGMA table_info(reports)').all().map((column) => column.name));
  const additions = {
    app_version: "TEXT NOT NULL DEFAULT ''", title: "TEXT NOT NULL DEFAULT ''",
    reporter_name: "TEXT NOT NULL DEFAULT 'Анонимный пользователь'", reporter_contact: "TEXT NOT NULL DEFAULT ''",
    reporter_id: "TEXT NOT NULL DEFAULT ''",
    steps: "TEXT NOT NULL DEFAULT ''", expected: "TEXT NOT NULL DEFAULT ''",
    actual: "TEXT NOT NULL DEFAULT ''", user_agent: "TEXT NOT NULL DEFAULT ''",
    priority: "TEXT NOT NULL DEFAULT 'normal'", assignee: "TEXT NOT NULL DEFAULT ''",
    agent_state: "TEXT NOT NULL DEFAULT 'idle'", pending_question: "TEXT NOT NULL DEFAULT ''",
    fingerprint: "TEXT NOT NULL DEFAULT ''", duplicate_of: "TEXT NOT NULL DEFAULT ''",
    diagnostics: "TEXT NOT NULL DEFAULT '[]'", fix_evidence: "TEXT NOT NULL DEFAULT '{}'",
    verification_note: "TEXT NOT NULL DEFAULT ''", accepted_at: 'TEXT',
    attachment: 'BLOB', attachment_name: "TEXT NOT NULL DEFAULT ''",
    attachment_mime: "TEXT NOT NULL DEFAULT ''",
  };
  for (const [column, definition] of Object.entries(additions)) {
    if (!columns.has(column)) db.exec(`ALTER TABLE reports ADD COLUMN ${column} ${definition}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS reports_accepted ON reports(project_id, accepted_at);');
  db.exec('CREATE INDEX IF NOT EXISTS reports_fingerprint ON reports(project_id, fingerprint);');
  const reporterAuth = createReporterAuth(db, config);

  const selectOne = db.prepare('SELECT * FROM reports WHERE id = ?');
  const insert = db.prepare(`INSERT INTO reports
    (id,project_id,created_at,updated_at,revision,status,title,description,steps,expected,actual,
     page_url,origin,user_agent,environment,app_version,viewport,selection,screenshot,screenshot_mime,
     attachment,attachment_name,attachment_mime,
     fingerprint,diagnostics,history,reporter_name,reporter_contact,reporter_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare(`UPDATE reports SET updated_at=?,revision=?,status=?,priority=?,assignee=?,
    agent_state=?,pending_question=?,root_cause=?,resolution=?,fix_evidence=?,verification_note=?,
    accepted_at=?,duplicate_of=?,history=? WHERE id=? AND revision=?`);

  const allowedOrigin = (origin) => config.projects.some((project) =>
    Array.isArray(project.allowedOrigins) && project.allowedOrigins.includes(origin));
  const actorFor = (req) => {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
    const team = config.teamTokens.find((actor) => actor.token && sameToken(actor.token, bearer));
    if (team) return team;
    for (const project of config.projects) {
      if (!project.reporterAuth || !project.panelAccess) continue;
      const account = reporterAuth.accountForToken(project, bearer);
      if (account) return {name: account.name, role: 'reviewer', projects: [project.id]};
    }
    return null;
  };
  const canSee = (actor, projectId) => actor && actor.projects?.includes(projectId);
  const projectFor = (key) => config.projects.find((project) => project.widgetKey === key);
  const clientIpFor = (req) => {
    const forwarded = req.headers['x-real-ip'];
    return config.trustProxy && typeof forwarded === 'string' && isIP(forwarded)
      ? forwarded : req.socket.remoteAddress;
  };

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    if (origin && allowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Project-Key, X-Reporter-Token, Authorization, X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        db.prepare('SELECT 1 AS ok').get();
        return json(res, 200, {ok: true});
      }
      if (req.method === 'GET' && url.pathname === '/widget.js') {
        const path = resolve(rootDir, 'dist/widget.js');
        if (!existsSync(path)) return json(res, 503, {error: 'Сначала выполните npm run build'});
        res.writeHead(200, {'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(readFileSync(path));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/widget.css') {
        res.writeHead(200, {'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(readFileSync(resolve(import.meta.dirname, '../widget/widget.css')));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/panel/projects') {
        return json(res, 200, config.projects.filter((project) => project.reporterAuth && project.panelAccess)
          .map(({id, name, reporterRegistration}) => ({id, name: name || id, reporterRegistration: reporterRegistration !== false})));
      }
      if (req.method === 'POST' && ['/api/panel/login', '/api/panel/register'].includes(url.pathname)) {
        const body = await readJson(req);
        const project = config.projects.find((item) => item.id === body?.projectId
          && item.reporterAuth && item.panelAccess);
        if (!project) return json(res, 403, {error: 'Доступ к панели для проекта не настроен'});
        const result = url.pathname.endsWith('/register')
          ? await reporterAuth.register(project, body, clientIpFor(req))
          : await reporterAuth.login(project, body, clientIpFor(req));
        const {status, ...payload} = result;
        return json(res, status, payload);
      }
      if (req.method === 'POST' && url.pathname === '/api/panel/logout') {
        const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
        if (actorFor(req)) reporterAuth.logout(bearer);
        return json(res, 200, {ok: true});
      }
      if (url.pathname.startsWith('/api/reporter/')) {
        const project = projectFor(req.headers['x-project-key']);
        if (!project?.reporterAuth || !origin || !project.allowedOrigins?.includes(origin)) {
          return json(res, 403, {error: 'Проект или адрес не разрешён'});
        }
        if (req.method === 'POST' && url.pathname === '/api/reporter/options') {
          return json(res, 200, {registrationEnabled: project.reporterRegistration !== false});
        }
        if (req.method === 'POST' && url.pathname === '/api/reporter/register') {
          const result = await reporterAuth.register(project, await readJson(req), clientIpFor(req));
          const {status, ...payload} = result;
          return json(res, status, payload);
        }
        if (req.method === 'POST' && url.pathname === '/api/reporter/login') {
          const result = await reporterAuth.login(project, await readJson(req), clientIpFor(req));
          const {status, ...payload} = result;
          return json(res, status, payload);
        }
        const token = req.headers['x-reporter-token'];
        if (['GET', 'POST'].includes(req.method) && url.pathname === '/api/reporter/me') {
          const account = reporterAuth.accountForToken(project, token);
          return account ? json(res, 200, {reporter: {id: account.id, name: account.name}})
            : json(res, 401, {error: 'Войдите для отправки бага'});
        }
        if (req.method === 'POST' && url.pathname === '/api/reporter/logout') {
          reporterAuth.logout(token);
          return json(res, 200, {ok: true});
        }
        return json(res, 405, {error: 'Метод не поддерживается'});
      }
      if (req.method === 'POST' && url.pathname === '/api/reports') {
        const project = projectFor(req.headers['x-project-key']);
        if (!project || !origin || !project.allowedOrigins?.includes(origin)) return json(res, 403, {error: 'Проект или адрес не разрешён'});
        const account = project.reporterAuth ? reporterAuth.accountForToken(project, req.headers['x-reporter-token']) : null;
        if (project.reporterAuth && !account) return json(res, 401, {error: 'Войдите для отправки бага'});
        const clientIp = clientIpFor(req);
        const rateKey = `${project.id}:${clientIp}`;
        const current = limiter.get(rateKey) || {count: 0, until: Date.now() + 60_000};
        if (Date.now() > current.until) { current.count = 0; current.until = Date.now() + 60_000; }
        if (++current.count > 20) return json(res, 429, {error: 'Слишком много сообщений'});
        limiter.set(rateKey, current);
        const body = await readJson(req);
        const description = safeText(body.description, 4000);
        if (!description) return json(res, 400, {error: 'Опишите проблему'});
        const title = safeText(body.title, 160) || description.split('\n')[0].slice(0, 160);
        const steps = safeText(body.steps, 2000);
        const expected = safeText(body.expected, 2000);
        const actual = safeText(body.actual, 2000);
        const reporterName = account?.name || safeText(body.reporterName, 120) || 'Анонимный пользователь';
        const reporterContact = account ? '' : safeText(body.reporterContact, 240);
        const reporterId = account?.id || safeText(body.reporterId, 120);
        let page;
        try { page = new URL(body.pageUrl); }
        catch { return json(res, 400, {error: 'Некорректный адрес страницы'}); }
        if (!['http:', 'https:'].includes(page.protocol) || page.origin !== origin) return json(res, 400, {error: 'Адрес страницы не совпадает с источником'});
        page = new URL(sanitizeReportUrl(page.href));
        const screenshot = parseScreenshot(body.screenshot);
        const attachment = parseAttachment(body.attachment);
        const appVersion = safeText(body.appVersion, 120);
        const userAgent = safeText(body.userAgent, 300);
        const diagnostics = diagnosticsFrom(body.diagnostics);
        const viewport = body.viewport && typeof body.viewport === 'object' ? body.viewport : {};
        const selection = body.selection && typeof body.selection === 'object' ? body.selection : {};
        const now = new Date().toISOString();
        const id = randomUUID();
        const history = [{at: now, actor: 'reporter', action: 'create', status: 'new', note: 'Создано'}];
        insert.run(id, project.id, now, now, 0, 'new', title, description, steps, expected, actual,
          page.toString(), origin, userAgent, environmentFrom(page), appVersion,
          JSON.stringify(viewport), JSON.stringify(selection), screenshot?.data || null,
          screenshot?.mime || null, attachment?.data || null, attachment?.name || '', attachment?.mime || '',
          fingerprintFor(project.id, page, title),
          JSON.stringify(diagnostics), JSON.stringify(history), reporterName, reporterContact, reporterId);
        return json(res, 201, {id, status: 'new', reportUrl: `/reports/${id}`});
      }

      if (url.pathname.startsWith('/api/')) {
        const actor = actorFor(req);
        if (!actor) return json(res, 401, {error: 'Войдите в панель'});
        if (req.method === 'GET' && url.pathname === '/api/me') {
          return json(res, 200, {name: actor.name, role: actor.role || 'admin'});
        }
        if (req.method === 'GET' && url.pathname === '/api/projects') {
          return json(res, 200, config.projects.filter((project) => canSee(actor, project.id))
            .map(({id, name, repositories = []}) => ({id, name, repositories})));
        }
        if (req.method === 'GET' && ['/api/summary', '/api/summary/html'].includes(url.pathname)) {
          const projectId = url.searchParams.get('project') || '';
          if (projectId && !canSee(actor, projectId)) return json(res, 403, {error: 'Нет доступа к проекту'});
          const summary = getPeriodSummary(db, actor.projects || [], url.searchParams);
          if (url.pathname === '/api/summary') return json(res, 200, summary);
          res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"});
          res.end(summaryHtml(summary));
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/reports') {
          const projectId = url.searchParams.get('project') || '';
          if (projectId && !canSee(actor, projectId)) return json(res, 403, {error: 'Нет доступа к проекту'});
          const ids = actor.projects || [];
          if (!ids.length) return json(res, 200, []);
          const status = url.searchParams.get('status') || '';
          if (status && !STATUSES.includes(status)) return json(res, 400, {error: 'Неизвестный статус'});
          const offsetRaw = url.searchParams.get('offset') || '0';
          if (!/^\d{1,7}$/.test(offsetRaw)) return json(res, 400, {error: 'Некорректный номер страницы'});
          const clauses = [`project_id IN (${ids.map(() => '?').join(',')})`];
          const params = [...ids];
          if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
          if (status) { clauses.push('status = ?'); params.push(status); }
          const rows = db.prepare(`SELECT id,project_id,created_at,updated_at,revision,status,
            title,description,steps,expected,actual,page_url,origin,user_agent,environment,app_version,
            viewport,selection,priority,assignee,agent_state,pending_question,fingerprint,duplicate_of,
            diagnostics,root_cause,resolution,fix_evidence,verification_note,accepted_at,history,
            reporter_name,reporter_contact,reporter_id,attachment_name,attachment_mime,
            CASE WHEN screenshot IS NULL THEN 0 ELSE 1 END AS screenshot_available,
            CASE WHEN attachment IS NULL THEN 0 ELSE 1 END AS attachment_available,
            COALESCE(length(attachment),0) AS attachment_size
            FROM reports WHERE ${clauses.join(' AND ')}
            ORDER BY created_at DESC, rowid DESC LIMIT 100 OFFSET ?`).all(...params, Number(offsetRaw));
          return json(res, 200, rows.map(rowToReport));
        }
        const match = /^\/api\/reports\/([^/]+)(?:\/(screenshot|attachment|html|related))?$/.exec(url.pathname);
        if (!match) return json(res, 404, {error: 'Не найдено'});
        const row = selectOne.get(match[1]);
        if (!row) return json(res, 404, {error: 'Баг не найден'});
        if (!canSee(actor, row.project_id)) return json(res, 403, {error: 'Нет доступа к проекту'});
        if (req.method === 'GET' && match[2] === 'related') {
          if (!row.fingerprint) return json(res, 200, []);
          const related = db.prepare(`SELECT id,title,status,environment,created_at AS createdAt
            FROM reports WHERE project_id=? AND fingerprint=? AND id<>?
            ORDER BY created_at DESC LIMIT 20`).all(row.project_id, row.fingerprint, row.id);
          return json(res, 200, related);
        }
        if (req.method === 'GET' && match[2] === 'screenshot') {
          if (!row.screenshot) return json(res, 404, {error: 'Снимок не найден'});
          res.writeHead(200, {'Content-Type': row.screenshot_mime, 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'});
          res.end(row.screenshot);
          return;
        }
        if (req.method === 'GET' && match[2] === 'attachment') {
          if (!row.attachment) return json(res, 404, {error: 'Вложение не найдено'});
          res.writeHead(200, {'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(row.attachment_name)}`,
            'X-Content-Type-Options': 'nosniff'});
          res.end(row.attachment);
          return;
        }
        if (req.method === 'GET' && match[2] === 'html') {
          const report = rowToReport(row);
          const shot = row.screenshot ? `<img alt="Снимок" style="max-width:100%" src="data:${row.screenshot_mime};base64,${row.screenshot.toString('base64')}">` : '<p>Снимка нет</p>';
          const attached = row.attachment ? `<p><a download="${escapeHtml(row.attachment_name)}" href="data:application/octet-stream;base64,${row.attachment.toString('base64')}">${escapeHtml(row.attachment_name)}</a> (${row.attachment.length} байт)</p>` : '<p>Файла нет</p>';
          const project = config.projects.find((item) => item.id === row.project_id);
          const repositories = Array.isArray(project?.repositories) ? project.repositories : [];
          const history = report.history.map((item) => `<li><time>${escapeHtml(new Date(item.at).toLocaleString('ru-RU'))}</time> · <b>${escapeHtml(item.action === 'create' ? report.reporterName : item.actor)}</b> · ${escapeHtml(STATUS_LABELS[item.status] || item.status)}${item.note ? ` — ${escapeHtml(item.note)}` : ''}</li>`).join('');
          const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.title)} · Bug Report Kit</title><style>
            *{box-sizing:border-box}body{font:16px/1.55 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:28px 20px 80px;color:#182237;background:#f5f7fb}
            main{background:#fff;border:1px solid #dfe5f0;border-radius:16px;padding:32px}h1{font-size:30px;line-height:1.2;margin:0 0 12px}h2{font-size:19px;margin:0 0 10px}
            section{margin:26px 0}.body{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.meta{color:#58667e;margin:8px 0;overflow-wrap:anywhere}
            .status{display:inline-block;background:#e9efff;color:#2047a5;border-radius:99px;padding:4px 12px;font-weight:700;margin:0 0 10px}
            .capture{display:block;max-width:100%;max-height:600px;object-fit:contain;margin:auto;border:1px solid #e1e6ef;border-radius:10px}
            .file{display:inline-block;padding:10px 14px;border:1px solid #ccd6e9;border-radius:9px;color:#2047a5;text-decoration:none}
            details{border-top:1px solid #e3e8f0;padding:18px 0}summary{cursor:pointer;font-weight:700}ol{padding-left:24px}li{margin:10px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}
            @media(max-width:600px){body{padding:0;background:#fff}main{border:0;border-radius:0;padding:20px}h1{font-size:25px}}
          </style><main><span class="status">${escapeHtml(STATUS_LABELS[report.status] || report.status)}</span><h1>${escapeHtml(report.title)}</h1>
          <p class="meta">${escapeHtml(report.reporterName)} · ${escapeHtml(new Date(row.created_at).toLocaleString('ru-RU'))} · ${escapeHtml(row.environment)}</p>
          <p class="meta">${escapeHtml(row.page_url)}</p>
          ${htmlText('Суть бага', row.description)}${htmlText('Что ожидалось', report.expected)}
          ${row.screenshot ? `<section><h2>Снимок</h2>${shot}</section>` : ''}
          ${row.attachment ? `<section><h2>Приложенный файл</h2>${attached}</section>` : ''}
          ${htmlText('Что исправлено', row.resolution)}${htmlText('Результат проверки', report.verificationNote)}
          <details><summary>История изменений</summary><ol>${history}</ol></details>
          <details><summary>Технические сведения</summary><p class="meta">ID: ${escapeHtml(row.id)} · Проект: ${escapeHtml(row.project_id)} · Версия: ${escapeHtml(row.app_version || 'не указана')}</p>
            ${report.reporterId ? `<p class="meta">ID автора: ${escapeHtml(report.reporterId)}</p>` : ''}
            ${report.reporterContact ? `<p class="meta">Контакт автора: ${escapeHtml(report.reporterContact)}</p>` : ''}
            ${htmlText('Как повторить', report.steps)}${htmlText('Фактически', report.actual)}${htmlText('Причина', row.root_cause)}
            ${htmlText('Диагностика', report.diagnostics.length ? JSON.stringify(report.diagnostics, null, 2) : '')}
            ${htmlText('Код и проверки', Object.keys(report.fixEvidence).length ? JSON.stringify(report.fixEvidence, null, 2) : '')}
            ${repositories.length ? htmlText('Репозитории', repositories.map((item) => `${item.name}: ${item.url}`).join('\n')) : ''}
          </details></main></html>`;
          res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'"});
          res.end(html);
          return;
        }
        if (req.method === 'GET' && !match[2]) return json(res, 200, {
          ...rowToReport(row), repositories: config.projects.find((item) => item.id === row.project_id)?.repositories || [],
        });
        if (req.method === 'PATCH' && !match[2]) {
          const body = await readJson(req);
          if (!Number.isInteger(body.revision) || body.revision !== row.revision) return json(res, 409, {error: 'Карточка уже изменилась'});
          const now = new Date().toISOString();
          if (body.action === 'group' && body.duplicateOf) {
            const parent = selectOne.get(body.duplicateOf);
            if (!parent || parent.project_id !== row.project_id || parent.id === row.id || parent.duplicate_of) {
              return json(res, 400, {error: 'Группировать можно с основным багом того же проекта'});
            }
          }
          const next = applyAction(row, body, actor, now);
          const result = update.run(now, row.revision + 1, next.status, next.priority, next.assignee,
            next.agentState, next.pendingQuestion, next.rootCause, next.resolution,
            JSON.stringify(next.fixEvidence), next.verificationNote, next.acceptedAt,
            next.duplicateOf, JSON.stringify(next.history), row.id, row.revision);
          if (!result.changes) return json(res, 409, {error: 'Карточка уже изменилась'});
          return json(res, 200, rowToReport(selectOne.get(row.id)));
        }
        return json(res, 405, {error: 'Метод не поддерживается'});
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/reports/'))) {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(readFileSync(resolve(rootDir, 'dashboard/index.html')));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/dashboard.js') {
        res.writeHead(200, {'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(readFileSync(resolve(rootDir, 'dashboard/dashboard.js')));
        return;
      }
      json(res, 404, {error: 'Не найдено'});
    } catch (error) {
      json(res, error.status || 400, {error: error.message || 'Ошибка'});
    }
  });
  return {server, db, close: () => {server.close(); db.close();}};
}
