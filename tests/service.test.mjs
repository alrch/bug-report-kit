import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, realpathSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { supervise } from '../runtime/supervisor.mjs';
import { defaultSpecification, validateSpecification, serviceEnvironment, serviceDefinition, installService, readSpecification } from '../runtime/service.mjs';

const kitRoot = resolve(import.meta.dirname, '..');
const temporary = t => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-service-'))); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const listen = server => new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => accept(server.address().port)); });
function childFixture(t) { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); t.after(() => child.kill('SIGKILL')); return child; }
function specification(t, instance = 'project-a') {
  const root = temporary(t), configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify({ port: 7337, database: join(root, 'reports.sqlite'), projects: [] }), { mode: 0o600 });
  return defaultSpecification({ instance, configPath, stateDirectory: join(root, 'private-service'), kitRoot });
}

test('Shared supervisor detects child crash, releases owned listeners and records the signal', async t => {
  const child = childFixture(t), server = createServer(); await listen(server);
  const events = []; let code;
  const runtime = supervise({ child, servers: [{ name: 'fixture', server }], probe: async () => true, log: line => events.push(JSON.parse(line)), exit: value => { code = value; } });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await runtime.health;
  assert.equal(code, 1); assert.equal(server.listening, false);
  assert.ok(events.some(event => event.signal === 'SIGKILL'));
});

test('Shared supervisor preserves another listener on bind conflict', async t => {
  const existing = createServer((_req, res) => res.end('owned elsewhere')), port = await listen(existing);
  t.after(() => existing.close());
  const child = childFixture(t), contender = createServer(); let code;
  const runtime = supervise({ child, servers: [{ name: 'contender', server: contender }], probe: async () => true, log: () => {}, exit: value => { code = value; } });
  const exited = once(child, 'exit'); contender.listen(port, '127.0.0.1'); await exited; await runtime.health;
  assert.equal(code, 1); assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'owned elsewhere');
});

test('Shared watchdog recovers transient health and kills a stuck child after its grace period', async t => {
  const child = childFixture(t); let attempts = 0, code; const events = [];
  const runtime = supervise({ child, servers: [], intervalMs: 10, timeoutMs: 20, graceMs: 30,
    probe: async signal => { attempts++; if (attempts === 1) return false; if (attempts === 2) return true; await pause(10000, undefined, { signal }); return true; },
    log: line => events.push(JSON.parse(line)), exit: value => { code = value; } });
  const exited = once(child, 'exit'); await exited; await runtime.health;
  assert.equal(attempts, 5); assert.equal(code, 1); assert.ok(events.some(event => event.event === 'health-recovered'));
});

test('An adapter can delegate child ownership without creating a second health watchdog', async t => {
  const child = childFixture(t); let code;
  const runtime = supervise({ child, servers: [], log: () => {}, exit: value => { code = value; } });
  const exited = once(child, 'exit'); runtime.stop('fixture-finished', 0); await exited; await runtime.health;
  assert.equal(code, 0);
});

test('Per-instance manifests reject external probes and inherited non-Kit credentials', t => {
  const spec = specification(t), env = serviceEnvironment(spec);
  assert.ok(!('OPENAI_API_KEY' in env)); assert.ok(!('NODE_OPTIONS' in env));
  for (const url of ['https://example.com/healthz', 'http://127.0.0.1/?token=secret', 'http://user:secret@127.0.0.1/', 'http://127.0.0.1/#secret']) {
    assert.throws(() => validateSpecification({ ...spec, healthUrls: [url] }));
  }
  assert.throws(() => validateSpecification({ ...spec, environment: { NODE_OPTIONS: '--import /foreign.mjs' } }));
  assert.throws(() => validateSpecification({ ...spec, instance: '../other-project' }));
  const foreignEnvironment = { OPENAI_API_KEY: 'do-not-copy', BUG_KIT_HOST: '127.0.0.1' };
  const safe = defaultSpecification({ instance: 'safe', configPath: spec.environment.BUG_KIT_CONFIG, stateDirectory: spec.stateDirectory, environment: foreignEnvironment });
  assert.deepEqual(safe.environment, { BUG_KIT_HOST: '127.0.0.1', BUG_KIT_CONFIG: spec.environment.BUG_KIT_CONFIG });
});

test('Native service definitions keep instances separate and escape XML and systemd arguments', t => {
  const spec = specification(t), manifest = join(spec.stateDirectory, 'a & " %.json');
  const mac = serviceDefinition(spec, manifest, { platform: 'darwin' });
  const linux = serviceDefinition(spec, manifest, { platform: 'linux' });
  assert.notEqual(mac.label, serviceDefinition({ ...spec, instance: 'project-b' }, manifest, { platform: 'darwin' }).label);
  assert.match(mac.contents, /<key>KeepAlive<\/key><true\/>/);
  assert.match(linux.contents, /KillMode=control-group/); assert.match(linux.contents, /Restart=always/);
  assert.match(linux.contents, /%%/); assert.match(linux.contents, /\\"/);
  if (process.platform === 'darwin') {
    const file = join(temporary(t), 'service.plist'); writeFileSync(file, mac.contents);
    const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
    assert.equal(parsed.ProgramArguments.at(-1), manifest); assert.equal(parsed.AbandonProcessGroup, false);
  }
  assert.throws(() => serviceDefinition(spec, manifest, { platform: 'unsupported' }));
});

test('Installation preserves data and rejects symlinked state or a changed foreign service', t => {
  const spec = specification(t), home = temporary(t);
  const configBefore = readFileSync(spec.environment.BUG_KIT_CONFIG, 'utf8');
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const installed = installService(spec, { home, platform });
  assert.deepEqual(readSpecification(installed.manifest), spec);
  installService(spec, { home, platform });
  assert.ok(existsSync(join(spec.stateDirectory, 'service.previous')));
  assert.equal(readFileSync(spec.environment.BUG_KIT_CONFIG, 'utf8'), configBefore);
  writeFileSync(installed.file, 'belongs to another service');
  assert.throws(() => installService(spec, { home, platform }), /another owner/);
  assert.equal(readFileSync(installed.file, 'utf8'), 'belongs to another service');
  const other = specification(t, 'project-b'), target = temporary(t);
  symlinkSync(target, other.stateDirectory); assert.throws(() => installService(other, { home, platform }), /Unsafe/);
});

test('Foreground CLI serves real SQLite health and handles termination without changing its config', async t => {
  const root = temporary(t), configPath = join(root, 'config.json');
  const reserved = createServer(), port = await listen(reserved); await new Promise(accept => reserved.close(accept));
  // Read-only config mounts need not have the runtime UID or private manifest ACL.
  const config = JSON.stringify({ host: '127.0.0.1', port, database: join(root, 'reports.sqlite'),
    projects: [{ id: 'fixture', name: 'Fixture', widgetKey: 'fixture-public-widget-key', allowedOrigins: ['http://localhost:7338'] }],
    teamTokens: [{ name: 'Fixture developer', role: 'developer', token: 'fixture-team-token', projects: ['fixture'] }] });
  writeFileSync(configPath, config, { mode: 0o644 });
  const child = spawn(process.execPath, ['scripts/service.mjs', 'foreground'], { cwd: kitRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: root, BUG_KIT_CONFIG: configPath, BUG_KIT_SERVICE_STATE: join(root, 'service') } });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit'); t.after(() => child.kill('SIGKILL'));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(100) }); if (response.ok) { ready = true; break; } }
    catch { /* Startup has not bound yet. */ }
    if (child.exitCode !== null) break;
    await pause(20);
  }
  assert.equal(ready, true, output); child.kill('SIGTERM');
  const [code] = await exited; assert.equal(code, 0, output);
  assert.equal(readFileSync(configPath, 'utf8'), config);
});
