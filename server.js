import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import { MongoClient } from 'mongodb';
import { createStats } from './stats.js';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const PORT = Number(process.env.PORT || 3000);
const PANEL_USER = String(process.env.PANEL_USER || 'admin').trim();
const PANEL_PASS = String(process.env.PANEL_PASS || 'change-me');
const MAX_JSON_BYTES = process.env.MAX_JSON_BYTES || '200kb';
const MAX_LINKS_PER_JOB = Math.max(1, Number(process.env.MAX_LINKS_PER_JOB || 500));
const MAX_PERMISSION_GROUPS = Math.max(1, Number(process.env.MAX_PERMISSION_GROUPS || 500));
const PERMISSION_CONCURRENCY = Math.min(3, Math.max(1, Number(process.env.PERMISSION_CONCURRENCY || 3)));
const PERMISSION_START_GAP_MS = Math.max(100, Number(process.env.PERMISSION_START_GAP_MS || 140));
const PERMISSION_MAX_GAP_MS = Math.max(PERMISSION_START_GAP_MS, Number(process.env.PERMISSION_MAX_GAP_MS || 1800));
const PERMISSION_RETRY_BASE_MS = Math.max(400, Number(process.env.PERMISSION_RETRY_BASE_MS || 600));
const PERMISSION_MAX_ATTEMPTS = Math.max(5, Number(process.env.PERMISSION_MAX_ATTEMPTS || 7));
const PERMISSION_VERIFY_PASSES = Math.min(4, Math.max(1, Number(process.env.PERMISSION_VERIFY_PASSES || 3)));
let permissionNextAllowedAt = 0;
let permissionCooldownUntil = 0;
let permissionAdaptiveGapMs = PERMISSION_START_GAP_MS;
let permissionHealthySuccesses = 0;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A failed background request inside the WhatsApp library (for example
// "Connection Closed" while the socket reconnects) must not take the whole
// server down. Log it and keep running; the reconnect logic handles recovery.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.message || err);
});

/* =========================================================
   STORAGE
   MongoDB is preferred. Local JSON fallback is retained for
   development only. Passwords are NEVER stored in plaintext.
========================================================= */

const DATA_FILE = './data.json';
const USERS_FILE = './users.json';

let db = null;
let mongoClient = null;
let mongoConnecting = null;

async function getDb() {
  if (!process.env.MONGODB_URI) return null;
  if (db) return db;
  if (mongoConnecting) return mongoConnecting;

  mongoConnecting = (async () => {
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 10,
      minPoolSize: 1,
      maxIdleTimeMS: 60000,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000
    });

    try {
      await client.connect();
      mongoClient = client;
      db = client.db(process.env.DB_NAME || 'wa_link_organizer');
      await Promise.all([
        db.collection('users').createIndex({ usernameKey: 1 }, { unique: true }),
        db.collection('lists').createIndex({ userId: 1, name: 1 }, { unique: true }),
        db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      ]);
      return db;
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    } finally {
      mongoConnecting = null;
    }
  })();

  return mongoConnecting;
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

let appData = {
  codes: {},
  listsByUser: {}
};

async function loadData() {
  try {
    const d = await getDb();
    if (d) {
      const doc = await d.collection('data').findOne({ _id: 'appdata' });
      appData = {
        codes: doc?.codes || {},
        listsByUser: doc?.listsByUser || {}
      };
      // Legacy lists are migrated after the admin record exists.
      appData._legacyLists = Array.isArray(doc?.lists) ? doc.lists : [];
    } else {
      const j = readJson(DATA_FILE, {});
      appData = {
        codes: j.codes || {},
        listsByUser: j.listsByUser || {}
      };
      appData._legacyLists = Array.isArray(j.lists) ? j.lists : [];
    }
  } catch (e) {
    console.error('[storage] loadData:', e.message);
    appData = { codes: {}, listsByUser: {}, _legacyLists: [] };
  }
}

async function saveData() {
  const payload = {
    _id: 'appdata',
    codes: appData.codes || {},
    listsByUser: appData.listsByUser || {}
  };

  try {
    const d = await getDb();
    if (d) {
      await d.collection('data').replaceOne({ _id: 'appdata' }, payload, { upsert: true });
    } else {
      writeJsonAtomic(DATA_FILE, payload);
    }
  } catch (e) {
    console.error('[storage] saveData:', e.message);
  }
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function publicUser(u) {
  return {
    id: String(u._id),
    username: u.username,
    role: u.role,
    enabled: u.enabled !== false,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt
  };
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, derived) => err ? reject(err) : resolve(derived.toString('hex'))
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scryptHash(password, salt);
  return { passwordHash: hash, passwordSalt: salt };
}

async function verifyPassword(password, user) {
  if (!user?.passwordHash || !user?.passwordSalt) return false;
  const actual = Buffer.from(await scryptHash(password, user.passwordSalt), 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validateCredentials(username, password) {
  if (!USERNAME_RE.test(username)) {
    return 'Username must be 3-32 characters and may contain letters, numbers, dot, underscore or hyphen.';
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters.`;
  }
  return null;
}

async function findUser(username) {
  const usernameKey = normalizeUsername(username);
  const d = await getDb();

  if (d) return d.collection('users').findOne({ usernameKey });

  const users = readJson(USERS_FILE, []);
  return users.find((u) => u.usernameKey === usernameKey) || null;
}

async function listUsers() {
  const d = await getDb();
  if (d) return d.collection('users').find({ role: 'user' }).sort({ createdAt: -1 }).toArray();
  return readJson(USERS_FILE, []).filter((u) => u.role === 'user').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createUserRecord({ username, password, role = 'user' }) {
  const usernameKey = normalizeUsername(username);
  const now = new Date().toISOString();
  const creds = await hashPassword(password);
  const record = {
    _id: crypto.randomUUID(),
    username: username.trim(),
    usernameKey,
    role,
    enabled: true,
    ...creds,
    createdAt: now,
    updatedAt: now
  };

  const d = await getDb();
  if (d) {
    await d.collection('users').insertOne(record);
  } else {
    const users = readJson(USERS_FILE, []);
    users.push(record);
    writeJsonAtomic(USERS_FILE, users);
  }
  return record;
}

async function updateUser(id, update) {
  const d = await getDb();
  if (d) {
    return d.collection('users').findOneAndUpdate(
      { _id: id, role: 'user' },
      { $set: { ...update, updatedAt: new Date().toISOString() } },
      { returnDocument: 'after' }
    );
  }

  const users = readJson(USERS_FILE, []);
  const i = users.findIndex((u) => u._id === id && u.role === 'user');
  if (i < 0) return null;
  users[i] = { ...users[i], ...update, updatedAt: new Date().toISOString() };
  writeJsonAtomic(USERS_FILE, users);
  return users[i];
}

async function deleteUser(id) {
  const d = await getDb();
  if (d) {
    await d.collection('users').deleteOne({ _id: id, role: 'user' });
    await d.collection('lists').deleteMany({ userId: id });
    return;
  }

  const users = readJson(USERS_FILE, []);
  writeJsonAtomic(USERS_FILE, users.filter((u) => !(u._id === id && u.role === 'user')));
}

async function saveUserLists(userId, lists) {
  const clean = Array.isArray(lists) ? lists : [];
  const d = await getDb();

  if (d) {
    await d.collection('lists').deleteMany({ userId });
    if (clean.length) {
      await d.collection('lists').insertMany(
        clean.map((l) => ({
          userId,
          name: String(l.name),
          ids: Array.isArray(l.ids) ? l.ids : []
        }))
      );
    }
    return;
  }

  appData.listsByUser[userId] = clean;
  await saveData();
}

async function getUserLists(userId) {
  const d = await getDb();
  if (d) {
    return d.collection('lists')
      .find({ userId }, { projection: { _id: 0, userId: 0 } })
      .sort({ name: 1 })
      .toArray();
  }
  return Array.isArray(appData.listsByUser[userId]) ? appData.listsByUser[userId] : [];
}

async function ensureAdmin() {
  const existing = await findUser(PANEL_USER);

  if (!existing) {
    const admin = await createUserRecord({
      username: PANEL_USER,
      password: PANEL_PASS,
      role: 'admin'
    });
    console.log(`[auth] admin account initialized: ${admin.username}`);
    return admin;
  }

  if (existing.role !== 'admin') {
    throw new Error(`PANEL_USER "${PANEL_USER}" is already used by a normal user.`);
  }

  return existing;
}

async function migrateLegacyLists(adminId) {
  const legacy = Array.isArray(appData._legacyLists) ? appData._legacyLists : [];
  if (!legacy.length) return;

  const current = await getUserLists(adminId);
  if (!current.length) await saveUserLists(adminId, legacy);

  delete appData._legacyLists;
  if (process.env.MONGODB_URI) await saveData();
  else await saveData();
}

/* =========================================================
   WHATSAPP - ONE SHARED SOCKET
========================================================= */

let sock = null;
let state = 'starting';
let qrDataUrl = null;
let waStartPromise = null;
let reconnectTimer = null;
let reconnectDelay = 2000;

let groupCache = { at: 0, data: null };
const codeCache = new Map();
const CODE_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_WA_LINK_REQUESTS = Math.max(1, Number(process.env.MAX_WA_LINK_REQUESTS || 5));
let waLinkActive = 0;
const waLinkQueue = [];
const codeInflight = new Map();

async function withWALinkLimit(task) {
  if (waLinkActive >= MAX_WA_LINK_REQUESTS) {
    await new Promise((resolve) => waLinkQueue.push(resolve));
  }

  waLinkActive++;
  try {
    return await task();
  } finally {
    waLinkActive--;
    const next = waLinkQueue.shift();
    if (next) next();
  }
}

async function getGroups(force = false) {
  if (!sock || state !== 'connected') throw new Error('WhatsApp is not connected');
  if (!force && groupCache.data && Date.now() - groupCache.at < 10 * 60 * 1000) {
    return groupCache.data;
  }
  groupCache = { at: Date.now(), data: await sock.groupFetchAllParticipating() };
  return groupCache.data;
}

function getGroupPermissionState(g) {
  return {
    editGroupSettings: !Boolean(g.restrict),
    sendNewMessages: !Boolean(g.announce),
    addOtherMembers: Boolean(g.memberAddMode),
    approveNewMembers: Boolean(g.joinApprovalMode),
    // Baileys 6.7.24 exposes the history-sharing event type but does not
    // expose a supported group-permission setter or metadata field for it.
    sendMessageHistory: null,
    sendMessageHistorySupported: false
  };
}

function normalizePermissionChanges(input) {
  const out = {};
  const keys = ['editGroupSettings', 'sendNewMessages', 'addOtherMembers', 'approveNewMembers', 'sendMessageHistory'];

  if (!input || typeof input !== 'object') return out;

  for (const key of keys) {
    if (input[key] === undefined || input[key] === null) continue;
    if (typeof input[key] !== 'boolean') {
      throw new Error(`Invalid value for ${key}`);
    }
    if (key === 'sendMessageHistory') {
      throw new Error('Send message history is not supported by the installed Baileys version');
    }
    out[key] = input[key];
  }

  return out;
}

function isPermissionRateError(message) {
  return /rate|overlimit|429|too many|throttl/i.test(String(message || ''));
}

function isPermanentPermissionError(message) {
  return /not-authorized|forbidden|403|bad-request|invalid|not-admin|not a participant|not an admin/i.test(String(message || ''));
}

function notePermissionSuccess() {
  permissionHealthySuccesses++;
  // When WhatsApp is accepting requests cleanly, slowly return toward the
  // fast baseline instead of staying in a conservative cooldown forever.
  if (permissionHealthySuccesses >= 8) {
    permissionHealthySuccesses = 0;
    permissionAdaptiveGapMs = Math.max(
      PERMISSION_START_GAP_MS,
      Math.floor(permissionAdaptiveGapMs * 0.8)
    );
  }
}

function notePermissionRateLimit(attempt = 1) {
  permissionHealthySuccesses = 0;
  permissionAdaptiveGapMs = Math.min(
    PERMISSION_MAX_GAP_MS,
    Math.max(PERMISSION_START_GAP_MS, Math.ceil(permissionAdaptiveGapMs * 1.8))
  );
  permissionCooldownUntil = Math.max(
    permissionCooldownUntil,
    Date.now() + Math.min(12000, 1200 + attempt * 900)
  );
}

async function waitPermissionSlot() {
  while (true) {
    const now = Date.now();
    const target = Math.max(permissionNextAllowedAt, permissionCooldownUntil);
    const wait = target - now;
    if (wait > 0) await sleep(wait);
    const after = Date.now();
    if (after >= permissionNextAllowedAt && after >= permissionCooldownUntil) {
      permissionNextAllowedAt = after + permissionAdaptiveGapMs;
      return;
    }
  }
}

async function runPermissionOperation(operation) {
  let lastError = null;

  for (let attempt = 1; attempt <= PERMISSION_MAX_ATTEMPTS; attempt++) {
    try {
      await waitPermissionSlot();
      const result = await withWALinkLimit(operation);
      notePermissionSuccess();
      return result;
    } catch (e) {
      lastError = e;
      const message = errText(e);
      if (isPermanentPermissionError(message)) break;

      const rateLimited = isPermissionRateError(message);
      if (rateLimited) notePermissionRateLimit(attempt);

      if (attempt === PERMISSION_MAX_ATTEMPTS) break;

      const delay = rateLimited
        ? Math.min(14000, PERMISSION_RETRY_BASE_MS * (attempt + 1) * 2)
        : Math.min(7000, PERMISSION_RETRY_BASE_MS * attempt);
      await sleep(delay);
    }
  }

  throw lastError || new Error('Permission update failed');
}

async function applyGroupPermissionChanges(jid, changes) {
  const applied = [];
  const failed = [];

  const operations = [
    ['editGroupSettings', () => sock.groupSettingUpdate(
      jid,
      changes.editGroupSettings ? 'unlocked' : 'locked'
    )],
    ['sendNewMessages', () => sock.groupSettingUpdate(
      jid,
      changes.sendNewMessages ? 'not_announcement' : 'announcement'
    )],
    ['addOtherMembers', () => sock.groupMemberAddMode(
      jid,
      changes.addOtherMembers ? 'all_member_add' : 'admin_add'
    )],
    ['approveNewMembers', () => sock.groupJoinApprovalMode(
      jid,
      changes.approveNewMembers ? 'on' : 'off'
    )]
  ];

  for (const [key, operation] of operations) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
    try {
      await runPermissionOperation(operation);
      applied.push(key);
    } catch (e) {
      failed.push({ key, error: errText(e) });
    }
  }

  if (failed.length) {
    const e = new Error(failed.map((x) => `${x.key}: ${x.error}`).join(' | '));
    e.permissionApplied = applied.slice();
    e.permissionFailed = failed;
    throw e;
  }

  return applied;
}

function permissionMismatch(g, changes) {
  if (!g) return Object.keys(changes);
  const current = getGroupPermissionState(g);
  return Object.entries(changes)
    .filter(([key, value]) => current[key] !== value)
    .map(([key]) => key);
}

async function verifyPermissionJob(job, ids, changes) {
  let all = await getGroups(true);
  let remaining = [];

  for (let pass = 1; pass <= PERMISSION_VERIFY_PASSES; pass++) {
    remaining = ids.filter((id) => permissionMismatch(all[id], changes).length > 0);
    job.verifyPass = pass;
    job.remaining = remaining.length;
    job.updated = Date.now();
    if (!remaining.length) return { all, remaining: [] };
    if (pass === PERMISSION_VERIFY_PASSES) break;

    // Only retry groups that are actually still out of sync. This avoids
    // re-sending successful mutations and is much cheaper than retrying the
    // entire batch blindly.
    for (const id of remaining) {
      const g = all[id];
      const pendingKeys = permissionMismatch(g, changes);
      if (!pendingKeys.length) continue;
      const retryChanges = Object.fromEntries(
        pendingKeys.map((key) => [key, changes[key]])
      );
      try {
        await applyGroupPermissionChanges(id, retryChanges);
      } catch {
        // The next verification pass decides whether anything remains.
      }
    }
    all = await getGroups(true);
  }

  return { all, remaining };
}

const stats = createStats({
  getDb,
  getSock: () => (state === 'connected' ? sock : null),
  getGroupCache: () => groupCache,
  withLimit: withWALinkLimit,
  sleep,
  refreshGroups: () => getGroups(true)
});

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleWAReconnect() {
  if (state === 'closed' || reconnectTimer || waStartPromise) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startWA().catch((e) => {
      console.error('[wa] reconnect failed:', e.message);
      scheduleWAReconnect();
    });
  }, delay);
}

async function clearWAAuth() {
  const d = await getDb();
  if (d) await d.collection('auth').deleteMany({});
  else fs.rmSync('./auth', { recursive: true, force: true });
}

async function useMongoAuthState(col) {
  const { initAuthCreds, proto, BufferJSON } = await import('@whiskeysockets/baileys');

  async function read(key, type) {
    const doc = await col.findOne({ _id: `${type}-${key}` });
    if (!doc) return null;
    return JSON.parse(doc.value, BufferJSON.reviver);
  }

  async function write(key, type, value) {
    const valueString = JSON.stringify(value, BufferJSON.replacer);
    await col.updateOne(
      { _id: `${type}-${key}` },
      { $set: { value: valueString } },
      { upsert: true }
    );
  }

  const credsDoc = await col.findOne({ _id: 'creds' });
  const creds = credsDoc
    ? JSON.parse(credsDoc.value, BufferJSON.reviver)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          await Promise.all(ids.map(async (id) => {
            let value = await read(id, type);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            result[id] = value;
          }));
          return result;
        },
        set: async (data) => {
          await Promise.all(
            Object.entries(data).flatMap(([type, entries]) =>
              Object.entries(entries).map(([id, value]) =>
                value == null
                  ? col.deleteOne({ _id: `${type}-${id}` })
                  : write(id, type, value)
              )
            )
          );
        }
      }
    },
    saveCreds: async () => {
      await col.updateOne(
        { _id: 'creds' },
        { $set: { value: JSON.stringify(creds, BufferJSON.replacer) } },
        { upsert: true }
      );
    }
  };
}

async function startWA() {
  if (waStartPromise) return waStartPromise;
  clearReconnectTimer();

  waStartPromise = (async () => {
    state = 'starting';
    qrDataUrl = null;

    const d = await getDb();
    const auth = d
      ? await useMongoAuthState(d.collection('auth'))
      : await useMultiFileAuthState('./auth');

    const { version } = await fetchLatestBaileysVersion();
    const currentSocket = makeWASocket({
      version,
      auth: auth.state,
      logger: pino({ level: 'silent' }),
      browser: ['Link Organizer', 'Chrome', '1.0']
    });

    sock = currentSocket;
    currentSocket.ev.on('creds.update', auth.saveCreds);
    stats.attach(currentSocket);

    currentSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (sock !== currentSocket) return;

      if (qr) {
        state = 'qr';
        qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
      }

      if (connection === 'open') {
        state = 'connected';
        qrDataUrl = null;
        reconnectDelay = 2000;
        groupCache = { at: 0, data: null };
        getGroups(true)
          .then(() => stats.onOpen())
          .catch((e) => console.log('[wa] group preload:', e.message));
      }

      if (connection === 'close') {
        if (sock === currentSocket) sock = null;
        groupCache = { at: 0, data: null };
        codeCache.clear();

        const code = lastDisconnect?.error?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          state = 'closed';
          qrDataUrl = null;
          await clearWAAuth();
          reconnectDelay = 2000;
          startWA().catch((e) => console.error('[wa] fresh QR start:', e.message));
        } else {
          state = 'starting';
          qrDataUrl = null;
          scheduleWAReconnect();
        }
      }
    });
  })();

  try {
    return await waStartPromise;
  } catch (e) {
    state = 'starting';
    sock = null;
    scheduleWAReconnect();
    throw e;
  } finally {
    waStartPromise = null;
  }
}

/* =========================================================
   AUTH / SESSIONS
========================================================= */

const sessions = new Map();
const loginAttempts = new Map();

function cleanupAuth() {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(sid);
  }
  for (const [key, entry] of loginAttempts) {
    if (entry.resetAt <= now) loginAttempts.delete(key);
  }
}

function getCookie(req, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function clientKey(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket.remoteAddress || 'unknown';
}

function attemptKey(req, username) {
  return `${clientKey(req)}:${normalizeUsername(username)}`;
}

function loginAllowed(req, username) {
  cleanupAuth();
  const entry = loginAttempts.get(attemptKey(req, username));
  return !entry || entry.resetAt <= Date.now() || entry.count < LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(req, username) {
  const key = attemptKey(req, username);
  const now = Date.now();
  const entry = loginAttempts.get(key);

  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearLoginFailures(req, username) {
  loginAttempts.delete(attemptKey(req, username));
}

function createSession(user) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, {
    userId: String(user._id),
    username: user.username,
    role: user.role,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return sid;
}

function setSessionCookie(req, res, sid) {
  const secure =
    process.env.NODE_ENV === 'production' ||
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https';

  res.setHeader(
    'Set-Cookie',
    `sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
}

function currentSession(req) {
  cleanupAuth();
  const sid = getCookie(req, 'sid');
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session || session.expiresAt <= Date.now()) return null;
  return { sid, ...session };
}

function requireAuth(req, res, next) {
  const session = currentSession(req);
  if (!session) return res.status(401).json({ error: 'Login required' });
  req.user = session;
  next();
}

function requireAdmin(req, res, next) {
  const session = currentSession(req);
  if (!session) return res.status(401).json({ error: 'Login required' });
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  req.user = session;
  next();
}

const needWA = (req, res, next) =>
  state === 'connected'
    ? next()
    : res.status(400).json({ error: 'WhatsApp is not connected' });

/* =========================================================
   APP
========================================================= */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: MAX_JSON_BYTES }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

/* ---------- Login ---------- */
app.post('/api/login', async (req, res) => {
  const user = String(req.body?.user || '').trim();
  const pass = String(req.body?.pass || '');

  if (!loginAllowed(req, user)) {
    return res.status(429).json({
      error: 'Too many login attempts. Please wait 15 minutes.'
    });
  }

  try {
    /*
     * ADMIN LOGIN
     * Admin credentials come directly from .env.
     * MongoDB admin document is NOT required for login.
     */
    if (
      normalizeUsername(user) === normalizeUsername(PANEL_USER) &&
      pass === PANEL_PASS
    ) {
      clearLoginFailures(req, user);

      const sid = crypto.randomBytes(32).toString('hex');

      sessions.set(sid, {
        userId: 'admin',
        username: PANEL_USER,
        role: 'admin',
        expiresAt: Date.now() + SESSION_TTL_MS
      });

      setSessionCookie(req, res, sid);

      return res.json({
        ok: true,
        user: {
          id: 'admin',
          username: PANEL_USER,
          role: 'admin'
        }
      });
    }

    /*
     * NORMAL USER LOGIN
     * Normal users continue to authenticate against MongoDB/local users.json.
     */
    const record = await findUser(user);
    const valid =
      record &&
      record.role === 'user' &&
      record.enabled !== false &&
      await verifyPassword(pass, record);

    if (!valid) {
      recordLoginFailure(req, user);
      return res.status(401).json({
        error: 'Incorrect username or password'
      });
    }

    clearLoginFailures(req, user);

    const sid = createSession(record);
    setSessionCookie(req, res, sid);

    return res.json({
      ok: true,
      user: publicUser(record)
    });

  } catch (e) {
    console.error('[auth] login:', e.message);
    return res.status(500).json({
      error: 'Login service temporarily unavailable'
    });
  }
});


app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.user.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const session = currentSession(req);
  if (!session) return res.json({ loggedIn: false });
  res.json({
    loggedIn: true,
    user: {
      id: session.userId,
      username: session.username,
      role: session.role
    }
  });
});

/* ---------- Admin API ---------- */

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await listUsers();
    res.json({ users: users.map(publicUser) });
  } catch (e) {
    res.status(500).json({ error: 'Could not load users' });
  }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const validation = validateCredentials(username, password);

  if (validation) return res.status(400).json({ error: validation });

  try {
    if (await findUser(username)) {
      return res.status(409).json({ error: 'That username is already in use.' });
    }

    const user = await createUserRecord({ username, password });
    res.status(201).json({ user: publicUser(user) });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ error: 'That username is already in use.' });
    console.error('[admin] create user:', e.message);
    res.status(500).json({ error: 'Could not create user' });
  }
});

app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const enabled = req.body?.enabled;

  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }

  try {
    const user = await updateUser(id, { enabled });
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!enabled) {
      for (const [sid, session] of sessions) {
        if (session.userId === id) sessions.delete(sid);
      }
    }

    res.json({ user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Could not update user' });
  }
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return res.status(400).json({ error: `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters.` });
  }

  try {
    const creds = await hashPassword(password);
    const user = await updateUser(String(req.params.id), creds);
    if (!user) return res.status(404).json({ error: 'User not found' });

    for (const [sid, session] of sessions) {
      if (session.userId === String(req.params.id)) sessions.delete(sid);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not reset password' });
  }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = String(req.params.id);

  try {
    const users = await listUsers();
    const target = users.find((u) => String(u._id) === id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    await deleteUser(id);
    for (const [sid, session] of sessions) {
      if (session.userId === id) sessions.delete(sid);
    }

    if (!process.env.MONGODB_URI) {
      delete appData.listsByUser[id];
      await saveData();
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not delete user' });
  }
});

/* ---------- WhatsApp status ---------- */

app.get('/api/status', requireAuth, (req, res) => {
  res.json({
    state,
    qr: qrDataUrl,
    canDisconnect: req.user.role === 'admin'
  });
});

/* ---------- Groups ---------- */

app.get('/api/groups', requireAuth, needWA, async (req, res) => {
  try {
    const all = await getGroups(req.query.refresh === '1');
    const groups = Object.values(all)
      .map((g) => {
        const name = (g.subject || '').trim();
        const m = name.match(/(\d+)\s*$/);
        return {
          id: g.id,
          name,
          num: m ? parseInt(m[1], 10) : Infinity,
          size: g.size ?? g.participants?.length ?? 0
        };
      })
      .sort((a, b) => (a.num - b.num) || a.name.localeCompare(b.name));

    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: 'Could not load groups: ' + e.message });
  }
});

/* ---------- Group permissions ---------- */

const permissionJobs = new Map();

function permissionJobPublic(job) {
  return {
    id: job.id,
    state: job.state,
    total: job.total,
    done: job.done,
    updated: job.updated,
    phase: job.phase || 'running',
    remaining: job.remaining ?? 0,
    results: job.results,
    error: job.error || null
  };
}

async function runPermissionJob(job, ids, changes, all) {
  job.state = 'running';
  job.phase = 'applying';
  job.updated = Date.now();
  job.results = ids.map((id) => ({
    id,
    name: (all[id]?.subject || id).trim(),
    ok: false,
    applied: [],
    failedPermissions: [],
    error: null
  }));

  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= ids.length) return;
      const id = ids[index];
      const item = job.results[index];
      const g = all[id];

      if (!g) {
        item.error = 'Group not found';
        job.done++;
        job.updated = Date.now();
        continue;
      }

      try {
        item.applied = await applyGroupPermissionChanges(id, changes);
      } catch (e) {
        item.applied = Array.isArray(e.permissionApplied) ? e.permissionApplied : [];
        item.failedPermissions = Array.isArray(e.permissionFailed) ? e.permissionFailed : [];
        item.error = errText(e);
      }

      job.done++;
      job.updated = Date.now();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PERMISSION_CONCURRENCY, ids.length) }, () => worker())
  );

  // One/few verification passes turn this into a real "eventual completion"
  // workflow: only groups whose WhatsApp state is still different are retried.
  // This is much safer than blindly repeating every mutation.
  job.phase = 'verifying';
  job.updated = Date.now();
  const verification = await verifyPermissionJob(job, ids, changes);
  const verifiedAll = verification.all;

  for (const item of job.results) {
    const g = verifiedAll[item.id];
    const mismatches = permissionMismatch(g, changes);
    if (!mismatches.length) {
      item.ok = true;
      item.error = null;
      item.failedPermissions = [];
    } else {
      item.ok = false;
      item.failedPermissions = mismatches.map((key) => ({
        key,
        error: item.error || 'Permission did not reach the requested state'
      }));
      item.error = item.failedPermissions.map((x) => `${x.key}: ${x.error}`).join(' | ');
    }
  }

  job.phase = 'done';
  job.state = 'done';
  job.done = job.total;
  job.updated = Date.now();
}

app.get('/api/group-permissions', requireAdmin, needWA, async (req, res) => {
  try {
    const all = await getGroups(req.query.refresh === '1');
    const groups = Object.values(all)
      .map((g) => {
        const name = (g.subject || '').trim();
        const m = name.match(/(\d+)\s*$/);
        return {
          id: g.id,
          name,
          num: m ? parseInt(m[1], 10) : Infinity,
          size: g.size ?? g.participants?.length ?? 0,
          permissions: getGroupPermissionState(g)
        };
      })
      .sort((a, b) => (a.num - b.num) || a.name.localeCompare(b.name));

    res.json({
      groups,
      maxGroups: MAX_PERMISSION_GROUPS,
      capabilities: {
        sendMessageHistory: false
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not load group permissions: ' + e.message });
  }
});

app.post('/api/group-permissions', requireAdmin, needWA, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
      : [];

    if (!ids.length) return res.status(400).json({ error: 'No groups selected' });
    if (ids.length > MAX_PERMISSION_GROUPS) {
      return res.status(400).json({ error: `Please select no more than ${MAX_PERMISSION_GROUPS} groups at once.` });
    }

    const changes = normalizePermissionChanges(req.body?.changes);
    if (!Object.keys(changes).length) {
      return res.status(400).json({ error: 'No supported permission changes were requested' });
    }

    const all = await getGroups();
    const job = {
      id: crypto.randomUUID(),
      state: 'queued',
      total: ids.length,
      done: 0,
      updated: Date.now(),
      results: [],
      error: null
    };

    permissionJobs.set(job.id, job);
    if (permissionJobs.size > 30) {
      const first = permissionJobs.keys().next().value;
      if (first) permissionJobs.delete(first);
    }

    runPermissionJob(job, ids, changes, all).catch((e) => {
      job.state = 'error';
      job.error = e.message;
      job.updated = Date.now();
    });

    res.json({ ok: true, job: permissionJobPublic(job) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not start permission update' });
  }
});

app.get('/api/group-permission-job/:id', requireAdmin, (req, res) => {
  const job = permissionJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Permission job not found' });
  res.json(permissionJobPublic(job));
});

/* ---------- Link jobs ---------- */

const errText = (e) => String(e?.message || e?.data || e || 'unknown error');
const isAdminErr = (m) => /not-authorized|forbidden|403/i.test(m);
const isRateErr = (m) => /rate|overlimit|429/i.test(m);
const jobs = new Map();

async function tryCode(it, fresh = false) {
  if (!fresh) {
    const cached = codeInflight.has(it.id)
      ? await codeInflight.get(it.id)
      : null;
    if (cached?.code) return cached;

    const local = codeCache.get(it.id);
    if (local && Date.now() - local.at < CODE_CACHE_TTL_MS) return { code: local.code };
    if (appData.codes[it.id]) return { code: appData.codes[it.id] };
  }

  if (codeInflight.has(it.id)) return codeInflight.get(it.id);

  const promise = withWALinkLimit(async () => {
    try {
      if (!sock || state !== 'connected') {
        return { err: 'WhatsApp is not connected', kind: 'other' };
      }

      const code = await sock.groupInviteCode(it.id);
      if (code) {
        codeCache.set(it.id, { code, at: Date.now() });
        return { code };
      }
      return { err: 'empty response from WhatsApp', kind: 'other' };
    } catch (e) {
      const m = errText(e);
      return { err: m, kind: isAdminErr(m) ? 'admin' : isRateErr(m) ? 'rate' : 'other' };
    }
  });

  codeInflight.set(it.id, promise);
  try {
    return await promise;
  } finally {
    codeInflight.delete(it.id);
  }
}

const ok = (it, code) => ({
  id: it.id,
  n: it.num,
  name: it.name,
  link: `https://chat.whatsapp.com/${code}`
});

const bad = (it, note) => ({
  id: it.id,
  n: it.num,
  name: it.name,
  link: null,
  note
});

async function runJob(job, items, fresh) {
  const out = job.results;
  const codes = appData.codes;
  const todo = [];

  items.forEach((it, i) => {
    if (!it.id) {
      out[i] = bad(it, 'Group not found');
      job.done++;
    } else if (!fresh && codes[it.id]) {
      out[i] = ok(it, codes[it.id]);
      job.done++;
    } else {
      todo.push(i);
    }
  });

  const retry = [];

  for (let s = 0; s < todo.length; s += 5) {
    await Promise.all(todo.slice(s, s + 5).map(async (i) => {
      const it = items[i];
      const r = await tryCode(it, fresh);

      if (r.code) {
        codes[it.id] = r.code;
        out[i] = ok(it, r.code);
        job.done++;
      } else if (r.kind === 'admin') {
        out[i] = bad(it, 'You are not an admin of this group');
        job.done++;
      } else {
        retry.push(i);
      }
    }));

    if (s + 5 < todo.length) await sleep(250);
  }

  retry.sort((x, y) => x - y);

  for (const i of retry) {
    const it = items[i];
    let r = null;

    for (let a = 1; a <= 4; a++) {
      await sleep(1200 * a);
      r = await tryCode(it, fresh);
      if (r.code || r.kind === 'admin') break;
    }

    if (r.code) {
      codes[it.id] = r.code;
      out[i] = ok(it, r.code);
    } else if (r.kind === 'admin') {
      out[i] = bad(it, 'You are not an admin of this group');
    } else if (r.kind === 'rate') {
      out[i] = bad(it, 'WhatsApp is rate limiting requests right now. Wait 1-2 minutes, then retry failed groups');
    } else {
      out[i] = bad(it, `Could not get link (${r.err})`);
    }

    job.done++;
  }

  await saveData();
}

app.post('/api/links', requireAuth, needWA, async (req, res) => {
  const { prefix = '', from, to, ids, fresh } = req.body || {};

  try {
    const all = await getGroups();
    let items = [];

    if (Array.isArray(ids)) {
      if (!ids.length) return res.status(400).json({ error: 'No groups selected' });
      if (ids.length > MAX_LINKS_PER_JOB) {
        return res.status(400).json({ error: `Please select no more than ${MAX_LINKS_PER_JOB} groups at once.` });
      }

      items = ids.map((id) => all[id]
        ? {
            id,
            name: (all[id].subject || '').trim(),
            num: Number((all[id].subject || '').match(/(\d+)\s*$/)?.[1] ?? Infinity)
          }
        : { id: null, name: 'Group no longer available', num: Infinity }
      ).sort((a, b) => (a.num - b.num) || a.name.localeCompare(b.name));
    } else {
      const a = parseInt(from, 10);
      const b = parseInt(to, 10);
      const p = String(prefix).trim();

      if (!p || Number.isNaN(a) || Number.isNaN(b) || a > b) {
        return res.status(400).json({ error: 'Enter a valid prefix and number range' });
      }

      if (b - a + 1 > MAX_LINKS_PER_JOB) {
        return res.status(400).json({ error: `Please request no more than ${MAX_LINKS_PER_JOB} groups at once.` });
      }

      const wanted = new Map();

      for (const g of Object.values(all)) {
        const name = (g.subject || '').trim();
        if (!name.startsWith(p)) continue;

        const rest = name.slice(p.length).trim();
        if (!/^\d+$/.test(rest)) continue;

        const n = parseInt(rest, 10);
        if (n >= a && n <= b) wanted.set(n, { id: g.id, name, num: n });
      }

      for (let n = a; n <= b; n++) {
        items.push(wanted.get(n) || { id: null, name: `${p}${n}`, num: n });
      }
    }

    // A job is owned by exactly one authenticated user.
    const job = {
      id: crypto.randomBytes(12).toString('hex'),
      userId: req.user.userId,
      total: items.length,
      done: 0,
      results: [],
      finished: false,
      error: null,
      createdAt: Date.now()
    };

    jobs.set(job.id, job);

    setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000).unref?.();

    runJob(job, items, !!fresh)
      .catch((e) => { job.error = 'Could not fetch links: ' + e.message; })
      .finally(() => { job.finished = true; });

    res.json({ jobId: job.id });
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch links: ' + e.message });
  }
});

app.get('/api/job/:id', requireAuth, (req, res) => {
  const job = jobs.get(req.params.id);

  // Never reveal whether another user's job exists.
  if (!job || job.userId !== req.user.userId) {
    return res.status(404).json({ error: 'Job not found, please try again' });
  }

  res.json({
    done: job.done,
    total: job.total,
    finished: job.finished,
    error: job.error,
    results: job.results.filter(Boolean)
  });
});

/* ---------- Per-user saved lists ---------- */

app.get('/api/lists', requireAuth, async (req, res) => {
  try {
    res.json({ lists: await getUserLists(req.user.userId) });
  } catch (e) {
    res.status(500).json({ error: 'Could not load saved lists' });
  }
});

app.post('/api/lists', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];

  if (!name || name.length > 80 || !ids.length) {
    return res.status(400).json({ error: 'A valid list name and at least one group are required' });
  }

  const lists = await getUserLists(req.user.userId);
  const i = lists.findIndex((l) => l.name === name);

  if (i >= 0) lists[i].ids = ids;
  else lists.push({ name, ids });

  await saveUserLists(req.user.userId, lists);
  res.json({ lists });
});

app.post('/api/lists/rename', requireAuth, async (req, res) => {
  const from = String(req.body?.from || '');
  const to = String(req.body?.to || '').trim();

  if (!to || to.length > 80) return res.status(400).json({ error: 'Enter a valid new name' });

  const lists = await getUserLists(req.user.userId);

  if (lists.some((l) => l.name === to)) {
    return res.status(400).json({ error: 'A list with this name already exists' });
  }

  const l = lists.find((x) => x.name === from);
  if (l) l.name = to;

  await saveUserLists(req.user.userId, lists);
  res.json({ lists });
});

app.post('/api/lists/delete', requireAuth, async (req, res) => {
  const name = String(req.body?.name || '');
  const lists = (await getUserLists(req.user.userId)).filter((l) => l.name !== name);

  await saveUserLists(req.user.userId, lists);
  res.json({ lists });
});

/* ---------- WhatsApp disconnect: ADMIN ONLY ---------- */

app.post('/api/logout-wa', requireAdmin, async (req, res) => {
  try {
    clearReconnectTimer();

    const current = sock;
    sock = null;
    state = 'closed';
    qrDataUrl = null;
    groupCache = { at: 0, data: null };
    codeCache.clear();

    if (current) {
      try { await current.logout(); } catch {}
    }

    await clearWAAuth();
    reconnectDelay = 2000;
    startWA().catch((e) => console.error('[wa] manual reconnect:', e.message));

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not disconnect WhatsApp: ' + e.message });
  }
});

/* ---------- Live group stats ---------- */

stats.routes(app, requireAuth, needWA);

/* ---------- Static files ---------- */

app.use(express.static('public'));

await loadData();
await stats.load();
const admin = await ensureAdmin();
await migrateLegacyLists(String(admin._id));

startWA().catch((e) => console.error('[startup] WhatsApp:', e.message));

const sessionCleanupTimer = setInterval(cleanupAuth, 10 * 60 * 1000);
sessionCleanupTimer.unref?.();

const server = app.listen(PORT, () => {
  console.log(`Group Link Organizer running on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  clearReconnectTimer();
  clearInterval(sessionCleanupTimer);
  server.close();

  try { if (sock) sock.end(undefined); } catch {}
  try { await stats.flush(); } catch {}
  try { if (mongoClient) await mongoClient.close(); } catch {}

  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));