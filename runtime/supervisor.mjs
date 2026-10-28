import { setTimeout as pause } from 'node:timers/promises';

// Own only the passed child and servers. In particular, never kill a listener
// discovered by port number: a conflict must leave the existing process intact.
export function supervise({ child, servers, probe, intervalMs = 30_000, timeoutMs = 5000,
  failureLimit = 3, graceMs = 5000, log = console.log, exit = code => { process.exitCode = code; } }) {
  let stopping = false, failures = 0, finalCode = 0;
  const controller = new AbortController();
  const record = (event, fields = {}) => log(JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields }));
  function stop(reason, code = 1) {
    if (stopping) return;
    stopping = true; finalCode = code; controller.abort(); exit(code);
    record('stopping', { reason, code });
    for (const { server } of servers) { server.close(); server.closeAllConnections(); }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, graceMs);
      timer.unref(); child.once('exit', () => clearTimeout(timer));
    }
  }
  child.once('error', error => { record('kit-spawn-error', { code: error.code ?? 'UNKNOWN' }); stop('kit-spawn-error'); });
  child.once('exit', (code, signal) => {
    record('kit-exit', { code, signal });
    if (stopping) exit(finalCode); // Preserve the original failure even if the child handles SIGTERM and exits 0.
    else stop('kit-exit');
  });
  for (const { name, server } of servers) {
    server.once('error', error => { record('listener-error', { component: name, code: error.code ?? 'UNKNOWN' }); stop('listener-error'); });
  }
  const term = () => stop('SIGTERM', 0), interrupt = () => stop('SIGINT', 0);
  process.once('SIGTERM', term); process.once('SIGINT', interrupt);
  const health = (async () => {
    while (!stopping) {
      try { await pause(intervalMs, undefined, { signal: controller.signal }); }
      catch { break; }
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
        if (!(await probe(signal))) throw new Error('Unhealthy');
        if (failures) record('health-recovered');
        failures = 0;
      } catch {
        if (stopping) break;
        record('health-failure', { consecutive: ++failures });
        if (failures >= failureLimit) stop('health-failed');
      }
    }
    process.removeListener('SIGTERM', term); process.removeListener('SIGINT', interrupt);
  })();
  record('started', { kitPid: child.pid });
  return { stop, health };
}
