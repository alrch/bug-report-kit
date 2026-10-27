import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';

export const MAX_AUDIO = 5 * 1024 * 1024;
export function parseAudio(value) {
  if (value == null) return null;
  const match = typeof value === 'string' && /^data:(audio\/(?:mp4|webm|ogg|wav));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length > Math.ceil(MAX_AUDIO / 3) * 4 + 4) throw new Error('Запись должна быть MP4, WebM, Ogg или WAV, не больше 5 МБ');
  const data = Buffer.from(match[2], 'base64');
  const mime = match[1];
  const valid = mime === 'audio/mp4' ? data.toString('ascii', 4, 8) === 'ftyp'
    : mime === 'audio/webm' ? data.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))
      : mime === 'audio/ogg' ? data.toString('ascii', 0, 4) === 'OggS'
        : data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WAVE';
  if (!valid || !data.length || data.length > MAX_AUDIO || data.toString('base64') !== match[2]) throw new Error('Некорректная аудиозапись');
  return {mime, data};
}

// Jobs and original bytes live in the same SQLite backup as the report.
export function audioStore(db, config = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS report_audio (
    report_id TEXT PRIMARY KEY REFERENCES reports(id), data BLOB NOT NULL, mime TEXT NOT NULL,
    state TEXT NOT NULL, transcript TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
    lease TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS transcription_drafts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner TEXT NOT NULL, token_hash TEXT NOT NULL,
    data BLOB NOT NULL, mime TEXT NOT NULL, state TEXT NOT NULL,
    transcript TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
    lease TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL
  )`);
  // Track temporary plaintext audio across process crashes. A lease outlives
  // the child deadline, so a replacement worker never removes live input.
  db.exec('CREATE TABLE IF NOT EXISTS speech_workdirs (path TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  const draftTtl = 15 * 60 * 1000;
  const digest = value => createHash('sha256').update(String(value || '')).digest('hex');
  let activeDraft = null;
  const cleanup = () => {
    if (closed) return;
    if (activeDraft && db.prepare('SELECT expires_at FROM transcription_drafts WHERE id=?').get(activeDraft)?.expires_at <= Date.now()) child?.kill('SIGKILL');
    db.prepare('DELETE FROM transcription_drafts WHERE expires_at<=?').run(Date.now());
    for (const row of db.prepare('SELECT path FROM speech_workdirs WHERE expires_at<=?').all(Date.now())) {
      if (dirname(row.path)===tmpdir() && basename(row.path).startsWith('bug-kit-speech-')) rmSync(row.path,{recursive:true,force:true});
      db.prepare('DELETE FROM speech_workdirs WHERE path=?').run(row.path);
    }
  };
  const draftFor = (id, token, project, owner) => {
    cleanup();
    return db.prepare('SELECT * FROM transcription_drafts WHERE id=? AND token_hash=? AND project_id=? AND owner=?')
      .get(String(id || ''), digest(token), project, owner);
  };
  const command = config.command;
  const enabled = Array.isArray(command) && command.length && command.every(x => typeof x === 'string' && x.length);
  const timeout = Math.max(1000, Math.min(config.timeoutMs || 300000, 600000));
  let closed = false, running = false, child = null;
  const metadata = id => {
    const row = db.prepare('SELECT mime,length(data) AS size,state,transcript,error FROM report_audio WHERE report_id=?').get(id);
    return row ? {audioAvailable:true, audioMime:row.mime, audioSize:row.size,
      transcription:{state:row.state, text:row.transcript, error:row.error}} : {audioAvailable:false};
  };
  cleanup();
  const timer = setInterval(() => {cleanup(); void pump();}, 2000);
  timer.unref();
  async function pump() {
    if (closed || running || !enabled) return;
    running = true;
    let directory;
    try {
      cleanup();
      const draft = db.prepare("SELECT *,id AS report_id FROM transcription_drafts WHERE state='pending' OR (state='processing' AND started_at<?) ORDER BY rowid LIMIT 1").get(Date.now() - timeout - 10000);
      const row = draft || db.prepare("SELECT * FROM report_audio WHERE state='pending' OR (state='processing' AND started_at<?) ORDER BY rowid LIMIT 1").get(Date.now() - timeout - 10000);
      if (!row) return;
      const table = draft ? 'transcription_drafts' : 'report_audio';
      const key = draft ? 'id' : 'report_id';
      activeDraft = draft?.id || null;
      const lease = randomUUID();
      const result = db.prepare(`UPDATE ${table} SET state='processing',lease=?,started_at=?,error='' WHERE ${key}=? AND (state='pending' OR started_at<?)`)
        .run(lease, Date.now(), row.report_id, Date.now() - timeout - 10000);
      if (!result.changes) return;
      directory = mkdtempSync(join(tmpdir(), 'bug-kit-speech-'));
      db.prepare('INSERT INTO speech_workdirs(path,expires_at) VALUES(?,?)').run(directory,Date.now()+timeout+10000);
      const input = join(directory, 'recording');
      const output = join(directory, 'transcript.txt');
      writeFileSync(input, row.data, {mode:0o600});
      try {
        await new Promise((resolve, reject) => {
          child = spawn(command[0], [...command.slice(1), input, output], {stdio:'ignore', shell:false,
            env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,LANG:process.env.LANG,HF_HUB_OFFLINE:'1'}});
          const deadline = setTimeout(() => { child?.kill('SIGKILL'); }, timeout);
          child.once('error', reject);
          child.once('close', code => { clearTimeout(deadline); code === 0 ? resolve() : reject(new Error('transcription failed')); });
        });
        const text = readFileSync(output, 'utf8').trim();
        if (!text) throw new Error('empty transcript');
        if (!closed) db.prepare(`UPDATE ${table} SET state='ready',transcript=?,error='',lease='' WHERE ${key}=? AND lease=?`).run(text, row.report_id, lease);
      } catch {
        if (!closed) db.prepare(`UPDATE ${table} SET state='failed',error=?,lease='' WHERE ${key}=? AND lease=?`)
          .run('Не удалось распознать запись. Оригинал сохранён; можно прослушать или повторить.', row.report_id, lease);
      }
    } finally {
      child = null;
      activeDraft = null;
      if (directory) {
        rmSync(directory, {recursive:true, force:true});
        if (!closed) db.prepare('DELETE FROM speech_workdirs WHERE path=?').run(directory);
      }
      running = false;
    }
  }
  return {
    metadata, draftFor, cleanup,
    createDraft(project, owner, recording) {
      cleanup();
      if (db.prepare('SELECT count(*) AS n FROM transcription_drafts WHERE project_id=?').get(project).n >= 8) {
        const error = new Error('Очередь распознавания заполнена. Повторите позже'); error.status = 429; throw error;
      }
      const id = randomUUID(), draftToken = randomUUID();
      db.prepare('INSERT INTO transcription_drafts(id,project_id,owner,token_hash,data,mime,state,error,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id,project,owner,digest(draftToken),recording.data,recording.mime,enabled ? 'pending' : 'unavailable',enabled ? '' : 'Распознавание не настроено. Можно ввести текст вручную.',Date.now()+draftTtl);
      return {id,draftToken};
    },
    draftMetadata(row) {return {id:row.id,state:row.state,text:row.transcript,error:row.error,expiresAt:row.expires_at};},
    cancelDraft(id) {
      if (activeDraft === id) child?.kill('SIGKILL');
      db.prepare('DELETE FROM transcription_drafts WHERE id=?').run(id);
    },
    retryDraft(id) {
      if (!enabled) return false;
      return Boolean(db.prepare("UPDATE transcription_drafts SET state='pending',error='',expires_at=? WHERE id=? AND state IN ('failed','unavailable')").run(Date.now()+draftTtl,id).changes);
    },
    insert(id, audio, draft) { if (audio) db.prepare('INSERT INTO report_audio(report_id,data,mime,state,error,transcript) VALUES(?,?,?,?,?,?)')
      .run(id, audio.data, audio.mime, draft?.state || (enabled ? 'pending' : 'unavailable'), draft?.error || (enabled ? '' : 'Распознавание на сервере не настроено. Оригинал сохранён.'),draft?.transcript || ''); },
    read:id=>db.prepare('SELECT data,mime FROM report_audio WHERE report_id=?').get(id),
    retry(id) {
      if (!enabled) return false;
      return Boolean(db.prepare("UPDATE report_audio SET state='pending',error='' WHERE report_id=? AND state IN ('failed','unavailable')").run(id).changes);
    },
    pump,
    close() {closed = true; clearInterval(timer); child?.kill('SIGKILL');},
  };
}
