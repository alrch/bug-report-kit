import {createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const scryptAsync = promisify(scrypt);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILED_PINS = 5;
const REQUESTS_PER_MINUTE = 30;

const normalizeName = (value) => typeof value === 'string'
  ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const validName = (name) => name.length >= 2 && name.length <= 80
  && /^[\p{L}\p{M}\p{N} _.-]+$/u.test(name);
const nameKey = (name) => name.toLocaleLowerCase('ru-RU');
const validPin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const publicAccount = (account) => ({id: account.id, name: account.name});

export function createReporterAuth(db, config) {
  if (config.projects.some((project) => project.reporterAuth)
    && (typeof config.reporterAuthSecret !== 'string' || config.reporterAuthSecret.length < 32)) {
    throw new Error('Для reporterAuth задайте reporterAuthSecret длиной не менее 32 символов');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS reporter_accounts (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
    pin_salt TEXT NOT NULL, pin_hash TEXT NOT NULL, failed_pins INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    UNIQUE(project_id, name_key)
  );
  CREATE TABLE IF NOT EXISTS reporter_sessions (
    token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reporter_sessions_account ON reporter_sessions(account_id);`);
  const byName = db.prepare('SELECT * FROM reporter_accounts WHERE project_id=? AND name_key=?');
  const byToken = db.prepare(`SELECT a.id,a.name,a.project_id FROM reporter_sessions s
    JOIN reporter_accounts a ON a.id=s.account_id
    WHERE s.token_hash=? AND s.project_id=? AND s.expires_at>?`);
  const addAccount = db.prepare(`INSERT OR IGNORE INTO reporter_accounts
    (id,project_id,name,name_key,pin_salt,pin_hash,created_at) VALUES (?,?,?,?,?,?,?)`);
  const addSession = db.prepare(`INSERT INTO reporter_sessions
    (token_hash,account_id,project_id,expires_at) VALUES (?,?,?,?)`);
  const attempts = new Map();

  const hashPin = async (pin, salt) => {
    const protectedPin = createHmac('sha256', config.reporterAuthSecret).update(pin).digest();
    return (await scryptAsync(protectedPin, Buffer.from(salt, 'hex'), 64)).toString('hex');
  };
  const limited = (project, ip) => {
    const key = `${project.id}:${ip}`;
    const now = Date.now();
    const state = attempts.get(key) || {count: 0, until: now + 60_000};
    if (now > state.until) { state.count = 0; state.until = now + 60_000; }
    state.count += 1;
    attempts.set(key, state);
    return state.count > REQUESTS_PER_MINUTE;
  };
  const makeSession = (account) => {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_MS;
    db.prepare('DELETE FROM reporter_sessions WHERE expires_at<=?').run(Date.now());
    addSession.run(tokenHash(token), account.id, account.project_id, expiresAt);
    return {token, expiresAt: new Date(expiresAt).toISOString(), reporter: publicAccount(account)};
  };
  const accountForToken = (project, token) => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return byToken.get(tokenHash(token), project.id, Date.now()) || null;
  };
  const register = async (project, body, ip) => {
    if (project.reporterRegistration === false) return {status: 403, code: 'registration_closed',
      error: 'Самостоятельная регистрация закрыта. Войдите с выданными именем и PIN или обратитесь к сопровождающему проекта.'};
    if (limited(project, ip)) return {status: 429, error: 'Слишком много попыток. Повторите позже'};
    const name = normalizeName(body?.name);
    if (!validName(name)) return {status: 400, error: 'Имя: 2–80 букв, цифр, пробелов или символов _ . -'};
    if (!validPin(body?.pin)) return {status: 400, error: 'PIN должен содержать ровно 4 цифры'};
    if (byName.get(project.id, nameKey(name))) {
      return {status: 409, code: 'name_taken', error: 'Это имя уже занято. Войдите со своим PIN или придумайте другое имя.'};
    }
    const salt = randomBytes(16).toString('hex');
    const pinHash = await hashPin(body.pin, salt);
    const account = {id: randomUUID(), project_id: project.id, name};
    const inserted = addAccount.run(account.id, project.id, name, nameKey(name), salt, pinHash, new Date().toISOString());
    if (!inserted.changes) return {status: 409, code: 'name_taken', error: 'Это имя уже занято. Войдите со своим PIN или придумайте другое имя.'};
    return {status: 201, ...makeSession(account)};
  };
  const login = async (project, body, ip) => {
    if (limited(project, ip)) return {status: 429, error: 'Слишком много попыток. Повторите позже'};
    const name = normalizeName(body?.name);
    if (!validName(name) || !validPin(body?.pin)) return {status: 400, error: 'Укажите имя и PIN из 4 цифр'};
    const account = byName.get(project.id, nameKey(name));
    if (!account) return {status: 401, code: 'name_not_found', error: project.reporterRegistration === false
      ? 'Такого имени нет. Проверьте выданное имя или обратитесь к сопровождающему проекта.'
      : 'Такого имени нет. Проверьте написание или создайте имя.'};
    if (account.locked_until > Date.now()) return {status: 429, error: 'Слишком много ошибок PIN. Повторите позже'};
    const attemptedHash = await hashPin(body.pin, account.pin_salt);
    const correct = timingSafeEqual(Buffer.from(attemptedHash, 'hex'), Buffer.from(account.pin_hash, 'hex'));
    if (!correct) {
      const failed = account.failed_pins + 1;
      db.prepare('UPDATE reporter_accounts SET failed_pins=?,locked_until=? WHERE id=?')
        .run(failed >= MAX_FAILED_PINS ? 0 : failed,
          failed >= MAX_FAILED_PINS ? Date.now() + LOCK_MS : 0, account.id);
      return {status: 401, code: 'wrong_pin', error: 'Неверный PIN. Проверьте четыре цифры и попробуйте ещё раз.'};
    }
    db.prepare('UPDATE reporter_accounts SET failed_pins=0,locked_until=0 WHERE id=?').run(account.id);
    return {status: 200, ...makeSession(account)};
  };
  const logout = (token) => {
    if (typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      db.prepare('DELETE FROM reporter_sessions WHERE token_hash=?').run(tokenHash(token));
    }
  };
  return {register, login, logout, accountForToken};
}
