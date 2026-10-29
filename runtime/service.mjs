import { readFileSync, writeFileSync, renameSync, existsSync, lstatSync, realpathSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { supervise } from './supervisor.mjs';

const KIT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ENV_KEYS = ['BUG_KIT_CONFIG', 'BUG_KIT_HOST', 'BUG_KIT_SPEECH_ENABLED', 'BUG_KIT_SPEECH_PYTHON', 'BUG_KIT_SPEECH_MODEL', 'BUG_KIT_SPEECH_LANGUAGE', 'HF_HUB_OFFLINE'];
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const unitQuote = value => '"' + String(value).replaceAll('%', '%%').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';

function privateFile(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Private regular file owned by this user required');
}
function privateDirectory(path) {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077)) throw new Error('Unsafe service directory; select a dedicated private directory');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.getuid && lstatSync(path).uid !== process.getuid()) throw new Error('Foreign service directory');
  chmodSync(path, 0o700);
}
function atomic(path, contents) {
  if (existsSync(path)) privateFile(path);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}
export function validateSpecification(spec) {
  if (spec?.schema !== 1 || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(spec.instance ?? '')) throw new Error('Invalid service instance');
  for (const path of [spec.cwd, spec.stateDirectory]) if (typeof path !== 'string' || !isAbsolute(path) || /[\r\n\0]/.test(path)) throw new Error('Absolute service paths required');
  if (!Array.isArray(spec.command) || spec.command.length < 2 || spec.command.length > 16 ||
      spec.command.some(value => typeof value !== 'string' || !value || /[\r\n\0]/.test(value)) ||
      !isAbsolute(spec.command[0]) || !isAbsolute(spec.command[1])) throw new Error('Direct absolute Node and entry arguments required');
  if (!Array.isArray(spec.healthUrls) || !spec.healthUrls.length || spec.healthUrls.length > 4) throw new Error('Local health URL required');
  for (const value of spec.healthUrls) {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Health probes must stay on loopback without secrets');
  }
  if (!spec.environment || typeof spec.environment !== 'object' || Array.isArray(spec.environment) ||
      Object.entries(spec.environment).some(([key, value]) => !ENV_KEYS.includes(key) || typeof value !== 'string' || /[\r\n\0]/.test(value))) throw new Error('Only explicit Kit environment is supported');
  return spec;
}
export function defaultSpecification({ instance, configPath, stateDirectory, kitRoot = KIT_ROOT, node = process.execPath, environment = {} }) {
  // A container config may be a read-only file mounted with another UID.
  // The native service manifest is private; do not change existing config ACLs.
  configPath = realpathSync(configPath);
  if (!lstatSync(configPath).isFile()) throw new Error('Regular Kit config required');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const port = config.port ?? 7337;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Kit port');
  return validateSpecification({ schema: 1, instance, cwd: realpathSync(kitRoot), command: [realpathSync(node), join(realpathSync(kitRoot), 'server/index.mjs')],
    stateDirectory: resolve(stateDirectory), healthUrls: [`http://${(environment.BUG_KIT_HOST || config.host) === '::1' ? '[::1]' : '127.0.0.1'}:${port}/healthz`],
    environment: { ...Object.fromEntries(ENV_KEYS.filter(key => key !== 'BUG_KIT_CONFIG' && environment[key] !== undefined).map(key => [key, environment[key]])), BUG_KIT_CONFIG: configPath } });
}
export function serviceEnvironment(spec, home = homedir()) {
  validateSpecification(spec);
  const system = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } : {};
  const paths = process.platform === 'win32' ? [dirname(spec.command[0]), system.SystemRoot, join(system.SystemRoot, 'System32')] : [dirname(spec.command[0]), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return { ...system, PATH: paths.join(delimiter), HOME: home,
    TMPDIR: join(spec.stateDirectory, 'tmp'), LANG: 'en_US.UTF-8', ...spec.environment };
}
export function serviceDefinition(spec, manifest, { platform = process.platform, runnerNode = process.execPath, runner = join(KIT_ROOT, 'scripts/service.mjs') } = {}) {
  validateSpecification(spec);
  const label = `com.bug-report-kit.${spec.instance}`, log = join(spec.stateDirectory, 'service.log');
  const args = [runnerNode, runner, 'run', manifest];
  if (platform === 'darwin') return { name: `${label}.plist`, label, contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(spec.cwd)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>20</integer><key>AbandonProcessGroup</key><false/><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(log)}</string><key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n` };
  if (platform === 'linux') return { name: `bug-report-kit-${spec.instance}.service`, label, contents: `[Unit]
Description=Bug Report Kit (${spec.instance})
StartLimitIntervalSec=0
[Service]
Type=simple
WorkingDirectory=${unitQuote(spec.cwd)}
ExecStart=${args.map(unitQuote).join(' ')}
Restart=always
RestartSec=10
TimeoutStopSec=20
KillMode=control-group
UMask=0077
[Install]
WantedBy=default.target
` };
  throw new Error('Native autostart supports macOS and Linux; use Compose on other hosts');
}
export function installService(spec, { home = homedir(), platform = process.platform } = {}) {
  validateSpecification(spec);
  if (!['darwin', 'linux'].includes(platform)) throw new Error('Unsupported native service platform');
  privateDirectory(spec.stateDirectory); privateDirectory(join(spec.stateDirectory, 'tmp'));
  const manifest = join(spec.stateDirectory, 'service.json');
  if (existsSync(manifest)) {
    privateFile(manifest);
    const previous = JSON.parse(readFileSync(manifest));
    if (previous.instance !== spec.instance || previous.stateDirectory !== spec.stateDirectory) throw new Error('Instance state belongs to another service');
  }
  const definition = serviceDefinition(spec, manifest, { platform });
  const directory = platform === 'darwin' ? join(home, 'Library/LaunchAgents') : join(home, '.config/systemd/user');
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe service destination');
  const file = join(directory, definition.name);
  const receipt = join(spec.stateDirectory, 'installation.json');
  if (existsSync(file)) {
    privateFile(file);
    // Do not adopt/overwrite an unrelated job just because its label matches.
    if (!existsSync(manifest) || !existsSync(receipt)) throw new Error('Existing service has another owner');
    privateFile(receipt);
    const previous = JSON.parse(readFileSync(receipt));
    if (previous.file !== file || previous.sha256 !== createHash('sha256').update(readFileSync(file)).digest('hex')) throw new Error('Existing service has another owner or changed definition');
    const backup = join(spec.stateDirectory, 'service.previous');
    if (existsSync(backup)) privateFile(backup);
    copyFileSync(file, backup); chmodSync(backup, 0o600);
  }
  const staged = join(spec.stateDirectory, 'service.pending');
  atomic(staged, definition.contents);
  if (platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', staged], { stdio: 'pipe' });
  const version = execFileSync(spec.command[0], ['--version'], { env: serviceEnvironment(spec, home), encoding: 'utf8' }).trim();
  if (!/^v(?:2[4-9]|[3-9]\d)\./.test(version)) throw new Error('Node >=24 required');
  atomic(manifest, JSON.stringify(spec, null, 2) + '\n');
  atomic(file, definition.contents);
  atomic(receipt, JSON.stringify({ file, sha256: createHash('sha256').update(definition.contents).digest('hex') }) + '\n');
  if (platform === 'darwin') {
    const log = join(spec.stateDirectory, 'service.log');
    if (existsSync(log)) privateFile(log);
    writeFileSync(log, '', { flag: 'a', mode: 0o600 });
  }
  return { file, manifest, label: definition.label, platform };
}
export function readSpecification(path) {
  privateFile(path);
  return validateSpecification(JSON.parse(readFileSync(path, 'utf8')));
}
export function runService(spec) {
  validateSpecification(spec);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 required');
  privateDirectory(spec.stateDirectory); privateDirectory(join(spec.stateDirectory, 'tmp'));
  const child = spawn(spec.command[0], spec.command.slice(1), { cwd: spec.cwd, env: serviceEnvironment(spec), stdio: 'inherit' });
  return supervise({ child, servers: [], probe: async signal => {
    const responses = await Promise.all(spec.healthUrls.map(url => fetch(url, { signal })));
    const ok = responses.every(response => response.ok);
    await Promise.all(responses.map(response => response.body?.cancel()));
    return ok;
  } });
}
