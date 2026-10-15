import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from './app.mjs';

const rootDir = resolve(import.meta.dirname, '..');
const configPath = resolve(rootDir, process.env.BUG_KIT_CONFIG || 'config.local.json');
let config;
try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
catch { console.error('Создайте config.local.json по примеру config.example.json'); process.exit(1); }
const {server, db} = createApp(config, {rootDir});
const host = process.env.BUG_KIT_HOST || config.host || '127.0.0.1';
server.listen(config.port || 7337, host, () => {
  console.log(`Bug Report Kit: http://${host}:${config.port || 7337}`);
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => { db.close(); process.exit(0); });
  server.closeIdleConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
