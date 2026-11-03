// Host-operator tool. No HTTP route can grant panel rights.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function setPanelAccess(db, projectId, accountId, enabled) {
  const result = db.prepare('UPDATE reporter_accounts SET role=? WHERE project_id=? AND id=?')
    .run(enabled ? 'reviewer' : 'reporter', projectId, accountId);
  if (result.changes !== 1) throw new Error('Указанная учётная запись проекта не найдена');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [configPath, action, projectId, accountId] = process.argv.slice(2);
  if (!configPath || !['grant', 'revoke'].includes(action) || !projectId || !accountId || process.argv.length !== 6) {
    throw new Error('Usage: node scripts/panel-access.mjs CONFIG grant|revoke PROJECT_ID ACCOUNT_ID');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (!config.projects?.some(project => project.id === projectId && project.panelAccess)) throw new Error('Панель проекта выключена');
  const db = new DatabaseSync(resolve(config.database || './data/reports.sqlite'));
  try { setPanelAccess(db, projectId, accountId, action === 'grant'); }
  finally { db.close(); }
  console.log('Panel access updated');
}
