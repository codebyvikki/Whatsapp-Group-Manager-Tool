import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import { MongoClient } from 'mongodb';
import { createStats, registerStatsRoutes } from './stats.js';
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
const PERMISSION_VERIFY_PASSES = Math.min(2, Math.max(1, Number(process.env.PERMISSION_VERIFY_PASSES || 2)));
const PERMISSION_GLOBAL_CONCURRENCY = Math.min(3, Math.max(1, Number(process.env.PERMISSION_GLOBAL_CONCURRENCY || 3)));
let permissionNextAllowedAt = 0;
let permissionCooldownUntil = 0;
let permissionAdaptiveGapMs = PERMISSION_START_GAP_MS;
let permissionHealthySuccesses = 0;
let permissionQueueActive = 0;
const permissionQueue = [];

function pumpPermissionQueue() {
  while (permissionQueueActive < PERMISSION_GLOBAL_CONCURRENCY && permissionQueue.length) {
    const item = permissionQueue.shift();
    permissionQueueActive++;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        permissionQueueActive--;
        pumpPermissionQueue();
      });
  }
}

function withPermissionConcurrency(task) {
  return new Promise((resolve, reject) => {
    permissionQueue.push({ task, resolve, reject });
    pumpPermissionQueue();
  });
}

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
  codesByUser: {},
  listsByUser: {}
};

async function loadData() {
  try {
    const d = await getDb();
    if (d) {
      const doc = await d.collection('data').findOne({ _id: 'appdata' });
      appData = {
        codes: doc?.codes || {},
        codesByUser: doc?.codesByUser || {},
        listsByUser: doc?.listsByUser || {}
      };
      // Legacy lists are migrated after the admin record exists.
      appData._legacyLists = Array.isArray(doc?.lists) ? doc.lists : [];
    } else {
      const j = readJson(DATA_FILE, {});
      appData = {
        codes: j.codes || {},
        codesByUser: j.codesByUser || {},
        listsByUser: j.listsByUser || {}
      };
      appData._legacyLists = Array.isArray(j.lists) ? j.lists : [];
    }
  } catch (e) {
    console.error('[storage] loadData:', e.message);
    appData = { codes: {}, codesByUser: {}, listsByUser: {}, _legacyLists: [] };
  }
}

async function saveData() {
  const payload = {
    _id: 'appdata',
    codes: appData.codes || {},
    codesByUser: appData.codesByUser || {},
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
   WHATSAPP - ONE PERSISTENT SOCKET PER PANEL USER
   Each authenticated user gets an isolated Baileys session,
   group cache, QR state and stats tracker.
========================================================= */

const waSessions = new Map();

function userAuthPath(userId) {
  const safe = String(userId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
  return `./auth/${safe}`;
}

function createWAContext(userId) {
  const wa = {
    userId: String(userId),
    sock: null,
    state: 'starting',
    qrDataUrl: null,
    startPromise: null,
    reconnectTimer: null,
    reconnectDelay: 2000,
    groupCache: { at: 0, data: null },
    codeCache: new Map(),
    codeInflight: new Map(),
    linkActive: 0,
    linkQueue: [],
    stats: null,
    statsLoaded: false,
    statsAttached: false
  };

  wa.stats = createStats({
    getDb,
    ownerId: wa.userId,
    getSock: () => (wa.state === 'connected' ? wa.sock : null),
    getGroupCache: () => wa.groupCache,
    withLimit: (task) => withWALinkLimit(wa, task),
    sleep,
    refreshGroups: () => getGroups(wa, true)
  });

  return wa;
}

function getWA(userId) {
  const key = String(userId);
  let wa = waSessions.get(key);
  if (!wa) {
    wa = createWAContext(key);
    waSessions.set(key, wa);
  }
  return wa;
}

function withWALinkLimit(wa, task) {
  const max = Math.max(8, Number(process.env.MAX_WA_LINK_REQUESTS || 8));
  return new Promise((resolve, reject) => {
    wa.linkQueue.push({ task, resolve, reject, max });
    const pump = () => {
      while (wa.linkActive < max && wa.linkQueue.length) {
        const item = wa.linkQueue.shift();
        wa.linkActive++;
        Promise.resolve()
          .then(item.task)
          .then(item.resolve, item.reject)
          .finally(() => {
            wa.linkActive--;
            pump();
          });
      }
    };
    pump();
  });
}

async function getGroups(wa, force = false) {
  if (!wa?.sock || wa.state !== 'connected') throw new Error('WhatsApp is not connected');
  if (!force && wa.groupCache.data && Date.now() - wa.groupCache.at < 10 * 60 * 1000) {
    return wa.groupCache.data;
  }
  wa.groupCache = { at: Date.now(), data: await wa.sock.groupFetchAllParticipating() };
  return wa.groupCache.data;
}

function getGroupPermissionState(g) {
  return {
    editGroupSettings: !Boolean(g.restrict),
    sendNewMessages: !Boolean(g.announce),
    addOtherMembers: Boolean(g.memberAddMode),
    approveNewMembers: Boolean(g.joinApprovalMode),
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
    if (typeof input[key] !== 'boolean') throw new Error(`Invalid value for ${key}`);
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

async function runPermissionOperation(wa, operation) {
  let lastError = null;
  for (let attempt = 1; attempt <= PERMISSION_MAX_ATTEMPTS; attempt++) {
    try {
      await waitPermissionSlot();
      return await withPermissionConcurrency(() => withWALinkLimit(wa, operation));
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

async function applyGroupPermissionChanges(wa, jid, changes) {
  const applied = [];
  const failed = [];
  const operations = [
    ['editGroupSettings', () => wa.sock.groupSettingUpdate(jid, changes.editGroupSettings ? 'unlocked' : 'locked')],
    ['sendNewMessages', () => wa.sock.groupSettingUpdate(jid, changes.sendNewMessages ? 'not_announcement' : 'announcement')],
    ['addOtherMembers', () => wa.sock.groupMemberAddMode(jid, changes.addOtherMembers ? 'all_member_add' : 'admin_add')],
    ['approveNewMembers', () => wa.sock.groupJoinApprovalMode(jid, changes.approveNewMembers ? 'on' : 'off')]
  ];

  for (const [key, operation] of operations) {
    if (!Object.prototype.hasOwnProperty.call(changes, key)) continue;
    try {
      await runPermissionOperation(wa, operation);
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
  return Object.entries(changes).filter(([key, value]) => current[key] !== value).map(([key]) => key);
}

function changesNeededForGroup(g, changes) {
  return Object.fromEntries(permissionMismatch(g, changes).map((key) => [key, changes[key]]));
}

async function verifyPermissionJob(wa, job, ids, changes) {
  let all = await getGroups(wa, true);
  let remaining = ids.filter((id) => permissionMismatch(all[id], changes).length > 0);
  job.verifyPass = 1;
  job.remaining = remaining.length;
  job.updated = Date.now();

  if (!remaining.length || PERMISSION_VERIFY_PASSES < 2) return { all, remaining };

  job.phase = 'retrying';
  for (const id of remaining) {
    const retryChanges = changesNeededForGroup(all[id], changes);
    if (!Object.keys(retryChanges).length) continue;
    try { await applyGroupPermissionChanges(wa, id, retryChanges); } catch {}
  }

  job.phase = 'verifying';
  all = await getGroups(wa, true);
  remaining = ids.filter((id) => permissionMismatch(all[id], changes).length > 0);
  job.verifyPass = 2;
  job.remaining = remaining.length;
  job.updated = Date.now();
  return { all, remaining };
}

function clearReconnectTimer(wa) {
  if (wa.reconnectTimer) {
    clearTimeout(wa.reconnectTimer);
    wa.reconnectTimer = null;
  }
}

function scheduleWAReconnect(wa) {
  if (wa.state === 'closed' || wa.reconnectTimer || wa.startPromise) return;
  const delay = wa.reconnectDelay;
  wa.reconnectDelay = Math.min(wa.reconnectDelay * 2, 30000);

  wa.reconnectTimer = setTimeout(() => {
    wa.reconnectTimer = null;
    startWA(wa.userId).catch((e) => {
      console.error(`[wa:${wa.userId}] reconnect failed:`, e.message);
      scheduleWAReconnect(wa);
    });
  }, delay);
}

async function clearWAAuth(wa) {
  const d = await getDb();
  if (d) {
    await d.collection('auth').deleteMany({ ownerId: wa.userId });
  } else {
    fs.rmSync(userAuthPath(wa.userId), { recursive: true, force: true });
  }
}

async function disposeWA(userId, clearAuthState = true) {
  const wa = waSessions.get(String(userId));
  if (!wa) {
    if (clearAuthState) {
      const temp = createWAContext(String(userId));
      await clearWAAuth(temp).catch(() => {});
    }
    return;
  }

  clearReconnectTimer(wa);
  const current = wa.sock;
  wa.sock = null;
  wa.state = 'closed';
  wa.qrDataUrl = null;
  wa.groupCache = { at: 0, data: null };
  wa.codeCache.clear();
  wa.codeInflight.clear();

  if (current) {
    try { await current.logout(); } catch {}
    try { current.end(undefined); } catch {}
  }

  if (clearAuthState) await clearWAAuth(wa);
  waSessions.delete(String(userId));
}

async function useMongoAuthState(col, ownerId) {
  const { initAuthCreds, proto, BufferJSON } = await import('@whiskeysockets/baileys');
  const key = (type, id) => ({ ownerId, _id: `${ownerId}::${type}-${id}` });

  async function read(id, type) {
    const doc = await col.findOne(key(type, id));
    if (!doc) return null;
    return JSON.parse(doc.value, BufferJSON.reviver);
  }

  async function write(id, type, value) {
    await col.updateOne(
      key(type, id),
      { $set: { ownerId, value: JSON.stringify(value, BufferJSON.replacer) } },
      { upsert: true }
    );
  }

  const credsDoc = await col.findOne({ ownerId, _id: `${ownerId}::creds` });
  const creds = credsDoc ? JSON.parse(credsDoc.value, BufferJSON.reviver) : initAuthCreds();

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
                  ? col.deleteOne(key(type, id))
                  : write(id, type, value)
              )
            )
          );
        }
      }
    },
    saveCreds: async () => {
      await col.updateOne(
        { ownerId, _id: `${ownerId}::creds` },
        { $set: { ownerId, value: JSON.stringify(creds, BufferJSON.replacer) } },
        { upsert: true }
      );
    }
  };
}

async function startWA(userId) {
  const wa = getWA(userId);
  if (wa.startPromise) return wa.startPromise;
  clearReconnectTimer(wa);

  wa.startPromise = (async () => {
    wa.state = 'starting';
    wa.qrDataUrl = null;

    const d = await getDb();
    const auth = d
      ? await useMongoAuthState(d.collection('auth'), wa.userId)
      : await useMultiFileAuthState(userAuthPath(wa.userId));

    const { version } = await fetchLatestBaileysVersion();
    const currentSocket = makeWASocket({
      version,
      auth: auth.state,
      logger: pino({ level: 'silent' }),
      browser: ['Link Organizer', 'Chrome', '1.0']
    });

    wa.sock = currentSocket;
    currentSocket.ev.on('creds.update', auth.saveCreds);

    if (!wa.statsLoaded) {
      wa.statsLoaded = true;
      await wa.stats.load();
    }
    wa.stats.attach(currentSocket);

    currentSocket.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (wa.sock !== currentSocket) return;

      if (qr) {
        wa.state = 'qr';
        wa.qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
      }

      if (connection === 'open') {
        wa.state = 'connected';
        wa.qrDataUrl = null;
        wa.reconnectDelay = 2000;
        wa.groupCache = { at: 0, data: null };
        getGroups(wa, true)
          .then(() => wa.stats.onOpen())
          .catch((e) => console.log(`[wa:${wa.userId}] group preload:`, e.message));
      }

      if (connection === 'close') {
        if (wa.sock === currentSocket) wa.sock = null;
        wa.groupCache = { at: 0, data: null };
        wa.codeCache.clear();
        const code = lastDisconnect?.error?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          wa.state = 'closed';
          wa.qrDataUrl = null;
          await clearWAAuth(wa);
          wa.reconnectDelay = 2000;
          startWA(wa.userId).catch((e) => console.error(`[wa:${wa.userId}] fresh QR start:`, e.message));
        } else {
          wa.state = 'starting';
          wa.qrDataUrl = null;
          scheduleWAReconnect(wa);
        }
      }
    });
  })();

  try {
    return await wa.startPromise;
  } catch (e) {
    wa.state = 'starting';
    wa.sock = null;
    scheduleWAReconnect(wa);
    throw e;
  } finally {
    wa.startPromise = null;
  }
}

const statsByUser = new Map();
function getStats(userId) {
  const wa = getWA(userId);
  return wa.stats;
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

const needWA = (req, res, next) => {
  const wa = getWA(req.user.userId);
  if (wa.state === 'connected' && wa.sock) return next();
  if (!wa.startPromise && !wa.sock) {
    startWA(wa.userId).catch((e) => console.error(`[wa:${wa.userId}] start:`, e.message));
  }
  return res.status(400).json({ error: 'WhatsApp is not connected' });
};

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
      await disposeWA(id, true);
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
    await disposeWA(id, true);

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

app.get('/api/status', requireAuth, async (req, res) => {
  const wa = getWA(req.user.userId);
  if (!wa.startPromise && !wa.sock && wa.state !== 'qr' && wa.state !== 'connected') {
    startWA(wa.userId).catch((e) => console.error(`[wa:${wa.userId}] start:`, e.message));
  }
  res.json({
    state: wa.state,
    qr: wa.qrDataUrl,
    canDisconnect: true,
    owner: req.user.userId
  });
});

/* ---------- Groups ---------- */

app.get('/api/groups', requireAuth, needWA, async (req, res) => {
  try {
    const wa = getWA(req.user.userId);
    const all = await getGroups(wa, req.query.refresh === '1');
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

async function runPermissionJob(job, ids, changes, all, wa) {
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

      const groupChanges = changesNeededForGroup(g, changes);
      if (!Object.keys(groupChanges).length) {
        item.ok = true;
        item.applied = [];
        job.done++;
        job.updated = Date.now();
        continue;
      }

      try {
        item.applied = await applyGroupPermissionChanges(wa, id, groupChanges);
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
  const verification = await verifyPermissionJob(wa, job, ids, changes);
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

app.get('/api/group-permissions', requireAuth, needWA, async (req, res) => {
  try {
    const wa = getWA(req.user.userId);
    const all = await getGroups(wa, req.query.refresh === '1');
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

app.post('/api/group-permissions', requireAuth, needWA, async (req, res) => {
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

    const wa = getWA(req.user.userId);
    const all = await getGroups(wa);
    const job = {
      id: crypto.randomUUID(),
      userId: req.user.userId,
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

    runPermissionJob(job, ids, changes, all, wa).catch((e) => {
      job.state = 'error';
      job.error = e.message;
      job.updated = Date.now();
    });

    res.json({ ok: true, job: permissionJobPublic(job) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not start permission update' });
  }
});

app.get('/api/group-permission-job/:id', requireAuth, (req, res) => {
  const job = permissionJobs.get(req.params.id);
  if (!job || job.userId !== req.user.userId) {
    return res.status(404).json({ error: 'Permission job not found' });
  }
  res.json(permissionJobPublic(job));
});

/* ---------- Link jobs ---------- */

const errText = (e) => String(e?.message || e?.data || e || 'unknown error');
const isAdminErr = (m) => /not-authorized|forbidden|403/i.test(m);
const isRateErr = (m) => /rate|overlimit|429/i.test(m);
const jobs = new Map();

async function tryCode(wa, it, fresh = false) {
  if (!fresh) {
    const cached = wa.codeInflight.has(it.id)
      ? await wa.codeInflight.get(it.id)
      : null;
    if (cached?.code) return cached;

    const local = wa.codeCache.get(it.id);
    if (local && Date.now() - local.at < CODE_CACHE_TTL_MS) return { code: local.code };
    if (appData.codes[it.id]) return { code: appData.codes[it.id] };
  }

  if (wa.codeInflight.has(it.id)) return codeInflight.get(it.id);

  const promise = withWALinkLimit(wa, async () => {
    try {
      if (!wa.sock || wa.state !== 'connected') {
        return { err: 'WhatsApp is not connected', kind: 'other' };
      }

      const code = await wa.sock.groupInviteCode(it.id);
      if (code) {
        wa.codeCache.set(it.id, { code, at: Date.now() });
        return { code };
      }
      return { err: 'empty response from WhatsApp', kind: 'other' };
    } catch (e) {
      const m = errText(e);
      return { err: m, kind: isAdminErr(m) ? 'admin' : isRateErr(m) ? 'rate' : 'other' };
    }
  });

  wa.codeInflight.set(it.id, promise);
  try {
    return await promise;
  } finally {
    wa.codeInflight.delete(it.id);
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

async function runJob(job, items, fresh, wa) {
  const out = job.results;
  const codes = appData.codesByUser[job.userId] || {};
  appData.codesByUser[job.userId] = codes;
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

  for (let s = 0; s < todo.length; s += 8) {
    await Promise.all(todo.slice(s, s + 8).map(async (i) => {
      const it = items[i];
      const r = await tryCode(wa, it, fresh);

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

    
  }

  retry.sort((x, y) => x - y);

  for (const i of retry) {
    const it = items[i];
    let r = null;

    for (let a = 1; a <= 4; a++) {
      await sleep(1200 * a);
      r = await tryCode(wa, it, fresh);
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
    const wa = getWA(req.user.userId);
    const all = await getGroups(wa);
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

    runJob(job, items, !!fresh, wa)
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

/* ---------- WhatsApp disconnect: CURRENT USER ONLY ---------- */

app.post('/api/logout-wa', requireAuth, async (req, res) => {
  const wa = getWA(req.user.userId);
  try {
    clearReconnectTimer(wa);
    const current = wa.sock;
    wa.sock = null;
    wa.state = 'closed';
    wa.qrDataUrl = null;
    wa.groupCache = { at: 0, data: null };
    wa.codeCache.clear();
    wa.codeInflight.clear();

    if (current) {
      try { await current.logout(); } catch {}
    }

    await clearWAAuth(wa);
    wa.reconnectDelay = 2000;
    startWA(wa.userId).catch((e) => console.error(`[wa:${wa.userId}] manual reconnect:`, e.message));

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not disconnect WhatsApp: ' + e.message });
  }
});

/* ---------- Live group stats ---------- */

registerStatsRoutes(app, requireAuth, needWA, getStats);

/* ---------- Static files ---------- */

app.use(express.static('public'));

await loadData();
const admin = await ensureAdmin();
await migrateLegacyLists(String(admin._id));

// WhatsApp sessions are started lazily per authenticated user.

const sessionCleanupTimer = setInterval(cleanupAuth, 10 * 60 * 1000);
sessionCleanupTimer.unref?.();

const server = app.listen(PORT, () => {
  console.log(`WhatsApp Group Manager running on port ${PORT}`);
});

async function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  for (const wa of waSessions.values()) clearReconnectTimer(wa);
  clearInterval(sessionCleanupTimer);
  server.close();

  for (const wa of waSessions.values()) { try { if (wa.sock) wa.sock.end(undefined); } catch {} }
  for (const wa of waSessions.values()) { try { await wa.stats.flush(); } catch {} }
  try { if (mongoClient) await mongoClient.close(); } catch {}

  process.exit(0);
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));