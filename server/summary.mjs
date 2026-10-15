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
  const rows = summary.fixedReports.map((item) => `<tr><td>${escapeHtml(item.acceptedAt)}</td><td>${escapeHtml(item.projectId)}</td><td>${escapeHtml(item.environment)}</td><td>${escapeHtml(item.title)}</td><td>${escapeHtml(item.rootCause)}</td><td>${escapeHtml(item.resolution)}</td><td>${escapeHtml(item.id)}</td></tr>`).join('');
  const groups = (items) => items.map((item) => `<li>${escapeHtml(item.key)}: ${item.count}</li>`).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Отчёт по багам ${escapeHtml(summary.from)} — ${escapeHtml(summary.to)}</title><style>body{font:15px system-ui;max-width:1200px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.5rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}</style><h1>Отчёт по багам</h1><p>Период: ${escapeHtml(summary.from)} — ${escapeHtml(summary.to)} · Проект: ${escapeHtml(summary.project || 'все доступные')} · Группировка: ${escapeHtml(summary.groupBy)}</p><p>Создано: ${summary.created} · Принято исправлений: ${summary.fixed}</p><h2>Созданные по статусу</h2><ul>${groups(summary.byStatus)}</ul><h2>Группы новых багов</h2><ul>${groups(summary.createdGroups)}</ul><h2>Группы принятых исправлений</h2><ul>${groups(summary.fixedGroups)}</ul><h2>Принятые исправления</h2>${summary.truncated ? '<p>Показаны первые 500 записей; точные итоги приведены выше.</p>' : ''}<table><thead><tr><th>Принято</th><th>Проект</th><th>Контур</th><th>Баг</th><th>Причина</th><th>Исправление</th><th>ID</th></tr></thead><tbody>${rows}</tbody></table></html>`;
}
