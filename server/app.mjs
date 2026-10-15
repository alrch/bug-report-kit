import {createServer} from 'node:http';
import {readFileSync, existsSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const STATUSES = new Set(['new', 'in_progress', 'ready_for_check', 'closed']);
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_BODY = 3 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const limiter = new Map();
const safeText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

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
  return {mime: match[1], data};
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
    description: row.description, pageUrl: row.page_url, origin: row.origin,
    environment: row.environment, appVersion: row.app_version || '', viewport: JSON.parse(row.viewport),
    selection: JSON.parse(row.selection), screenshotAvailable: Boolean(row.screenshot_available ?? row.screenshot),
    rootCause: row.root_cause, resolution: row.resolution, history: JSON.parse(row.history),
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
      description TEXT NOT NULL, page_url TEXT NOT NULL, origin TEXT NOT NULL,
      environment TEXT NOT NULL, app_version TEXT NOT NULL DEFAULT '', viewport TEXT NOT NULL, selection TEXT NOT NULL,
      screenshot BLOB, screenshot_mime TEXT, root_cause TEXT NOT NULL DEFAULT '',
      resolution TEXT NOT NULL DEFAULT '', history TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reports_project_created ON reports(project_id, created_at DESC);`);
  if (!db.prepare('PRAGMA table_info(reports)').all().some((column) => column.name === 'app_version')) {
    db.exec("ALTER TABLE reports ADD COLUMN app_version TEXT NOT NULL DEFAULT ''");
  }

  const selectOne = db.prepare('SELECT * FROM reports WHERE id = ?');
  const insert = db.prepare(`INSERT INTO reports
    (id,project_id,created_at,updated_at,revision,status,description,page_url,origin,
     environment,app_version,viewport,selection,screenshot,screenshot_mime,history)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare(`UPDATE reports SET updated_at=?,revision=?,status=?,root_cause=?,
    resolution=?,history=? WHERE id=? AND revision=?`);

  const allowedOrigin = (origin) => config.projects.some((project) =>
    Array.isArray(project.allowedOrigins) && project.allowedOrigins.includes(origin));
  const actorFor = (req) => {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
    return config.teamTokens.find((actor) => actor.token && sameToken(actor.token, bearer));
  };
  const canSee = (actor, projectId) => actor && actor.projects?.includes(projectId);
  const projectFor = (key) => config.projects.find((project) => project.widgetKey === key);

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin || '';
    if (origin && allowedOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Project-Key, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/widget.js') {
        const path = resolve(rootDir, 'dist/widget.js');
        if (!existsSync(path)) return json(res, 503, {error: 'Сначала выполните npm run build'});
        res.writeHead(200, {'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
        res.end(readFileSync(path));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/reports') {
        const project = projectFor(req.headers['x-project-key']);
        if (!project || !origin || !project.allowedOrigins?.includes(origin)) return json(res, 403, {error: 'Проект или адрес не разрешён'});
        const rateKey = `${project.id}:${req.socket.remoteAddress}`;
        const current = limiter.get(rateKey) || {count: 0, until: Date.now() + 60_000};
        if (Date.now() > current.until) { current.count = 0; current.until = Date.now() + 60_000; }
        if (++current.count > 20) return json(res, 429, {error: 'Слишком много сообщений'});
        limiter.set(rateKey, current);
        const body = await readJson(req);
        const description = safeText(body.description, 4000);
        if (!description) return json(res, 400, {error: 'Опишите проблему'});
        let page;
        try { page = new URL(body.pageUrl); }
        catch { return json(res, 400, {error: 'Некорректный адрес страницы'}); }
        if (!['http:', 'https:'].includes(page.protocol) || page.origin !== origin) return json(res, 400, {error: 'Адрес страницы не совпадает с источником'});
        page.search = '';
        page.username = '';
        page.password = '';
        const screenshot = parseScreenshot(body.screenshot);
        const appVersion = safeText(body.appVersion, 120);
        const viewport = body.viewport && typeof body.viewport === 'object' ? body.viewport : {};
        const selection = body.selection && typeof body.selection === 'object' ? body.selection : {};
        const now = new Date().toISOString();
        const id = randomUUID();
        const history = [{at: now, actor: 'reporter', status: 'new', note: 'Создано'}];
        insert.run(id, project.id, now, now, 0, 'new', description, page.toString(),
          origin, environmentFrom(page), appVersion, JSON.stringify(viewport), JSON.stringify(selection),
          screenshot?.data || null, screenshot?.mime || null, JSON.stringify(history));
        return json(res, 201, {id, status: 'new', reportUrl: `/reports/${id}`});
      }

      if (url.pathname.startsWith('/api/')) {
        const actor = actorFor(req);
        if (!actor) return json(res, 401, {error: 'Нужен токен команды'});
        if (req.method === 'GET' && url.pathname === '/api/projects') {
          return json(res, 200, config.projects.filter((project) => canSee(actor, project.id))
            .map(({id, name}) => ({id, name})));
        }
        if (req.method === 'GET' && url.pathname === '/api/reports') {
          const projectId = url.searchParams.get('project') || '';
          if (projectId && !canSee(actor, projectId)) return json(res, 403, {error: 'Нет доступа к проекту'});
          const ids = actor.projects || [];
          if (!ids.length) return json(res, 200, []);
          const status = url.searchParams.get('status') || '';
          if (status && !STATUSES.has(status)) return json(res, 400, {error: 'Неизвестный статус'});
          const offsetRaw = url.searchParams.get('offset') || '0';
          if (!/^\d{1,7}$/.test(offsetRaw)) return json(res, 400, {error: 'Некорректный номер страницы'});
          const clauses = [`project_id IN (${ids.map(() => '?').join(',')})`];
          const params = [...ids];
          if (projectId) { clauses.push('project_id = ?'); params.push(projectId); }
          if (status) { clauses.push('status = ?'); params.push(status); }
          const rows = db.prepare(`SELECT id,project_id,created_at,updated_at,revision,status,
            description,page_url,origin,environment,app_version,viewport,selection,root_cause,resolution,history,
            CASE WHEN screenshot IS NULL THEN 0 ELSE 1 END AS screenshot_available
            FROM reports WHERE ${clauses.join(' AND ')}
            ORDER BY created_at DESC, rowid DESC LIMIT 100 OFFSET ?`).all(...params, Number(offsetRaw));
          return json(res, 200, rows.map(rowToReport));
        }
        const match = /^\/api\/reports\/([^/]+)(?:\/(screenshot|html))?$/.exec(url.pathname);
        if (!match) return json(res, 404, {error: 'Не найдено'});
        const row = selectOne.get(match[1]);
        if (!row) return json(res, 404, {error: 'Баг не найден'});
        if (!canSee(actor, row.project_id)) return json(res, 403, {error: 'Нет доступа к проекту'});
        if (req.method === 'GET' && match[2] === 'screenshot') {
          if (!row.screenshot) return json(res, 404, {error: 'Снимок не найден'});
          res.writeHead(200, {'Content-Type': row.screenshot_mime, 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff'});
          res.end(row.screenshot);
          return;
        }
        if (req.method === 'GET' && match[2] === 'html') {
          const report = rowToReport(row);
          const shot = row.screenshot ? `<img alt="Снимок" style="max-width:100%" src="data:${row.screenshot_mime};base64,${row.screenshot.toString('base64')}">` : '<p>Снимка нет</p>';
          const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Баг ${escapeHtml(row.id)}</title><style>body{font:16px system-ui;max-width:900px;margin:3rem auto;padding:0 1rem;line-height:1.5}pre{white-space:pre-wrap}</style><h1>Баг ${escapeHtml(row.id)}</h1><p><b>Проект:</b> ${escapeHtml(row.project_id)} · <b>Статус:</b> ${escapeHtml(row.status)}</p><p><b>Контур:</b> ${escapeHtml(row.environment)} · <b>Версия:</b> ${escapeHtml(row.app_version || 'не указана')} · <b>Страница:</b> ${escapeHtml(row.page_url)}</p><h2>Описание</h2><pre>${escapeHtml(row.description)}</pre><h2>Снимок</h2>${shot}<h2>Причина</h2><pre>${escapeHtml(row.root_cause)}</pre><h2>Результат</h2><pre>${escapeHtml(row.resolution)}</pre><h2>История</h2><pre>${escapeHtml(JSON.stringify(report.history,null,2))}</pre></html>`;
          res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'"});
          res.end(html);
          return;
        }
        if (req.method === 'GET' && !match[2]) return json(res, 200, rowToReport(row));
        if (req.method === 'PATCH' && !match[2]) {
          const body = await readJson(req);
          if (!Number.isInteger(body.revision) || body.revision !== row.revision) return json(res, 409, {error: 'Карточка уже изменилась'});
          const status = body.status ?? row.status;
          if (!STATUSES.has(status)) return json(res, 400, {error: 'Неизвестный статус'});
          const rootCause = body.rootCause === undefined ? row.root_cause : safeText(body.rootCause, 4000);
          const resolution = body.resolution === undefined ? row.resolution : safeText(body.resolution, 4000);
          const note = safeText(body.note, 1000);
          const now = new Date().toISOString();
          const history = JSON.parse(row.history);
          history.push({at: now, actor: actor.name, status, note});
          const result = update.run(now, row.revision + 1, status, rootCause, resolution,
            JSON.stringify(history), row.id, row.revision);
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
