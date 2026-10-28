// Explicit integration probe: installs only its disposable fixture job and
// removes it in finally. Never reads a real instance config, PIN or database.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { defaultSpecification, installService } from '../runtime/service.mjs';

if (process.platform !== 'darwin') throw new Error('This probe requires macOS launchd; no simulated success');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-service-qa-')));
const instance = `qa-${process.pid}`, target = `gui/${process.getuid()}/com.bug-report-kit.${instance}`;
let installed, loaded = false;
const status = () => execFileSync('/bin/launchctl', ['print', target], { encoding: 'utf8' });
const processId = () => Number(status().match(/^\s*pid = (\d+)/m)?.[1]) || null;
const free = createServer();
await new Promise(accept => free.listen(0, '127.0.0.1', accept));
const port = free.address().port; await new Promise(accept => free.close(accept));
const configPath = join(root, 'config.json');
const config = JSON.stringify({ port, host: '127.0.0.1', database: join(root, 'fixture.sqlite'),
  projects: [{ id: instance, name: 'Disposable service probe', widgetKey: 'fixture-public-key', allowedOrigins: ['http://localhost:7338'] }],
  teamTokens: [{ name: 'Fixture', token: 'fixture-team-token', role: 'developer', projects: [instance] }] });
writeFileSync(configPath, config, { mode: 0o600 });
try {
  const spec = defaultSpecification({ instance, configPath, stateDirectory: join(root, 'state'), kitRoot: resolve(import.meta.dirname, '..') });
  installed = installService(spec);
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, installed.file]); loaded = true;
  async function ready(previous) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const pid = processId();
      if (pid && pid !== previous) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(200) });
          const ok = response.ok; await response.body?.cancel(); if (ok) return pid;
        } catch { /* Wait only for this fixture. */ }
      }
      await pause(100);
    }
    throw new Error('Fixture did not recover');
  }
  const before = await ready();
  const started = readFileSync(join(root, 'state/service.log'), 'utf8').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(event => event.event === 'started');
  if (!started || started.pid !== before || !Number.isInteger(started.kitPid)) throw new Error('Fixture child ownership not proven');
  const command = execFileSync('/bin/ps', ['-p', String(started.kitPid), '-o', 'command='], { encoding: 'utf8' });
  if (!command.includes(join(spec.cwd, 'server/index.mjs'))) throw new Error('Unexpected fixture command');
  process.kill(started.kitPid, 'SIGKILL');
  const after = await ready(before);
  if (readFileSync(configPath, 'utf8') !== config) throw new Error('Fixture configuration changed');
  console.log(JSON.stringify({ fixture: instance, recovered: true, before, after, configUnchanged: true }));
} finally {
  if (loaded) execFileSync('/bin/launchctl', ['bootout', target]);
  if (installed) rmSync(installed.file);
  rmSync(root, { recursive: true, force: true });
}
