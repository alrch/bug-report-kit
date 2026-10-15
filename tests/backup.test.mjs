import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

test('online backup includes committed WAL data and refuses to overwrite', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'bug-kit-backup-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const source = join(directory, 'reports.sqlite');
  const destination = join(directory, 'backup.sqlite');
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({database: source}));
  const db = new DatabaseSync(source);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE sample (message TEXT); INSERT INTO sample VALUES ('saved');");
  const script = fileURLToPath(new URL('../scripts/backup.mjs', import.meta.url));
  const env = {...process.env, BUG_KIT_CONFIG: config};
  const result = await execFileAsync(process.execPath, [script, destination], {env});
  assert.match(result.stdout, /Копия готова/);
  const copy = new DatabaseSync(destination, {readOnly: true});
  assert.equal(copy.prepare('SELECT message FROM sample').get().message, 'saved');
  copy.close();
  await assert.rejects(execFileAsync(process.execPath, [script, destination], {env}));
  db.close();
});
