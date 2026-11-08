import {isAbsolute, resolve} from 'node:path';
import {lstatSync, readFileSync, realpathSync} from 'node:fs';

export class DeploymentError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new DeploymentError(code); };
const object = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const imageReference = value => typeof value === 'string' && /^(?:sha256:[a-f0-9]{64}|[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64})$/.test(value);
const path = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && value !== '/' && !/[\s,:\0]/.test(value);
export function validateConfig(spec) {
  if (!object(spec, ['schema', 'profile', 'instance', 'artifact', 'stateDirectory', 'configRef', 'data', 'runtime', 'proxy']) ||
      spec.schema !== 1 || spec.profile !== 'docker-server' || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(spec.instance ?? '') ||
      !object(spec.artifact, ['image']) || !imageReference(spec.artifact.image) || !path(spec.stateDirectory) || !path(spec.configRef) ||
      !object(spec.data, ['type', 'source']) || !['bind', 'volume'].includes(spec.data.type) ||
      (spec.data.type === 'bind' ? !path(spec.data.source) : !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(spec.data.source ?? '')) ||
      !object(spec.runtime, ['uid', 'gid', 'port']) || ['uid', 'gid'].some(key => !Number.isInteger(spec.runtime[key]) || spec.runtime[key] < 0 || spec.runtime[key] > 2147483647) ||
      !Number.isInteger(spec.runtime.port) || spec.runtime.port < 1024 || spec.runtime.port > 65535 ||
      !object(spec.proxy, ['healthUrl'])) fail('INVALID_CONFIG');
  let url;
  try { url = new URL(spec.proxy.healthUrl); } catch { fail('INVALID_CONFIG'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/healthz' && !url.pathname.endsWith('/healthz') ||
      url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) fail('INVALID_CONFIG');
  // Persistent paths must never be underneath transaction state or vice versa.
  const paths = [spec.stateDirectory, spec.configRef, ...(spec.data.type === 'bind' ? [spec.data.source] : [])];
  if (paths.some((a, i) => paths.some((b, j) => i !== j && (a === b || a.startsWith(`${b}/`))))) fail('UNSAFE_PATHS');
  return spec;
}
export function regularPrivate(path, {directory = false, allowedUid} = {}) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid() && info.uid !== allowedUid)) fail('UNSAFE_PRIVATE_PATH');
  // Resolve all ancestors too; a private leaf must not hide a redirected path.
  if (realpathSync(path) !== path) fail('UNSAFE_PRIVATE_PATH');
}
export function readConfig(path) {
  regularPrivate(path);
  if (lstatSync(path).size > 32_768) fail('INVALID_CONFIG');
  return validateConfig(JSON.parse(readFileSync(path, 'utf8')));
}
