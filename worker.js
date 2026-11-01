// Song Rider Suite API (Cloudflare Worker).
// Static files are served by the ASSETS binding; only /api/* runs through this worker.
//
// Sync contract (see docs/SYNC.md):
//   * Every project row has a server revision ("rev"). For CRP projects rev === updated_at
//     (server clock, ms). For SRP projects rev is a dedicated column.
//   * Clients send the rev they last saw as `baseRev`. If the row changed since then the
//     server answers 409 {code:'conflict', project:<server copy>} instead of overwriting.
//   * Deletes leave a tombstone so other devices learn about them instead of re-uploading.
//   * Requests without `baseRev` keep the legacy last-write-wins behaviour so older cached
//     builds keep working while they update.

const enc = new TextEncoder();
const COOKIE = 'crp_session';
const ITERATIONS = 100000; // Workers' PBKDF2 maximum.
const SESSION_DAYS = 30;
const TOMBSTONE_DAYS = 180;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_EMAIL = 10;
const LOGIN_MAX_PER_IP = 60;

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const randomToken = (n = 32) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const parseJson = (s, fallback = {}) => { try { return JSON.parse(s); } catch { return fallback; } };
const finiteOrNull = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

function bytesToBase64(bytes) {
  // Chunked so large audio does not blow the call stack or allocate a giant number array.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function sha256(s) { return b64(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hashPassword(password, saltB64, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(saltB64), iterations }, key, 256);
  return b64(bits);
}
function safeEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
function cookie(request, name) { const raw = request.headers.get('Cookie') || ''; for (const part of raw.split(';')) { const [k, ...v] = part.trim().split('='); if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } } } return null; }
function sessionCookie(token, maxAge = SESSION_DAYS * 86400) { return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
async function body(request) { try { return await request.json(); } catch { return {}; } }
function clientIp(request) { return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 'unknown'; }

async function userFor(request, env) {
  const token = cookie(request, COOKIE); if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare('SELECT users.id, users.email, users.display_name FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=? AND sessions.expires_at>?').bind(tokenHash, Date.now()).first();
  return row || null;
}
async function createSession(userId, env) {
  const token = randomToken(), id = crypto.randomUUID(), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
    env.DB.prepare('INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').bind(id, userId, await sha256(token), now + SESSION_DAYS * 86400000, now),
  ]);
  return token;
}
function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }
function validEmail(e) { return typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

// ---------------------------------------------------------------------------
// Lazily created tables (the core users/sessions/projects tables live in migrations/).
// ---------------------------------------------------------------------------
const VALID_SKINS = new Set(['rider-original', 'rider-og', 'rider-blood', 'studio-pastel', 'black-label', 'black-label-plain', 'black-label-light', 'sapphire-paisley', 'sapphire-paisley-light', 'royal-wave', 'candy-pop', 'rider-light', 'rider-light-og', 'rider-blood-light', 'rider-blood-light-og']);
let userPreferencesSchemaReady = false;
async function ensureUserPreferencesSchema(env) {
  if (userPreferencesSchemaReady) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY, skin TEXT, updated_at INTEGER NOT NULL DEFAULT 0)').run();
  userPreferencesSchemaReady = true;
}

let srpSchemaReady = false;
async function ensureSrpSchema(env) {
  if (srpSchemaReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS srp_projects (
    owner_user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    legacy_user_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT,
    last_synced_at TEXT,
    rev INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_user_id, project_id)
  )`).run();
  // Older databases were created before the rev column existed.
  try { await env.DB.prepare('ALTER TABLE srp_projects ADD COLUMN rev INTEGER NOT NULL DEFAULT 0').run(); } catch { /* already present */ }
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_srp_projects_owner_updated ON srp_projects(owner_user_id, updated_at DESC)').run();
  srpSchemaReady = true;
}

let syncSchemaReady = false;
async function ensureSyncSchema(env) {
  if (syncSchemaReady) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS project_tombstones (user_id TEXT NOT NULL, project_id TEXT NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY (user_id, project_id))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS login_attempts (attempt_key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL DEFAULT 0)'),
  ]);
  syncSchemaReady = true;
}

// ---------------------------------------------------------------------------
// Login throttling: counts failed attempts per email and per IP in a 15 minute window.
// ---------------------------------------------------------------------------
async function loginBlocked(env, keys) {
  await ensureSyncSchema(env);
  const now = Date.now();
  for (const [key, max] of keys) {
    const row = await env.DB.prepare('SELECT failures, window_start FROM login_attempts WHERE attempt_key=?').bind(key).first();
    if (row && now - Number(row.window_start) < LOGIN_WINDOW_MS && Number(row.failures) >= max) {
      return Math.ceil((LOGIN_WINDOW_MS - (now - Number(row.window_start))) / 1000);
    }
  }
  return 0;
}
async function recordLoginFailure(env, keys) {
  const now = Date.now();
  await env.DB.batch(keys.map(([key]) => env.DB.prepare(`INSERT INTO login_attempts(attempt_key,failures,window_start) VALUES(?,1,?)
    ON CONFLICT(attempt_key) DO UPDATE SET
      failures=CASE WHEN ?-login_attempts.window_start>=? THEN 1 ELSE login_attempts.failures+1 END,
      window_start=CASE WHEN ?-login_attempts.window_start>=? THEN ? ELSE login_attempts.window_start END`).bind(key, now, now, LOGIN_WINDOW_MS, now, LOGIN_WINDOW_MS, now)));
}
async function clearLoginFailures(env, key) { await env.DB.prepare('DELETE FROM login_attempts WHERE attempt_key=?').bind(key).run(); }
const tooMany = retryAfter => json({ ok: false, code: 'rate_limited', error: `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfter / 60))} minute(s).` }, 429, { 'Retry-After': String(retryAfter) });

// ---------------------------------------------------------------------------
// SRP media helpers
// ---------------------------------------------------------------------------
async function srpRowFor(env, userId, projectId) {
  await ensureSrpSchema(env);
  return env.DB.prepare('SELECT owner_user_id,project_id,legacy_user_id,deleted FROM srp_projects WHERE owner_user_id=? AND project_id=?').bind(userId, projectId).first();
}
function srpMediaAllowed(row, userId, projectId, key) {
  const clean = String(key || '').replace(/^\/+/, ''), pid = String(projectId || '');
  if (!clean || !pid || !row || clean.includes('..')) return false;
  const prefixes = [`${userId}/${pid}/`];
  if (row.legacy_user_id) prefixes.push(`${row.legacy_user_id}/${pid}/`);
  return prefixes.some(prefix => clean.startsWith(prefix));
}
function mimeForPath(path, fallback = 'application/octet-stream') {
  const p = String(path || '').toLowerCase();
  const map = [['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.ogg', 'audio/ogg'], ['.webm', 'audio/webm'], ['.m4a', 'audio/mp4'], ['.mp4', 'audio/mp4'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.heic', 'image/heic']];
  for (const [ext, type] of map) if (p.endsWith(ext)) return type;
  return fallback;
}
function tooLarge(request, limit) { return Number(request.headers.get('Content-Length') || 0) > limit; }

// ---------------------------------------------------------------------------
// Workers AI transcription helpers
// ---------------------------------------------------------------------------
const TURBO_MODEL = '@cf/openai/whisper-large-v3-turbo';
const DICTATION_PROMPTS = {
  hiphop: "Conversational hip-hop and rap lyrics in American English and African American English. Slang vocabulary and spellings: ain't, gon', gonna, finna, tryna, wanna, gotta, y'all, 'em, cuz, bruh, homie, lil', doin', goin', ridin', trippin'. Spoken line commands: new bar, next bar. Verbatim lyrics with the speaker's dialect and contractions.",
  worship: 'Worship, gospel and praise song lyrics in English. Common words: Lord, Jesus, Holy Spirit, hallelujah, glory, grace, mercy, praise, worship, hosanna, Savior, King, heaven. Spoken line commands: new bar, next bar. Verbatim lyrics.',
  country: "Country song lyrics in American English. Common words and spellings: y'all, ain't, gonna, wanna, pickup truck, dirt road, whiskey, honky-tonk, small town, lovin', drinkin', ridin'. Spoken line commands: new bar, next bar. Verbatim lyrics with the singer's contractions.",
  pop: 'Pop and rock song lyrics in English. Verbatim lyrics with contractions such as gonna, wanna, gotta, oh, yeah, baby. Spoken line commands: new bar, next bar.',
  rnb: "R&B and soul song lyrics in American English. Words and spellings: baby, girl, gon', gonna, wanna, tryna, lovin', feelin', ooh, yeah. Spoken line commands: new bar, next bar. Verbatim lyrics with contractions.",
  general: 'Song lyrics in English. Verbatim lyrics with contractions. Spoken line commands: new bar, next bar.',
};
function dictationPrompt(request, url) {
  const style = String(request.headers.get('X-Dictation-Style') || url.searchParams.get('style') || 'hiphop').toLowerCase().replace(/[^a-z]/g, '');
  return DICTATION_PROMPTS[style] || DICTATION_PROMPTS.hiphop;
}
function wordsFromWhisper(result) {
  if (Array.isArray(result?.words)) return result.words;
  if (Array.isArray(result?.transcription_info?.words)) return result.transcription_info.words;
  if (Array.isArray(result?.segments)) return result.segments.flatMap(s => Array.isArray(s?.words) ? s.words : []);
  return [];
}

// ---------------------------------------------------------------------------
// CRP project helpers
// ---------------------------------------------------------------------------
function crpProjectFromRow(r) {
  const data = parseJson(r.data);
  return { ...data, id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, rev: Number(r.updated_at) || 0 };
}
async function tombstoneFor(env, userId, projectId) {
  await ensureSyncSchema(env);
  return env.DB.prepare('SELECT deleted_at FROM project_tombstones WHERE user_id=? AND project_id=?').bind(userId, projectId).first();
}
function srpProjectFromRow(r) {
  return { ...r, user_id: r.owner_user_id, data: parseJson(r.data), deleted: !!r.deleted, rev: Number(r.rev) || 0 };
}

async function api(request, env, url) {
  const path = url.pathname, method = request.method;

  if (path === '/api/health') {
    try { const r = await env.DB.prepare('SELECT 1 ok').first(); return json({ ok: r?.ok === 1, app: 'Song Rider Suite', database: 'connected' }); }
    catch (e) { console.error('Health check failed', e); return json({ ok: false, error: 'Database unavailable.' }, 500); }
  }
  if (path === '/api/auth/me' && method === 'GET') { const u = await userFor(request, env); return json({ ok: true, user: u }); }

  if (path === '/api/auth/register' && method === 'POST') {
    const ipKey = [`ip:${clientIp(request)}`, LOGIN_MAX_PER_IP];
    const wait = await loginBlocked(env, [ipKey]); if (wait) return tooMany(wait);
    const b = await body(request), email = String(b.email || '').trim().toLowerCase(), displayName = String(b.displayName || '').trim().slice(0, 80), password = String(b.password || ''), invite = String(b.inviteCode || '');
    if (!env.INVITE_CODE || !safeEqual(invite, String(env.INVITE_CODE))) { await recordLoginFailure(env, [ipKey]); return json({ ok: false, error: 'Invalid invite code.' }, 403); }
    if (!validEmail(email)) return json({ ok: false, error: 'Enter a valid email address.' }, 400);
    if (!validPassword(password)) return json({ ok: false, error: 'Password must be at least 8 characters.' }, 400);
    if (await env.DB.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').bind(email).first()) return json({ ok: false, error: 'An account already exists for that email.' }, 409);
    const salt = b64(crypto.getRandomValues(new Uint8Array(16))), hash = await hashPassword(password, salt), id = crypto.randomUUID(), now = Date.now();
    await env.DB.prepare('INSERT INTO users (id,email,display_name,password_hash,password_salt,password_iterations,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, email, displayName || null, hash, salt, ITERATIONS, now, now).run();
    const token = await createSession(id, env);
    return json({ ok: true, user: { id, email, display_name: displayName || null } }, 201, { 'Set-Cookie': sessionCookie(token) });
  }

  if (path === '/api/auth/login' && method === 'POST') {
    const b = await body(request), email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
    const keys = [[`email:${email}`, LOGIN_MAX_PER_EMAIL], [`ip:${clientIp(request)}`, LOGIN_MAX_PER_IP]];
    const wait = await loginBlocked(env, keys); if (wait) return tooMany(wait);
    const u = await env.DB.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').bind(email).first();
    // Hash even when the account does not exist so response time does not reveal which emails are registered.
    const hash = await hashPassword(password, u?.password_salt || 'AAAAAAAAAAAAAAAAAAAAAA==', u?.password_iterations || ITERATIONS);
    if (!u || !safeEqual(hash, u.password_hash)) { await recordLoginFailure(env, keys); return json({ ok: false, error: 'Email or password is incorrect.' }, 401); }
    await clearLoginFailures(env, keys[0][0]);
    const token = await createSession(u.id, env);
    return json({ ok: true, user: { id: u.id, email: u.email, display_name: u.display_name } }, 200, { 'Set-Cookie': sessionCookie(token) });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const token = cookie(request, COOKIE);
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await sha256(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (path === '/api/auth/password' && method === 'POST') {
    const u = await userFor(request, env); if (!u) return json({ ok: false, error: 'Please log in.' }, 401);
    const keys = [[`pw:${u.id}`, LOGIN_MAX_PER_EMAIL]];
    const wait = await loginBlocked(env, keys); if (wait) return tooMany(wait);
    const b = await body(request), oldP = String(b.currentPassword || ''), newP = String(b.newPassword || '');
    if (!validPassword(newP)) return json({ ok: false, error: 'New password must be at least 8 characters.' }, 400);
    const full = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(u.id).first();
    const oldHash = await hashPassword(oldP, full.password_salt, full.password_iterations || ITERATIONS);
    if (!safeEqual(oldHash, full.password_hash)) { await recordLoginFailure(env, keys); return json({ ok: false, error: 'Current password is incorrect.' }, 403); }
    const salt = b64(crypto.getRandomValues(new Uint8Array(16))), hash = await hashPassword(newP, salt), now = Date.now();
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,updated_at=? WHERE id=?').bind(hash, salt, ITERATIONS, now, u.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(u.id),
    ]);
    await clearLoginFailures(env, keys[0][0]);
    const token = await createSession(u.id, env);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token) });
  }

  const u = await userFor(request, env);
  if (!u) return json({ ok: false, error: 'Please log in.' }, 401);

  // ---------------------------------------------------------------- preferences
  if (path === '/api/preferences/skin' && method === 'GET') {
    await ensureUserPreferencesSchema(env);
    const row = await env.DB.prepare('SELECT skin,updated_at FROM user_preferences WHERE user_id=?').bind(u.id).first();
    return json({ ok: true, skin: VALID_SKINS.has(String(row?.skin || '')) ? row.skin : null, updatedAt: Number(row?.updated_at) || 0 });
  }
  if (path === '/api/preferences/skin' && method === 'POST') {
    await ensureUserPreferencesSchema(env);
    const b = await body(request), skin = String(b.skin || '').trim();
    if (!VALID_SKINS.has(skin)) return json({ ok: false, error: 'Unknown skin.' }, 400);
    const now = Date.now();
    await env.DB.prepare('INSERT INTO user_preferences(user_id,skin,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET skin=excluded.skin,updated_at=excluded.updated_at').bind(u.id, skin, now).run();
    return json({ ok: true, skin, updatedAt: now });
  }

  // ---------------------------------------------------------------- SRP projects
  if (path === '/api/srp/projects' && method === 'GET') {
    await ensureSrpSchema(env);
    const rs = await env.DB.prepare('SELECT owner_user_id,project_id,legacy_user_id,name,data,updated_at,deleted,deleted_at,created_at,last_synced_at,rev FROM srp_projects WHERE owner_user_id=? ORDER BY updated_at DESC').bind(u.id).all();
    return json({ ok: true, projects: (rs.results || []).map(srpProjectFromRow) });
  }
  if (path === '/api/srp/projects' && method === 'POST') {
    await ensureSrpSchema(env);
    const b = await body(request), incoming = b.project || {}, dataObj = (incoming.data && typeof incoming.data === 'object') ? incoming.data : incoming;
    const baseRev = finiteOrNull(b.baseRev ?? b.base_rev), force = b.force === true;
    const id = String(incoming.project_id || dataObj.id || crypto.randomUUID()), name = String(incoming.name || dataObj.name || 'Untitled').trim().slice(0, 200) || 'Untitled';
    const updated = Number(incoming.updated_at || dataObj.updatedAt) || Date.now(), synced = new Date().toISOString();
    const existing = await env.DB.prepare('SELECT * FROM srp_projects WHERE owner_user_id=? AND project_id=?').bind(u.id, id).first();
    if (existing && baseRev !== null && !force && (Number(existing.rev) || 0) !== baseRev) {
      return json({ ok: false, code: existing.deleted ? 'deleted' : 'conflict', error: existing.deleted ? 'This song was deleted on another device.' : 'This song changed on another device.', project: srpProjectFromRow(existing) }, 409);
    }
    const rev = Math.max(Date.now(), (Number(existing?.rev) || 0) + 1);
    const created = existing?.created_at || new Date(Number(dataObj.createdAt) || Date.now()).toISOString();
    const clean = { ...dataObj, id, name, updatedAt: updated };
    delete clean.deleted;
    await env.DB.prepare(`INSERT INTO srp_projects(owner_user_id,project_id,legacy_user_id,name,data,updated_at,deleted,deleted_at,created_at,last_synced_at,rev)
      VALUES(?,?,?,?,?,?,0,NULL,?,?,?)
      ON CONFLICT(owner_user_id,project_id) DO UPDATE SET
        name=excluded.name,data=excluded.data,updated_at=excluded.updated_at,deleted=0,deleted_at=NULL,last_synced_at=excluded.last_synced_at,rev=excluded.rev`)
      .bind(u.id, id, existing?.legacy_user_id || null, name, JSON.stringify(clean), updated, created, synced, rev).run();
    return json({ ok: true, project_id: id, updated_at: updated, rev });
  }
  const srpProjectMatch = path.match(/^\/api\/srp\/projects\/([^/]+)$/);
  if (srpProjectMatch && method === 'DELETE') {
    await ensureSrpSchema(env);
    const id = decodeURIComponent(srpProjectMatch[1]), baseRev = finiteOrNull(url.searchParams.get('baseRev')), force = url.searchParams.get('force') === '1';
    const existing = await env.DB.prepare('SELECT * FROM srp_projects WHERE owner_user_id=? AND project_id=?').bind(u.id, id).first();
    if (!existing) return json({ ok: true, rev: 0 });
    if (baseRev !== null && !force && !existing.deleted && (Number(existing.rev) || 0) !== baseRev) {
      return json({ ok: false, code: 'conflict', error: 'This song changed on another device. Review it before deleting.', project: srpProjectFromRow(existing) }, 409);
    }
    const ts = Date.now(), deletedAt = new Date(ts).toISOString(), rev = Math.max(ts, (Number(existing.rev) || 0) + 1);
    const data = { ...parseJson(existing.data), id, deleted: true, updatedAt: ts };
    await env.DB.prepare('UPDATE srp_projects SET data=?,updated_at=?,deleted=1,deleted_at=?,last_synced_at=?,rev=? WHERE owner_user_id=? AND project_id=?').bind(JSON.stringify(data), ts, deletedAt, deletedAt, rev, u.id, id).run();
    return json({ ok: true, rev, deleted_at: deletedAt });
  }

  // ---------------------------------------------------------------- SRP media (R2)
  // Allows current Suite-owned paths plus migrated legacy paths for that project only.
  if (path === '/api/srp/media') {
    if (!env.AUDIO) return json({ ok: false, error: 'Song Rider Suite media storage is not connected.' }, 503);
    const projectId = String(url.searchParams.get('projectId') || ''), key = String(url.searchParams.get('path') || '').replace(/^\/+/, '');
    if (!projectId || !key) return json({ ok: false, error: 'projectId and path are required.' }, 400);
    const row = await srpRowFor(env, u.id, projectId);
    if (!row) return json({ ok: false, error: 'SRP project not found.' }, 404);
    if (!srpMediaAllowed(row, u.id, projectId, key)) return json({ ok: false, error: 'Media path is not authorized for this project.' }, 403);
    if (method === 'PUT') {
      if (tooLarge(request, 100 * 1024 * 1024)) return json({ ok: false, error: 'Media file is too large.' }, 413);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return json({ ok: false, error: 'Media body is empty.' }, 400);
      if (buf.byteLength > 100 * 1024 * 1024) return json({ ok: false, error: 'Media file is too large.' }, 413);
      const contentType = request.headers.get('Content-Type') || mimeForPath(key);
      await env.AUDIO.put(key, buf, { httpMetadata: { contentType }, customMetadata: { projectId, ownerUserId: u.id, uploadedAt: String(Date.now()) } });
      return json({ ok: true, size: buf.byteLength, path: key });
    }
    if (method === 'GET') {
      const obj = await env.AUDIO.get(key);
      if (!obj) return json({ ok: false, error: 'Media object not found.' }, 404);
      const headers = new Headers(); obj.writeHttpMetadata(headers);
      const existingType = String(headers.get('Content-Type') || '');
      if (!existingType || existingType === 'application/octet-stream') headers.set('Content-Type', mimeForPath(key, existingType || 'application/octet-stream'));
      headers.set('Cache-Control', 'private, max-age=0, no-store'); headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { status: 200, headers });
    }
    if (method === 'HEAD') {
      const obj = await env.AUDIO.head(key); if (!obj) return new Response(null, { status: 404 });
      return new Response(null, { status: 200, headers: { 'Content-Length': String(obj.size), 'Content-Type': mimeForPath(key) } });
    }
    if (method === 'DELETE') { await env.AUDIO.delete(key); return json({ ok: true }); }
    return json({ ok: false, error: 'Method not allowed.' }, 405);
  }

  // ---------------------------------------------------------------- lyric dictation
  // Authenticated, transient; audio is never stored.
  if (path === '/api/lyrics-dictation') {
    if (!env.AI) return json({ ok: false, error: 'Speech transcription is not connected to this Worker.' }, 503);
    if (method === 'GET') return json({ ok: true, model: TURBO_MODEL, styles: Object.keys(DICTATION_PROMPTS) });
    if (method !== 'POST') return json({ ok: false, error: 'Method not allowed.' }, 405);
    if (tooLarge(request, 700000)) return json({ ok: false, error: 'Audio segment too large.' }, 413);
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length < 44 || bytes.length > 700000) return json({ ok: false, error: 'Invalid audio segment size.' }, 413);
    const v = new DataView(bytes.buffer);
    const td = new TextDecoder();
    if (td.decode(bytes.slice(0, 4)) !== 'RIFF' || td.decode(bytes.slice(8, 12)) !== 'WAVE' || v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint32(24, true) !== 16000 || v.getUint16(34, true) !== 16 || v.getUint32(40, true) !== bytes.length - 44) {
      return json({ ok: false, error: 'Expected mono 16 kHz PCM WAV.' }, 400);
    }
    try {
      const result = await env.AI.run(TURBO_MODEL, {
        audio: bytesToBase64(bytes), language: 'en', task: 'transcribe', vad_filter: true, condition_on_previous_text: false,
        // Whisper's prompt is transcription context rather than a chat instruction; it biases spelling toward the chosen style.
        beam_size: 8,
        initial_prompt: dictationPrompt(request, url),
      });
      return json({ ok: true, text: String(result?.text || result?.transcription_info?.text || '').trim() });
    } catch (e) { console.error('Lyric dictation failed', e); return json({ ok: false, error: 'Speech transcription failed. Please retry.' }, 502); }
  }

  // ---------------------------------------------------------------- vocal take transcription
  // The browser records WAV; Workers AI transcribes the R2 master.
  const transcribeMatch = path.match(/^\/api\/transcribe\/([^/]+)$/);
  if (transcribeMatch && method === 'POST') {
    if (!env.AUDIO) return json({ ok: false, error: 'Cloud vocal storage is not connected.' }, 503);
    if (!env.AI) return json({ ok: false, error: 'Workers AI is not connected. Add a Workers AI binding named AI.' }, 503);
    const takeId = decodeURIComponent(transcribeMatch[1]), projectId = String(url.searchParams.get('projectId') || '');
    if (!projectId) return json({ ok: false, error: 'projectId is required.' }, 400);
    const owns = await env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(projectId, u.id).first();
    if (!owns) return json({ ok: false, error: 'Project not found.' }, 404);
    const key = `${u.id}/${projectId}/${takeId}.wav`, obj = await env.AUDIO.get(key);
    if (!obj) return json({ ok: false, error: 'Vocal WAV is not in cloud yet. Save the project, then try Transcribe again.' }, 404);
    if (obj.size > 25 * 1024 * 1024) return json({ ok: false, error: 'This vocal take is too large for one-pass transcription. Split it into shorter takes for now.' }, 413);
    try {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      // whisper-large-v3-turbo takes base64 audio, which is far lighter on Worker memory than the
      // number-array input the older model needed (that path ran out of memory on long takes).
      const result = await env.AI.run(TURBO_MODEL, { audio: bytesToBase64(bytes), task: 'transcribe', vad_filter: true });
      const text = String(result?.text || result?.transcription_info?.text || '').trim();
      if (!text) return json({ ok: false, error: 'No speech was detected in this take.' }, 422);
      return json({ ok: true, text, words: wordsFromWhisper(result), vtt: String(result?.vtt || result?.transcription_info?.vtt || ''), model: TURBO_MODEL });
    } catch (e) { console.error('Transcription failed', e); return json({ ok: false, error: 'Transcription failed. Please retry in a moment.' }, 502); }
  }

  // ---------------------------------------------------------------- vocal masters (R2)
  const audioMatch = path.match(/^\/api\/audio\/([^/]+)$/);
  if (audioMatch) {
    if (!env.AUDIO) return json({ ok: false, error: 'Cloud vocal storage is not connected. Bind the Song Rider Suite R2 bucket to this Worker with binding name AUDIO.' }, 503);
    const takeId = decodeURIComponent(audioMatch[1]), projectId = String(url.searchParams.get('projectId') || '');
    if (!projectId) return json({ ok: false, error: 'projectId is required.' }, 400);
    const owns = await env.DB.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').bind(projectId, u.id).first();
    if (!owns) return json({ ok: false, error: 'Project not found.' }, 404);
    const key = `${u.id}/${projectId}/${takeId}.wav`;
    if (method === 'PUT') {
      if (tooLarge(request, 100 * 1024 * 1024)) return json({ ok: false, error: 'Audio file is too large.' }, 413);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return json({ ok: false, error: 'Audio body is empty.' }, 400);
      if (buf.byteLength > 100 * 1024 * 1024) return json({ ok: false, error: 'Audio file is too large.' }, 413);
      await env.AUDIO.put(key, buf, { httpMetadata: { contentType: request.headers.get('Content-Type') || 'audio/wav' }, customMetadata: { takeId, projectId, uploadedAt: String(Date.now()) } });
      return json({ ok: true, size: buf.byteLength });
    }
    if (method === 'GET') {
      const obj = await env.AUDIO.get(key);
      if (!obj) return json({ ok: false, error: 'Audio take not found in cloud.' }, 404);
      const headers = new Headers(); obj.writeHttpMetadata(headers); headers.set('Cache-Control', 'private, max-age=0, no-store'); headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { status: 200, headers });
    }
    if (method === 'HEAD') { const obj = await env.AUDIO.head(key); return obj ? new Response(null, { status: 200, headers: { 'Content-Length': String(obj.size) } }) : new Response(null, { status: 404 }); }
    if (method === 'DELETE') { await env.AUDIO.delete(key); return json({ ok: true }); }
    return json({ ok: false, error: 'Method not allowed.' }, 405);
  }

  // ---------------------------------------------------------------- CRP projects
  if (path === '/api/projects' && method === 'GET') {
    await ensureSyncSchema(env);
    const rs = await env.DB.prepare('SELECT id,name,data,created_at,updated_at FROM projects WHERE user_id=? ORDER BY updated_at DESC').bind(u.id).all();
    const since = Date.now() - TOMBSTONE_DAYS * 86400000;
    const ts = await env.DB.prepare('SELECT project_id,deleted_at FROM project_tombstones WHERE user_id=? AND deleted_at>?').bind(u.id, since).all();
    return json({ ok: true, projects: (rs.results || []).map(crpProjectFromRow), deleted: (ts.results || []).map(t => ({ id: t.project_id, deletedAt: Number(t.deleted_at) })) });
  }
  if (path === '/api/projects' && method === 'POST') {
    await ensureSyncSchema(env);
    const b = await body(request), p = b.project || {};
    const baseRev = finiteOrNull(b.baseRev), force = b.force === true;
    const id = String(p.id || crypto.randomUUID()), name = String(p.name || 'Untitled Project').trim().slice(0, 160) || 'Untitled Project';
    const row = await env.DB.prepare('SELECT user_id,name,data,created_at,updated_at FROM projects WHERE id=?').bind(id).first();
    if (row && row.user_id !== u.id) {
      // Project ids are global; never silently drop a save that collides with another account's id.
      return json({ ok: false, code: 'id_taken', error: 'This project id belongs to a different account. Save it as a new copy.' }, 409);
    }
    if (!force && baseRev !== null) {
      if (row && (Number(row.updated_at) || 0) !== baseRev) {
        return json({ ok: false, code: 'conflict', error: 'This song changed on another device.', project: crpProjectFromRow({ id, ...row }) }, 409);
      }
      if (!row) {
        const tomb = await tombstoneFor(env, u.id, id);
        if (tomb && baseRev > 0) return json({ ok: false, code: 'deleted', error: 'This song was deleted on another device.', deletedAt: Number(tomb.deleted_at) }, 409);
      }
    }
    const now = Math.max(Date.now(), (Number(row?.updated_at) || 0) + 1);
    const clean = { ...p, id, name };
    delete clean.rev; delete clean.baseRev;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO projects(id,user_id,name,data,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,updated_at=excluded.updated_at WHERE projects.user_id=?').bind(id, u.id, name, JSON.stringify(clean), row?.created_at || now, now, u.id),
      env.DB.prepare('DELETE FROM project_tombstones WHERE user_id=? AND project_id=?').bind(u.id, id),
    ]);
    return json({ ok: true, project: { ...clean, updatedAt: now, rev: now }, rev: now });
  }
  const m = path.match(/^\/api\/projects\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (method === 'DELETE') {
      await ensureSyncSchema(env);
      const now = Date.now();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM projects WHERE id=? AND user_id=?').bind(id, u.id),
        env.DB.prepare('INSERT INTO project_tombstones(user_id,project_id,deleted_at) VALUES(?,?,?) ON CONFLICT(user_id,project_id) DO UPDATE SET deleted_at=excluded.deleted_at').bind(u.id, id, now),
      ]);
      if (env.AUDIO) {
        try {
          let cursor;
          do { const list = await env.AUDIO.list({ prefix: `${u.id}/${id}/`, cursor }); if (list.objects.length) await env.AUDIO.delete(list.objects.map(o => o.key)); cursor = list.truncated ? list.cursor : undefined; } while (cursor);
        } catch (e) { console.warn('Could not clean project audio', e); }
      }
      return json({ ok: true, deletedAt: now });
    }
    if (method === 'PATCH') {
      const b = await body(request), name = String(b.name || '').trim().slice(0, 160), baseRev = finiteOrNull(b.baseRev);
      if (!name) return json({ ok: false, error: 'Project name is required.' }, 400);
      const r = await env.DB.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').bind(id, u.id).first();
      if (!r) return json({ ok: false, error: 'Project not found.' }, 404);
      if (baseRev !== null && b.force !== true && (Number(r.updated_at) || 0) !== baseRev) return json({ ok: false, code: 'conflict', error: 'This song changed on another device.', project: crpProjectFromRow(r) }, 409);
      const d = parseJson(r.data), now = Math.max(Date.now(), (Number(r.updated_at) || 0) + 1);
      d.name = name; d.updatedAt = now;
      await env.DB.prepare('UPDATE projects SET name=?,data=?,updated_at=? WHERE id=? AND user_id=?').bind(name, JSON.stringify(d), now, id, u.id).run();
      return json({ ok: true, rev: now });
    }
  }
  return json({ ok: false, error: 'API route not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await api(request, env, url); }
      catch (e) { console.error('API error', e); return json({ ok: false, error: 'Something went wrong on the server. Please retry.' }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
