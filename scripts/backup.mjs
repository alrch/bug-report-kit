#!/usr/bin/env node
import {readFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';

const destination = process.argv[2] && resolve(process.argv[2]);
if (!destination || existsSync(destination)) {
  console.error('Укажите новый путь для резервной копии; существующий файл не перезаписывается');
  process.exit(2);
}
const rootDir = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(resolve(rootDir, process.env.BUG_KIT_CONFIG || 'config.local.json'), 'utf8'));
const source = resolve(rootDir, config.database || './data/reports.sqlite');
if (!existsSync(source)) throw new Error('База данных не найдена');
const db = new DatabaseSync(source, {readOnly: true});
try {
  await backup(db, destination);
} finally {
  db.close();
}
const copy = new DatabaseSync(destination, {readOnly: true});
try {
  if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
    throw new Error('Резервная копия не прошла проверку целостности');
  }
  console.log(`Копия готова: ${destination}`);
} finally {
  copy.close();
}
