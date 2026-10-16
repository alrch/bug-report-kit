import {workflowError} from './workflow.mjs';

const GROUPS = {
  project: 'project_id',
  environment: 'environment',
  group: "CASE WHEN duplicate_of <> '' THEN COALESCE((SELECT NULLIF(parent.fingerprint, '') FROM reports parent WHERE parent.id = reports.duplicate_of), duplicate_of) WHEN fingerprint <> '' THEN fingerprint ELSE id END",
};
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function getPeriodSummary(db, projectIds, params) {
  const from = params.get('from');
  const to = params.get('to');
  const project = params.get('project') || '';
  const groupBy = params.get('groupBy') || 'environment';
  if (!validDate(from) || !validDate(to) || to < from) throw workflowError(400, 'Укажите корректный период from/to');
  const end = new Date(`${to}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const until = end.toISOString();
  if ((end.getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86400000 > 367) {
    throw workflowError(400, 'Период не должен превышать один год');
  }
  if (!GROUPS[groupBy]) throw workflowError(400, 'Неизвестная группировка');
  if (project && !projectIds.includes(project)) throw workflowError(403, 'Нет доступа к проекту');
  const ids = project ? [project] : projectIds;
  if (!ids.length) return {from, to, project, groupBy, created: 0, fixed: 0,
    byStatus: [], createdGroups: [], fixedGroups: [], fixedReports: [], truncated: false};
  const scope = `project_id IN (${ids.map(() => '?').join(',')})`;
  const createdWhere = `${scope} AND created_at >= ? AND created_at < ?`;
  const fixedWhere = `${scope} AND status = 'closed' AND accepted_at >= ? AND accepted_at < ?`;
  const createdArgs = [...ids, `${from}T00:00:00.000Z`, until];
  const fixedArgs = [...ids, `${from}T00:00:00.000Z`, until];
  const group = GROUPS[groupBy];
  const created = db.prepare(`SELECT COUNT(*) AS count FROM reports WHERE ${createdWhere}`).get(...createdArgs).count;
  const fixed = db.prepare(`SELECT COUNT(*) AS count FROM reports WHERE ${fixedWhere}`).get(...fixedArgs).count;
  const byStatus = db.prepare(`SELECT status AS key, COUNT(*) AS count FROM reports WHERE ${createdWhere} GROUP BY status ORDER BY status`).all(...createdArgs);
  const createdGroups = db.prepare(`SELECT ${group} AS key, COUNT(*) AS count FROM reports WHERE ${createdWhere} GROUP BY key ORDER BY count DESC, key`).all(...createdArgs);
  const fixedGroups = db.prepare(`SELECT ${group} AS key, COUNT(*) AS count FROM reports WHERE ${fixedWhere} GROUP BY key ORDER BY count DESC, key`).all(...fixedArgs);
  const fixedReports = db.prepare(`SELECT id,title,project_id AS projectId,environment,accepted_at AS acceptedAt,
    root_cause AS rootCause,resolution FROM reports WHERE ${fixedWhere}
    ORDER BY accepted_at DESC, rowid DESC LIMIT 500`).all(...fixedArgs);
  return {from, to, project, groupBy, created, fixed, byStatus, createdGroups,
    fixedGroups, fixedReports, truncated: fixed > fixedReports.length};
}

export function summaryHtml(summary) {
  const cards = summary.fixedReports.map((item) => `<article><p class="meta">${escapeHtml(new Date(item.acceptedAt).toLocaleString('ru-RU'))} · ${escapeHtml(item.environment)}</p><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.resolution || 'Итог исправления не указан')}</p><details><summary>Технические сведения</summary><p>Проект: ${escapeHtml(item.projectId)} · ID: ${escapeHtml(item.id)}</p>${item.rootCause ? `<p>Причина: ${escapeHtml(item.rootCause)}</p>` : ''}</details></article>`).join('');
  const groups = (items) => items.map((item) => `<li>${escapeHtml(item.key)}: ${item.count}</li>`).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Исправленные баги · ${escapeHtml(summary.from)} — ${escapeHtml(summary.to)}</title><style>*{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:28px 20px 80px;color:#182237;background:#f5f7fb}h1{font-size:30px;margin:0 0 8px}h2{font-size:19px;margin:0 0 10px}p{white-space:pre-wrap;overflow-wrap:anywhere}article{background:white;border:1px solid #dfe5f0;border-radius:12px;padding:20px;margin:16px 0}.meta{color:#58667e;margin:0 0 8px}details{margin-top:16px}summary{cursor:pointer;font-weight:600}@media(max-width:600px){body{padding:20px;background:white}article{padding:16px}}</style><h1>Исправленные баги</h1><p class="meta">${escapeHtml(summary.from)} — ${escapeHtml(summary.to)}</p><p>Создано: ${summary.created} · Исправлено и принято: ${summary.fixed}</p>${summary.truncated ? '<p>Показаны первые 500 исправлений.</p>' : ''}${cards || '<p>За этот период принятых исправлений нет.</p>'}<details><summary>Сводка по статусам и группам</summary><h2>Статусы созданных багов</h2><ul>${groups(summary.byStatus)}</ul><h2>Созданные группы</h2><ul>${groups(summary.createdGroups)}</ul><h2>Группы исправлений</h2><ul>${groups(summary.fixedGroups)}</ul></details></html>`;
}
