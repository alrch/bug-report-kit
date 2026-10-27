import {readFile} from 'node:fs/promises';

const [mode, audioPath] = process.argv.slice(2);
if (!['speech', 'runtime'].includes(mode) || !audioPath) throw new Error('Usage: smoke-image.mjs speech|runtime /tmp/synthetic-ru.wav');
const base = 'http://127.0.0.1:7337';
const routes = [
  ['/healthz', 'application/json'],
  ['/loader.js', 'application/javascript'],
  ['/widget.js', 'application/javascript'],
  ['/widget.css', 'text/css'],
];
for (const [path, mime] of routes) {
  const response = await fetch(`${base}${path}`);
  if (!response.ok || !response.headers.get('content-type')?.startsWith(mime)) throw new Error(`asset check failed: ${path}`);
  const body = await response.text();
  if (path === '/healthz' && !JSON.parse(body).ok) throw new Error('health check failed');
  if (path === '/loader.js' && !body.includes('BugReportKitLoader')) throw new Error('loader asset is invalid');
}
const wav = await readFile(audioPath);
const response = await fetch(`${base}/api/transcription-drafts`, {
  method: 'POST',
  headers: {'content-type': 'application/json', 'origin': 'http://localhost:7337', 'x-project-key': 'ci-public-key'},
  body: JSON.stringify({pageUrl: 'http://localhost:7337/ci', audio: `data:audio/wav;base64,${wav.toString('base64')}`}),
});
if (response.status !== 202) throw new Error(`draft creation failed (${response.status})`);
const created = await response.json();
if (!created.id || !created.draftToken) throw new Error('draft credentials missing');
const headers = {'origin': 'http://localhost:7337', 'x-project-key': 'ci-public-key', 'x-draft-token': created.draftToken};
if (mode === 'runtime') {
  const status = await fetch(`${base}/api/transcription-drafts/${created.id}`, {headers});
  const draft = await status.json();
  if (draft.state !== 'unavailable') throw new Error('lightweight runtime unexpectedly enabled ASR');
  console.log('runtime assets and disabled-ASR contract passed');
  process.exit(0);
}
const deadline = Date.now() + 8 * 60_000;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 3000));
  const status = await fetch(`${base}/api/transcription-drafts/${created.id}`, {headers});
  if (!status.ok) throw new Error(`draft polling failed (${status.status})`);
  const draft = await status.json();
  if (draft.state === 'ready') {
    if (!/[А-Яа-яЁё]/u.test(draft.text || '')) throw new Error('ASR transcript is not Russian text');
    console.log('speech assets and offline Russian ASR passed');
    process.exit(0);
  }
  if (draft.state === 'failed') throw new Error('offline ASR failed');
}
throw new Error('offline ASR timed out');
