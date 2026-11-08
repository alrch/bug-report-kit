// Shared Compose lifecycle; definition is supplied by trusted owning code, never deploy JSON.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const IMAGE = /^(?:sha256:[0-9a-f]{64}|[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[0-9a-f]{64})$/;
const ID = /^[0-9a-f]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inspectFormat = '{"id":{{json .Id}},"imageId":{{json .Image}},"imageRef":{{json .Config.Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}}}';

function assert(condition) { if (!condition) throw new Error('COMPOSE_ADAPTER_REJECTED'); }

async function regular(file, privateMode = true, extraOwner) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & (privateMode ? 0o077 : 0o022)) === 0);
  assert(await fs.realpath(file) === file);
  assert(!process.getuid || [0,process.getuid(),extraOwner].includes(stat.uid));
  return fs.readFile(file);
}

async function atomic(file, bytes) {
  try { await regular(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = `${file}.common-pending`;
  // Never follow a pre-existing pending symlink or truncate another operation.
  const handle = await fs.open(pending, 'wx', 0o600);
  let closed = false;
  try {
    await handle.writeFile(bytes); await handle.sync();
    await handle.close(); closed = true;
    await fs.rename(pending, file);
  } catch (error) {
    if (!closed) await handle.close().catch(() => {});
    // Only this invocation's wx-created file is ours to remove.
    await fs.unlink(pending).catch(() => {});
    throw error;
  }
}

/** Test seam accepts only synthetic paths and in-memory command responses. */
export async function createComposeAdapter({ spec, docker, definition, paths = {}, publicHealth, pause, fixture }) {
  const {name:NAME,edge:EDGE,config:CONFIG,override:OVERRIDE,state:STATE,base:BASE,env:ENV,compose:COMPOSE}=definition;
  const config = paths.config ?? CONFIG;
  const override = paths.override ?? OVERRIDE;
  const state = paths.state ?? STATE;
  const base = paths.base ?? BASE;
  const env = paths.env ?? ENV;
  // Test-only code seam; production createAdapter never accepts fixture options.
  const targetName = fixture?.name ?? NAME;
  const edgeName = fixture?.edge ?? EDGE;
  const compose = fixture?.compose ?? COMPOSE;
  const project = fixture?.project ?? definition.instance;
  const dataVolume = fixture?.dataVolume ?? definition.dataVolume;
  assert(spec.instance === definition.instance && spec.configRef === config && spec.stateDirectory === state);
  assert(spec.data.type === 'volume' && spec.data.source === dataVolume);
  assert(spec.runtime.uid === definition.runtime.uid && spec.runtime.gid === definition.runtime.gid && spec.runtime.port === definition.runtime.port);
  assert(spec.proxy.healthUrl === (fixture?.healthUrl ?? definition.healthUrl));
  assert(!['DOCKER_HOST', 'DOCKER_CONTEXT', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME'].some(k => process.env[k]));
  // The established readonly config belongs to the container's UID1000;
  // operator root owns the remaining state/Compose/override files.
  const readRuntimeConfig = () => regular(config, true, spec.runtime.uid);
  const configHash = hash(await readRuntimeConfig());
  async function sourceGuard() {
    return {base, env, baseHash:hash(await regular(base, false)), envHash:hash(await regular(env))};
  }
  const source = await sourceGuard();
  let mounts;
  let neighbors;
  const checkpoint = path.join(state, definition.checkpoint);
  const delay = pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const requestHealth = publicHealth ?? (async () => {
    const response = await fetch(spec.proxy.healthUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    assert(response.status === 200);
  });

  async function inspectTarget() {
    const found = (await docker.run(['ps', '-aq', '--no-trunc', '--filter', `name=^/${targetName}$`])).trim();
    if (!found) {
      // Absence alone never grants adoption. A durable private checkpoint is
      // required to recover a service removed by an interrupted recreation.
      const prior = JSON.parse(await regular(checkpoint));
      assert(prior.schema === 1 && prior.configHash === configHash && prior.guard);
      return null;
    }
    const value = JSON.parse(await docker.run(['inspect', '--format', inspectFormat, targetName]));
    assert(ID.test(value.id) && /^sha256:[0-9a-f]{64}$/.test(value.imageId));
    assert(value.labels?.['com.docker.compose.project'] === project);
    assert(value.labels?.['com.docker.compose.service'] === 'bug-report-kit');
    const actual = value.mounts.map(m => ({ destination: m.Destination, source: m.Source,
      type: m.Type, name: m.Name ?? '', rw: m.RW })).sort((a,b) => a.destination.localeCompare(b.destination));
    const cfg = actual.find(m => m.destination === '/app/config.local.json');
    const data = actual.find(m => m.destination === '/app/data');
    assert(cfg?.source === config && cfg.type === 'bind' && cfg.rw === false);
    assert(data?.type === 'volume' && data.name === spec.data.source && data.rw === true);
    // Reject extra mounts: the common backup/rehearsal covers exactly this data.
    assert(actual.length === 2 && hash(await readRuntimeConfig()) === configHash);
    if (mounts) assert(JSON.stringify(actual) === JSON.stringify(mounts));
    else mounts = actual;
    return { id: value.id, imageId: value.imageId, imageRef: value.imageRef };
  }

  async function guardNeighbors() {
    const rows = (await docker.run(['ps', '-a', '--no-trunc', '--format', '{{.Names}}\t{{.ID}}'])).trim().split('\n').filter(Boolean);
    const current = Object.fromEntries(rows.map(row => row.split('\t')));
    // All existing neighboring containers are protected, including Vault/bot,
    // without assuming their historical names or reading their configuration.
    if (!neighbors) {
      delete current[targetName];
      assert(current[edgeName] && Object.values(current).every(id => ID.test(id)));
      neighbors = current;
    } else for (const [name, id] of Object.entries(neighbors)) assert(current[name] === id);
    return current;
  }

  async function checkGuard(guard) {
    assert(guard && guard.configHash === hash(await readRuntimeConfig()));
    assert(JSON.stringify(guard.source) === JSON.stringify(await sourceGuard()));
    // Check against the durable transaction guard, including in a fresh process.
    const actual = await inspectTarget();
    if (actual) assert(JSON.stringify(mounts) === JSON.stringify(guard.mounts));
    const current = await guardNeighbors();
    assert(guard.neighbors && Object.entries(guard.neighbors).every(([name,id]) => current[name] === id));
  }

  async function health(imageId) {
    const actual = await inspectTarget();
    assert(actual?.imageId === imageId);
    for (let attempt = 0; ; attempt++) {
      try {
        await docker.run(['exec', targetName, 'node', '-e',
          `fetch('http://127.0.0.1:${spec.runtime.port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`]);
        break;
      } catch (error) { if (attempt >= 39) throw error; await delay(1000); }
    }
  }

  async function proxyHealth() {
    for (let attempt = 0; ; attempt++) {
      try { await requestHealth(); return; }
      catch (error) { if (attempt >= 29) throw error; await delay(1000); }
    }
  }

  async function prepare({image, expected, guard = expected?.guard}) {
    assert(IMAGE.test(image));
    const actual = await adapter.inspect();
    assert(actual && actual.id === expected?.id && actual.imageId === expected?.imageId);
    await checkGuard(guard);
    const currentBytes = await regular(override);
    const next = JSON.parse(currentBytes);
    assert(next.services?.['bug-report-kit'] && Object.keys(next.services).length === 1);
    const service = next.services['bug-report-kit'];
    assert(service.environment?.BUG_KIT_SPEECH_ENABLED === '0');
    assert(service.environment?.BUG_KIT_SERVICE_STATE === '/tmp/bug-report-kit-service');
    service.image = image; service.pull_policy = 'never';
    const nextBytes = Buffer.from(`${JSON.stringify(next)}\n`);
    const prior = { schema: 1, previousImage: actual.imageId, candidateImage: image, guard,
      configHash, overrideBase64: currentBytes.toString('base64'), overrideHash: hash(currentBytes),
      candidateBase64: nextBytes.toString('base64'), candidateHash: hash(nextBytes) };
    await fs.mkdir(state, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(state);
    assert(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0);
    await atomic(checkpoint, JSON.stringify(prior));
    return nextBytes;
  }

  const adapter = {
    identity: definition.identity,
    async inspect() {
      const actual = await inspectTarget(); await guardNeighbors();
      assert(JSON.stringify(source) === JSON.stringify(await sourceGuard()));
      return actual ? {...actual, guard:{configHash, mounts, neighbors, source}} : null;
    },
    prepare,
    async activate({ image, expected, rollback = false, guard = expected?.guard }) {
      assert(IMAGE.test(image));
      const actual = await adapter.inspect();
      assert(actual?.id === expected?.id && actual?.imageId === expected?.imageId);
      await checkGuard(guard);
      const currentBytes = await regular(override);
      let nextBytes;
      if (rollback) {
        const previous = JSON.parse(await regular(checkpoint));
        assert(previous.schema === 1 && previous.configHash === configHash);
        assert([previous.overrideHash, previous.candidateHash].includes(hash(currentBytes)));
        if (previous.previousImage === image) {
          nextBytes = Buffer.from(previous.overrideBase64, 'base64');
          assert(hash(nextBytes) === previous.overrideHash);
        } else {
          assert(previous.candidateImage === image);
          nextBytes = Buffer.from(previous.candidateBase64, 'base64');
          assert(hash(nextBytes) === previous.candidateHash);
        }
      } else {
        // The existing source/config contract already fixes text-only mode.
        // Preserve all runtime environment and other Compose configuration.
        nextBytes = await prepare({image, expected, guard});
      }
      await atomic(override, nextBytes);
      try {
        await docker.run([...compose, '-f', override, 'config', '--quiet']);
        await docker.run([...compose, '-f', override, 'up', '-d', '--no-build', '--no-deps', '--pull', 'never', 'bug-report-kit']);
        const target = await inspectTarget();
        const imageId = image.startsWith('sha256:') ? image : (await docker.run(['image', 'inspect', '--format', '{{.Id}}', image])).trim();
        assert(target?.imageId === imageId);
        await health(imageId);
        await docker.run(['exec', edgeName, 'nginx', '-t']);
        await docker.run(['exec', edgeName, 'nginx', '-s', 'reload']);
        await proxyHealth();
        await guardNeighbors();
        await checkGuard(guard);
      } catch (error) {
        // The common engine performs the image rollback. Preserve the exact
        // previous override immediately, even when Compose failed midway.
        await atomic(override, currentBytes);
        throw error;
      }
    },
    async verify({ imageId, guard }) {
      if (guard) await checkGuard(guard);
      await health(imageId); await proxyHealth(); await guardNeighbors();
    },
  };
  return adapter;
}
