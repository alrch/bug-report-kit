#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {readFile} from 'node:fs/promises';

const [command, ...args] = process.argv.slice(2);
const base = process.env.BUG_KIT_URL?.replace(/\/+$/, '');
const token = process.env.BUG_KIT_TOKEN;
if (!base || !/^https?:\/\//.test(base) || !token) {
  console.error('Укажите BUG_KIT_URL (http(s) адрес сервера) и BUG_KIT_TOKEN (токен команды)');
  process.exit(2);
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, `${base}/`), {
    ...options,
    headers: {Authorization: `Bearer ${token}`, ...options.headers},
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try { message = (await response.json()).error || message; } catch { /* no JSON body */ }
    throw new Error(message);
  }
  return response;
}

function id(value) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(value || '')) throw new Error('Укажите корректный ID бага');
  return value;
}

async function main() {
  let response;
  if (command === 'me' && args.length === 0) response = await request('/api/me');
  else if (command === 'projects' && args.length === 0) response = await request('/api/projects');
  else if (command === 'list' && args.length <= 1) {
    const params = new URLSearchParams();
    if (args[0]) params.set('status', args[0]);
    response = await request(`/api/reports?${params}`);
  } else if (command === 'show' && args.length === 1) response = await request(`/api/reports/${id(args[0])}`);
  else if (command === 'summary' && args.length >= 2 && args.length <= 3) {
    const params = new URLSearchParams({from: args[0], to: args[1]});
    if (args[2]) params.set('groupBy', args[2]);
    response = await request(`/api/summary?${params}`);
  } else if (command === 'screenshot' && args.length === 2) {
    response = await request(`/api/reports/${id(args[0])}/screenshot`);
    await writeFile(args[1], Buffer.from(await response.arrayBuffer()), {flag: 'wx'});
    console.log(args[1]);
    return;
  } else if (command === 'attachment' && args.length === 2) {
    response = await request(`/api/reports/${id(args[0])}/attachment`);
    await writeFile(args[1], Buffer.from(await response.arrayBuffer()), {flag: 'wx'});
    console.log(args[1]);
    return;
  } else if (command === 'action' && args.length === 2) {
    const body = JSON.parse(await readFile(args[1], 'utf8'));
    if (!body || !Number.isInteger(body.revision) || typeof body.action !== 'string') {
      throw new Error('Файл действия должен содержать revision и action');
    }
    response = await request(`/api/reports/${id(args[0])}`, {
      method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
    });
  } else {
    throw new Error('Команды: me | projects | list [status] | show ID | screenshot ID FILE | attachment ID FILE | action ID JSON_FILE | summary FROM TO [groupBy]');
  }
  console.log(JSON.stringify(await response.json(), null, 2));
}

main().catch((error) => {console.error(error.message); process.exitCode = 1;});
