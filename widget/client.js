import {init} from './loader-core.js';

// The same state is shared even when the pinned module appears in two bundles.
// Every browser page still owns its own state, SDK and project configuration.
const KEY = Symbol.for('bug-report-kit.client.v1');
const BOOLS = ['reporterAuth', 'voiceEnabled', 'captureFetchErrors'];
const STRINGS = ['appVersion', 'label', 'launcherStyle', 'reporterName', 'reporterContact'];
const KEYS = new Set(['serverUrl', 'projectKey', 'getReporter', ...BOOLS, ...STRINGS]);
const defaultReporter = () => window.__BUG_REPORT_KIT_REPORTER_PROVIDER__?.() || {};

function normalize(input, nonce) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !KEYS.has(key))) throw new Error('Invalid Kit client options');
  if (typeof nonce !== 'string') throw new Error('Invalid Kit client nonce');
  const raw = input.serverUrl ?? location.origin;
  if (typeof raw !== 'string' || !raw || raw !== raw.trim() || /[\s\\]/.test(raw)) throw new Error('Invalid Kit server URL');
  const url = new URL(raw, document.baseURI);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Kit server requires HTTPS or a loopback HTTP address');
  }
  if (typeof input.projectKey !== 'string' || !input.projectKey.trim() || /[\s\x00-\x1f]/.test(input.projectKey)) {
    throw new Error('A public Kit project key is required');
  }
  const options = {serverUrl: url.href.replace(/\/+$/, ''), projectKey: input.projectKey};
  for (const key of BOOLS) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error('Invalid Kit client flag');
    options[key] = input[key] ?? false;
  }
  for (const key of STRINGS) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw new Error('Invalid Kit client text');
    options[key] = input[key];
  }
  if (input.getReporter !== undefined && typeof input.getReporter !== 'function') throw new Error('Invalid Kit reporter provider');
  options.getReporter = input.getReporter ?? defaultReporter;
  return {options, nonce, provider: input.getReporter ?? null};
}

function compatible(a, b) {
  return a.nonce === b.nonce && a.provider === b.provider
    && Object.keys(a.options).every(key => key === 'getReporter' || a.options[key] === b.options[key]);
}

/** Acquire one lease. Keep getReporter stable and read the current user inside it. */
export function acquireKit(options, {nonce = ''} = {}) {
  const configuration = normalize(options, nonce);
  const scope = window[KEY] ??= {schema: 1, active: null};
  if (scope.schema !== 1) throw new Error('Incompatible Kit client version');
  let active = scope.active;
  if (active && !compatible(active.configuration, configuration)) {
    if (active.users) throw new Error('Another Kit configuration is still in use');
    active.loader.destroy();
    scope.active = active = null;
  }
  if (active?.loader.destroyed) throw new Error('Kit client loader was destroyed outside its owner');
  if (!active) {
    // Never adopt an unknown loader/SDK: its project, endpoint and users are unknown.
    const loader = init(configuration.options, nonce, {exclusive: true});
    active = {configuration, loader, users: 0};
    scope.active = active;
  }
  active.users += 1;
  let released = false;
  function requireLease() {
    if (released || scope.active !== active || active.loader.destroyed) throw new Error('Kit client lease was released');
  }
  return Object.freeze({
    get ready() { requireLease(); return active.loader.ready; },
    retry() { requireLease(); active.loader.retry(); return active.loader.ready; },
    release() {
      if (released) return;
      released = true;
      active.users -= 1;
      // React StrictMode / immediate re-entry can retain this exact generation.
      queueMicrotask(() => {
        if (scope.active !== active || active.users) return;
        try { active.loader.destroy(); }
        finally { if (scope.active === active) scope.active = null; }
      });
    },
  });
}
