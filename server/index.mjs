import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApp} from './app.mjs';

const rootDir = resolve(import.meta.dirname, '..');
const configPath = resolve(rootDir, process.env.BUG_KIT_CONFIG || 'config.local.json');
let config;
try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
catch { console.error('Создайте config.local.json по примеру config.example.json'); process.exit(1); }
const {server} = createApp(config, {rootDir});
server.listen(config.port || 7337, () => {
  console.log(`Bug Report Kit: http://localhost:${config.port || 7337}`);
});
