import {existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, rmdirSync, lstatSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fail, regularPrivate, validateConfig} from './config.mjs';
import {resolveImage, rehearse} from './docker.mjs';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const identity = value => value === null || value && /^[a-f0-9]{64}$/.test(value.id) && /^sha256:[a-f0-9]{64}$/.test(value.imageId) && typeof value.imageRef === 'string' && JSON.stringify(value).length <= 32768;
const safeFile = path => { regularPrivate(path); if (lstatSync(path).size > 64 * 1024) fail('STATE_INVALID'); return JSON.parse(readFileSync(path, 'utf8')); };
function atomic(path, value) {
  if (existsSync(path)) regularPrivate(path);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value) + '\n', {flag: 'wx', mode: 0o600});
  renameSync(tmp, path);
}
export async function deploy(action, spec, {docker, adapter}) {
  validateConfig(spec);
  if (!['plan', 'install', 'update', 'status', 'verify', 'recover', 'rollback'].includes(action)) fail('INVALID_ACTION');
  if (typeof adapter?.identity !== 'string' || !['inspect', 'activate', 'verify'].every(key => typeof adapter[key] === 'function')) fail('ADAPTER_INVALID');
  regularPrivate(spec.configRef, {allowedUid: spec.runtime.uid});
  if (spec.data.type === 'bind') regularPrivate(spec.data.source, {directory: true, allowedUid: spec.runtime.uid});
  const binding = hash(JSON.stringify(canonical({...spec, artifact: undefined, adapter: adapter.identity})));
  const configHash = hash(readFileSync(spec.configRef));
  const paths = Object.fromEntries(['receipt', 'transaction'].map(key => [key, join(spec.stateDirectory, `${key}.json`)]));
  const lockPath = join(spec.stateDirectory, 'lock');
  function readState() {
    if (existsSync(spec.stateDirectory)) regularPrivate(spec.stateDirectory, {directory: true});
    const receipt = existsSync(paths.receipt) ? safeFile(paths.receipt) : null;
    const transaction = existsSync(paths.transaction) ? safeFile(paths.transaction) : null;
    for (const item of [receipt, transaction]) if (item && (item.schema !== 1 || item.binding !== binding || item.configHash !== configHash)) fail('STATE_BINDING_CHANGED');
    if (receipt && (!identity(receipt.current) || !identity(receipt.previous))) fail('STATE_INVALID');
    if (transaction && (!identity(transaction.baseline) || !/^sha256:[a-f0-9]{64}$/.test(transaction.target ?? ''))) fail('STATE_INVALID');
    return {receipt, transaction};
  }
  async function inspect() {
    const current = await adapter.inspect();
    if (!identity(current)) fail('ADAPTER_INVALID');
    return current;
  }
  async function checkIdentity(current, expected, guards = false) { const core = x => x && {id:x.id,imageId:x.imageId,imageRef:x.imageRef}; if (!equal(guards ? current : core(current), guards ? expected : core(expected))) fail('RESOURCE_CHANGED'); }
  const initial = readState();
  if (['plan', 'status'].includes(action)) {
    const current = await inspect();
    if (initial.receipt && !initial.transaction) await checkIdentity(current, initial.receipt.current);
    const target = action === 'plan' ? await resolveImage(docker, spec.artifact.image) : undefined;
    return {ok: true, action, instance: spec.instance, installed: !!current, managed: !!initial.receipt,
      recoveryRequired: !!initial.transaction, ...(target ? {change: current?.imageId !== target} : {})};
  }
  if (action === 'verify') {
    if (initial.transaction) fail('RECOVERY_REQUIRED');
    if (!initial.receipt) fail('NOT_INSTALLED');
    const current = await inspect(); await checkIdentity(current, initial.receipt.current);
    await adapter.verify({imageId: current.imageId, guard: current.guard});
    return {ok: true, action, instance: spec.instance};
  }
  if (!existsSync(spec.stateDirectory)) { regularPrivate(dirname(spec.stateDirectory), {directory: true}); mkdirSync(spec.stateDirectory, {mode: 0o700}); }
  regularPrivate(spec.stateDirectory, {directory: true});
  // Only explicit recover can reclaim a lock whose owner process has exited.
  if (existsSync(lockPath) && action === 'recover') {
    regularPrivate(lockPath, {directory: true});
    const lock = safeFile(join(lockPath, 'owner.json'));
    if (!Number.isInteger(lock.pid) || lock.pid < 1 || typeof lock.token !== 'string') fail('LOCKED');
    let alive = true;
    try { process.kill(lock.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) fail('LOCKED');
    rmSync(join(lockPath, 'owner.json')); rmdirSync(lockPath);
  }
  try { mkdirSync(lockPath, {mode: 0o700}); } catch { fail('LOCKED'); }
  const lockToken = randomUUID();
  atomic(join(lockPath, 'owner.json'), {pid: process.pid, token: lockToken});
  let mutating = false;
  try {
    const {receipt, transaction} = readState();
    const current = await inspect();
    if (action === 'recover') {
      if (!transaction) return {ok: true, action, instance: spec.instance, recovered: false};
      if (!transaction.baseline) fail('RECOVERY_REQUIRES_OPERATOR');
      await resolveImage(docker, transaction.baseline.imageId);
      // Keep current data; only the executable/runtime is restored.
      await adapter.activate({image: transaction.baseline.imageId, expected: current, rollback: true, guard: transaction.baseline.guard});
      const restored = await inspect(); await adapter.verify({imageId: transaction.baseline.imageId, guard: transaction.baseline.guard});
      if (!restored || restored.imageId !== transaction.baseline.imageId) fail('IMAGE_IDENTITY');
      atomic(paths.receipt, {schema: 1, binding, configHash, current: restored, previous: transaction.before?.previous || null});
      rmSync(paths.transaction);
      return {ok: true, action, instance: spec.instance, recovered: true};
    }
    if (transaction) fail('RECOVERY_REQUIRED');
    if (receipt) await checkIdentity(current, receipt.current);
    if (action === 'update' && !receipt || action === 'rollback' && !receipt?.previous) fail('INVALID_TRANSITION');
    const target = await resolveImage(docker, action === 'rollback' ? receipt.previous.imageId : spec.artifact.image);
    if (action === 'install' && receipt && current?.imageId !== target) fail('INVALID_TRANSITION');
    if (current?.imageId === target) {
      await adapter.verify({imageId: target, guard: current?.guard});
      if (!receipt) atomic(paths.receipt, {schema: 1, binding, configHash, current, previous: null});
      return {ok: true, action, instance: spec.instance, changed: false};
    }
    // A target is never activated before both migrations and downgrade are rehearsed.
    const backup = await rehearse({spec, docker, candidate: target, previous: current?.imageId});
    if (hash(readFileSync(spec.configRef)) !== configHash) fail('CONFIG_CHANGED');
    await checkIdentity(await inspect(), current, true);
    if (adapter.prepare && action !== 'rollback') await adapter.prepare({image: target, expected: current, guard: current?.guard});
    atomic(paths.transaction, {schema: 1, binding, configHash, baseline: current, before: receipt, target, backup, phase: 'activating'});
    mutating = true;
    await adapter.activate({image: target, expected: current, rollback: action === 'rollback', guard: current?.guard});
    const installed = await inspect();
    if (!installed || installed.imageId !== target) fail('IMAGE_IDENTITY');
    await adapter.verify({imageId: target, guard: current?.guard});
    if (hash(readFileSync(spec.configRef)) !== configHash) fail('CONFIG_CHANGED');
    atomic(paths.receipt, {schema: 1, binding, configHash, current: installed, previous: action === 'rollback' ? null : current});
    rmSync(paths.transaction); mutating = false;
    return {ok: true, action, instance: spec.instance, changed: true};
  } catch (error) {
    if (mutating) {
      // Journal stays until restoration AND health are confirmed. No DB rewind.
      try {
        const pending = safeFile(paths.transaction);
        if (!pending.baseline || hash(readFileSync(spec.configRef)) !== configHash) fail('RECOVERY_REQUIRES_OPERATOR');
        const current = await inspect();
        await adapter.activate({image: pending.baseline.imageId, expected: current, rollback: true, guard: pending.baseline.guard});
        const restored = await inspect();
        await adapter.verify({imageId: pending.baseline.imageId, guard: pending.baseline.guard});
        if (!restored || restored.imageId !== pending.baseline.imageId) fail('IMAGE_IDENTITY');
        atomic(paths.receipt, {schema: 1, binding, configHash, current: restored, previous: pending.before?.previous || null});
        rmSync(paths.transaction);
      } catch { fail('RECOVERY_REQUIRED'); }
      fail('ACTIVATION_FAILED_RESTORED');
    }
    throw error;
  } finally {
    if (existsSync(join(lockPath, 'owner.json')) && safeFile(join(lockPath, 'owner.json')).token === lockToken) {
      rmSync(join(lockPath, 'owner.json')); rmdirSync(lockPath);
    }
  }
}
