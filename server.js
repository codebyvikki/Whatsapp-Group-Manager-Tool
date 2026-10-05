import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
let sharpModule = null;

async function getSharp() {
  if (sharpModule) return sharpModule;
  try {
    const mod = await import('sharp');
    sharpModule = mod.default || mod;
    return sharpModule;
  } catch {
    throw new Error('Image processing is not installed. Run npm install and try again.');
  }
}
import fs from 'fs';
import { MongoClient, Binary } from 'mongodb';
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
const MAX_DP_GROUPS = Math.max(1, Number(process.env.MAX_DP_GROUPS || 500));
const DP_START_GAP_MS = Math.max(700, Number(process.env.DP_START_GAP_MS || 1200));
const DP_IMAGE_MAX_BYTES = Math.max(256 * 1024, Number(process.env.DP_IMAGE_MAX_BYTES || 8 * 1024 * 1024));
const DP_IMAGE_TTL_MS = 15 * 60 * 1000;
const DP_JOB_TTL_MS = 30 * 60 * 1000;
const DESCRIPTION_MAX_GROUPS = Math.max(1, Number(process.env.MAX_DESCRIPTION_GROUPS || 500));
const DESCRIPTION_START_GAP_MS = Math.max(700, Number(process.env.DESCRIPTION_START_GAP_MS || 1000));
const DESCRIPTION_MAX_ATTEMPTS = Math.max(2, Number(process.env.DESCRIPTION_MAX_ATTEMPTS || 4));
const DESCRIPTION_JOB_TTL_MS = 30 * 60 * 1000;
const dpImages = new Map();
const dpJobs = new Map();
const descriptionJobs = new Map();
const memberRemovalJobs = new Map();
const MEMBER_REMOVER_MAX_GROUPS = Math.max(1, Number(process.env.MEMBER_REMOVER_MAX_GROUPS || 200));
const MEMBER_REMOVER_MAX_MEMBERS = Math.max(1, Number(process.env.MEMBER_REMOVER_MAX_MEMBERS || 500));
const MEMBER_REMOVER_GAP_MS = Math.max(700, Number(process.env.MEMBER_REMOVER_GAP_MS || 900));
const MEMBER_REMOVER_REQUEST_TIMEOUT_MS = Math.max(10000, Number(process.env.MEMBER_REMOVER_REQUEST_TIMEOUT_MS || 30000));
const MEMBER_REMOVER_RETRY_LIMIT = Math.max(0, Math.min(3, Number(process.env.MEMBER_REMOVER_RETRY_LIMIT || 2)));
const activeBulkJobs = new Set();
let permissionNextAllowedAt = 0;
let permissionCooldownUntil = 0;
let permissionAdaptiveGapMs = PERMISSION_START_GAP_MS;
let permissionHealthySuccesses = 0;
let permissionQueueActive = 0;
const permissionQueue = [];

function notePermissionRateLimit(attempt = 1) {
  const now = Date.now();

  permissionHealthySuccesses = 0;

  permissionAdaptiveGapMs = Math.min(
    PERMISSION_MAX_GAP_MS,
    Math.max(
      PERMISSION_START_GAP_MS,
      Math.round(permissionAdaptiveGapMs * 1.8)
    )
  );

  permissionCooldownUntil = Math.max(
    permissionCooldownUntil,
    now + Math.min(5000, 800 * attempt)
  );
}

async function waitPermissionSlot() {
  const now = Date.now();
  const waitUntil = Math.max(
    permissionNextAllowedAt,
    permissionCooldownUntil
  );

  if (waitUntil > now) {
    await sleep(waitUntil - now);
  }

  const current = Date.now();

  permissionNextAllowedAt =
    current + permissionAdaptiveGapMs;

  permissionHealthySuccesses++;

  if (permissionHealthySuccesses >= 8) {
    permissionHealthySuccesses = 0;

    permissionAdaptiveGapMs = Math.max(
      PERMISSION_START_GAP_MS,
      Math.round(permissionAdaptiveGapMs * 0.82)
    );
  }
}


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
        db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        db.collection('bulkJobs').createIndex({ userId: 1, type: 1, state: 1, updatedAt: -1 }),
        db.collection('bulkJobs').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
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
  listsByUser: {},
  creatorDailyByUser: {},
  creatorHistoryByUser: {}
};

async function loadData() {
  try {
    const d = await getDb();
    if (d) {
      const doc = await d.collection('data').findOne({ _id: 'appdata' });
      appData = {
        codes: doc?.codes || {},
        codesByUser: doc?.codesByUser || {},
        listsByUser: doc?.listsByUser || {},
        creatorDailyByUser: doc?.creatorDailyByUser || {},
        creatorHistoryByUser: doc?.creatorHistoryByUser || {}
      };
      // Legacy lists are migrated after the admin record exists.
      appData._legacyLists = Array.isArray(doc?.lists) ? doc.lists : [];
    } else {
      const j = readJson(DATA_FILE, {});
      appData = {
        codes: j.codes || {},
        codesByUser: j.codesByUser || {},
        listsByUser: j.listsByUser || {},
        creatorDailyByUser: j.creatorDailyByUser || {},
        creatorHistoryByUser: j.creatorHistoryByUser || {}
      };
      appData._legacyLists = Array.isArray(j.lists) ? j.lists : [];
    }
  } catch (e) {
    console.error('[storage] loadData:', e.message);
    appData = { codes: {}, codesByUser: {}, listsByUser: {}, creatorDailyByUser: {}, creatorHistoryByUser: {}, _legacyLists: [] };
  }
}

async function saveData() {
  const payload = {
    _id: 'appdata',
    codes: appData.codes || {},
    codesByUser: appData.codesByUser || {},
    listsByUser: appData.listsByUser || {},
    creatorDailyByUser: appData.creatorDailyByUser || {},
    creatorHistoryByUser: appData.creatorHistoryByUser || {}
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
    state: 'idle',
    qrDataUrl: null,
    startPromise: null,
    manualStop: false,
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
  const max = Math.min(
    12,
    Math.max(8, Number(process.env.MAX_WA_LINK_REQUESTS || 12))
  );
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

      const result = await withPermissionConcurrency(() =>
        withWALinkLimit(wa, operation)
      );

      return result;
    } catch (e) {
      lastError = e;

      const message = errText(e);

      if (isPermanentPermissionError(message)) {
        break;
      }

      const rateLimited = isPermissionRateError(message);

      if (rateLimited) {
        notePermissionRateLimit(attempt);
      }

      if (attempt === PERMISSION_MAX_ATTEMPTS) {
        break;
      }

      const delay = rateLimited
        ? Math.min(
            8000,
            PERMISSION_RETRY_BASE_MS * attempt * 2
          )
        : Math.min(
            3000,
            PERMISSION_RETRY_BASE_MS * attempt
          );

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
  if (wa.manualStop || wa.state === 'closed' || wa.reconnectTimer || wa.startPromise) return;
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
  wa.manualStop = false;
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

      if (connection === 'connecting' && !qr && wa.state !== 'qr') {
        wa.state = 'connecting';
      }

      if (qr) {
        try {
          // Build the image first. Only expose state=qr after a valid data URL
          // exists, otherwise the dashboard can briefly receive a broken QR.
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
          if (wa.sock === currentSocket) {
            wa.qrDataUrl = qrDataUrl;
            wa.state = 'qr';
          }
        } catch (e) {
          wa.qrDataUrl = null;
          wa.state = 'starting';
          console.error(`[wa:${wa.userId}] QR generation failed:`, e.message);
        }
      }

      if (connection === 'open') {
        wa.state = 'connected';
        wa.qrDataUrl = null;
        wa.reconnectDelay = 2000;
        wa.groupCache = { at: 0, data: null };
        getGroups(wa, true)
          .then(() => wa.stats.onOpen())
          .catch((e) => console.log(`[wa:${wa.userId}] group preload:`, e.message));
        setTimeout(() => resumeBulkJobsForUser(wa.userId).catch((e) => console.error(`[bulk:${wa.userId}] resume failed:`, e.message)), 250);
      }

      if (connection === 'close') {
        if (wa.sock === currentSocket) wa.sock = null;
        wa.groupCache = { at: 0, data: null };
        wa.codeCache.clear();
        const code = lastDisconnect?.error?.output?.statusCode;

        if (code === DisconnectReason.loggedOut) {
          wa.state = wa.manualStop ? 'idle' : 'closed';
          wa.qrDataUrl = null;
          await clearWAAuth(wa);
          wa.reconnectDelay = 2000;
          if (!wa.manualStop) {
            startWA(wa.userId).catch((e) => console.error(`[wa:${wa.userId}] fresh QR start:`, e.message));
          }
        } else {
          wa.state = wa.manualStop ? 'idle' : 'starting';
          wa.qrDataUrl = null;
          if (!wa.manualStop) scheduleWAReconnect(wa);
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
  return res.status(400).json({ error: 'WhatsApp is not connected' });
};

/* =========================================================
   APP
========================================================= */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use('/api/group-dp/image', express.raw({
  type: ['image/jpeg', 'image/png', 'image/webp'],
  limit: '8mb'
}));
app.use(express.json({ limit: MAX_JSON_BYTES }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // API responses contain authenticated/user-specific state.
  // Never let the browser or an intermediary cache them.
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }

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
  // Connection status is live state. Never let a browser/proxy cache a
  // previous disconnected/connecting response and show stale UI.
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store'
  });

  const wa = getWA(req.user.userId);
  const connected = wa.state === 'connected' && !!wa.sock;

  res.json({
    state: wa.state,
    connected,
    qr: wa.qrDataUrl,
    canDisconnect: wa.state !== 'idle',
    owner: req.user.userId,
    checkedAt: Date.now()
  });
});

/* ---------- WhatsApp start / QR refresh: CURRENT USER ONLY ---------- */

app.post('/api/start-wa', requireAuth, async (req, res) => {
  const wa = getWA(req.user.userId);
  const refresh = Boolean(req.body?.refresh);

  try {
    if (wa.state === 'connected' && wa.sock && !refresh) {
      return res.json({ ok: true, state: wa.state });
    }

    if (refresh) {
      clearReconnectTimer(wa);
      wa.manualStop = true;

      const current = wa.sock;
      wa.sock = null;
      wa.qrDataUrl = null;
      wa.state = 'idle';

      if (current) {
        try { current.end(undefined); } catch {}
      }

      await sleep(150);
      wa.manualStop = false;
    }

    await startWA(wa.userId);

    res.json({ ok: true, state: wa.state });
  } catch (e) {
    wa.state = 'idle';
    wa.qrDataUrl = null;
    res.status(500).json({ error: 'Could not start WhatsApp: ' + e.message });
  }
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

/* ---------- Resilient bulk job storage ---------- */

function bulkJobSerializable(job) {
  const out = { ...job };
  if (out.imageBuffer && Buffer.isBuffer(out.imageBuffer)) out.imageBuffer = new Binary(out.imageBuffer);
  return out;
}

function hydrateBulkJob(doc) {
  if (!doc) return null;
  const job = { ...doc };
  delete job._id;
  delete job.type;
  if (job.imageBuffer instanceof Binary) job.imageBuffer = Buffer.from(job.imageBuffer.buffer);
  return job;
}

async function persistBulkJob(job, type = job.type || 'dp') {
  job.type = type;
  job.updatedAt = Date.now();
  const d = await getDb();
  if (d) {
    await d.collection('bulkJobs').replaceOne(
      { _id: String(job.id) },
      { _id: String(job.id), ...bulkJobSerializable(job), type, userId: String(job.userId), expiresAt: new Date(job.expiresAt) },
      { upsert: true }
    );
  }
}

async function persistMemberRemovalJob(job){
  try {
    job.expiresAt = job.expiresAt || (Date.now() + 24 * 60 * 60 * 1000);
    await persistBulkJob(job, 'member-removal');
  } catch (e) {
    console.error('[member-remover] job persistence warning:', e?.message || e);
  }
}

async function deleteBulkJob(job, type = job.type || 'dp') {
  const d = await getDb();
  if (d) await d.collection('bulkJobs').deleteOne({ _id: String(job.id), type });
}

async function loadBulkJob(id, userId, type = 'dp') {
  const key = String(id || '');
  const map = type === 'dp' ? dpJobs : type === 'description' ? descriptionJobs : memberRemovalJobs;
  const cached = map.get(key);
  if (cached && String(cached.userId) === String(userId)) return cached;
  const d = await getDb();
  if (!d) return null;
  const doc = await d.collection('bulkJobs').findOne({ _id: key, type, userId: String(userId) });
  if (!doc) return null;
  const job = hydrateBulkJob(doc);
  map.set(job.id, job);
  return job;
}

async function findActiveBulkJob(userId, type = 'dp') {
  const uid = String(userId);
  const map = type === 'dp' ? dpJobs : type === 'description' ? descriptionJobs : memberRemovalJobs;
  const activeStates = new Set(['queued', 'running', 'paused', 'recoverable']);
  let best = null;
  for (const job of map.values()) {
    if (String(job.userId) !== uid || !activeStates.has(job.state)) continue;
    if (!best || (job.updatedAt || 0) > (best.updatedAt || 0)) best = job;
  }
  const d = await getDb();
  if (d) {
    const doc = await d.collection('bulkJobs').findOne(
      { userId: uid, type, state: { $in: [...activeStates] }, expiresAt: { $gt: new Date() } },
      { sort: { updatedAt: -1 } }
    );
    const dbJob = hydrateBulkJob(doc);
    if (dbJob && (!best || (dbJob.updatedAt || 0) > (best.updatedAt || 0))) {
      map.set(dbJob.id, dbJob);
      best = dbJob;
    }
  }
  return best;
}


async function findLatestBulkJob(userId, type = 'dp') {
  const uid = String(userId);
  const map = type === 'dp' ? dpJobs : type === 'description' ? descriptionJobs : memberRemovalJobs;
  let best = null;
  for (const job of map.values()) {
    if (String(job.userId) !== uid) continue;
    if (job.expiresAt && job.expiresAt <= Date.now()) continue;
    if (!best || (job.updatedAt || 0) > (best.updatedAt || 0)) best = job;
  }
  const d = await getDb();
  if (d) {
    const doc = await d.collection('bulkJobs').findOne(
      { userId: uid, type, expiresAt: { $gt: new Date() } },
      { sort: { updatedAt: -1 } }
    );
    const dbJob = hydrateBulkJob(doc);
    if (dbJob && (!best || (dbJob.updatedAt || 0) > (best.updatedAt || 0))) {
      map.set(dbJob.id, dbJob);
      best = dbJob;
    }
  }
  return best;
}

function markJobPaused(job, message) {
  if (job.state === 'running') {
    const current = job.results?.find((x) => x.status === 'running');
    if (current) current.status = 'pending';
  }
  job.state = 'paused';
  job.error = String(message || 'Waiting for WhatsApp connection.').slice(0, 300);
  job.current = null;
  job.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
}

function activeJobKey(userId, type) {
  return `${type}:${String(userId)}`;
}

/* ---------- Group DP Manager ---------- */

function dpErrorText(e) {
  return String(e?.message || e || 'Unknown error').replace(/\s+/g, ' ').trim().slice(0, 300);
}

function dpJobPublic(job) {
  if (!job) return null;
  return {
    id: job.id,
    action: job.action,
    state: job.state,
    total: job.total,
    done: job.done,
    success: job.success,
    failed: job.failed,
    current: job.current,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    updatedAt: job.updatedAt || null,
    error: job.error || null,
    cancelled: !!job.cancelled,
    results: (job.results || []).map((x) => ({ id: x.id, name: x.name, status: x.status, error: x.error || null }))
  };
}

function cleanupDpStore() {
  const now = Date.now();
  for (const [token, image] of dpImages) if (image.expiresAt <= now) dpImages.delete(token);
  for (const [id, job] of dpJobs) if (job.expiresAt <= now && !['running', 'queued', 'paused'].includes(job.state)) dpJobs.delete(id);
  for (const [id, job] of descriptionJobs) if (job.expiresAt <= now && !['running', 'queued', 'paused'].includes(job.state)) descriptionJobs.delete(id);
}
setInterval(cleanupDpStore, 5 * 60 * 1000).unref?.();

function dpValidateIds(ids) {
  if (!Array.isArray(ids)) throw new Error('Please select at least one group.');
  const clean = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!clean.length) throw new Error('Please select at least one group.');
  if (clean.length > MAX_DP_GROUPS) throw new Error(`Please process no more than ${MAX_DP_GROUPS} groups at once.`);
  if (clean.some((id) => !id.endsWith('@g.us'))) throw new Error('One or more selected groups are invalid.');
  return clean;
}

async function normalizeDpImage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Please upload an image.');
  if (buffer.length > DP_IMAGE_MAX_BYTES) throw new Error(`Image is too large. Maximum size is ${Math.round(DP_IMAGE_MAX_BYTES / 1024 / 1024)} MB.`);
  const sharp = await getSharp();
  const meta = await sharp(buffer, { failOn: 'error' }).metadata();
  if (!meta.width || !meta.height) throw new Error('The uploaded file is not a valid image.');
  if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new Error('Please use JPG, PNG or WEBP image format.');
  return sharp(buffer, { failOn: 'error' }).rotate().resize(640, 640, { fit: 'cover', position: 'centre' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

async function updateGroupDp(wa, jid, imageBuffer) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) throw new Error('No image data is available.');
  await wa.sock.updateProfilePicture(jid, imageBuffer);
}

async function runDpJob(job) {
  const key = activeJobKey(job.userId, 'dp');
  if (activeBulkJobs.has(key)) return;
  activeBulkJobs.add(key);
  const wa = getWA(job.userId);
  try {
    job.state = 'running';
    job.error = null;
    job.startedAt ||= new Date().toISOString();
    job.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await persistBulkJob(job, 'dp');

    for (let i = 0; i < job.results.length; i++) {
      if (job.cancelled) { job.state = 'cancelled'; job.finishedAt = new Date().toISOString(); job.current = null; job.expiresAt = Date.now() + DP_JOB_TTL_MS; await persistBulkJob(job, 'dp'); return; }
      if (wa.state !== 'connected' || !wa.sock) {
        markJobPaused(job, 'WhatsApp disconnected. The job will resume automatically after reconnection.');
        await persistBulkJob(job, 'dp');
        return;
      }
      const result = job.results[i];
      if (result.status === 'success') continue;
      job.current = { index: i + 1, total: job.total, name: result.name };
      result.status = 'running';
      await persistBulkJob(job, 'dp');
      try {
        await withWALinkLimit(wa, async () => {
          if (job.action === 'update') await updateGroupDp(wa, result.id, job.imageBuffer);
          else await wa.sock.removeProfilePicture(result.id);
        });
        result.status = 'success';
        result.error = null;
        job.success++;
      } catch (e) {
        result.status = 'failed';
        result.error = dpErrorText(e);
        job.failed++;
      }
      job.done = job.results.filter((x) => x.status === 'success' || x.status === 'failed').length;
      job.current = null;
      await persistBulkJob(job, 'dp');
      if (i < job.results.length - 1) await sleep(DP_START_GAP_MS);
    }
    job.state = 'finished';
    job.finishedAt = new Date().toISOString();
    job.expiresAt = Date.now() + DP_JOB_TTL_MS;
    await persistBulkJob(job, 'dp');
    setTimeout(() => { const current = dpJobs.get(job.id); if (current === job) { delete current.imageBuffer; current.expiresAt = Date.now() + 5 * 60 * 1000; persistBulkJob(current, 'dp').catch(() => {}); } }, Math.max(1000, DP_JOB_TTL_MS - 5 * 60 * 1000)).unref?.();
  } catch (e) {
    job.state = 'error';
    job.error = dpErrorText(e);
    job.finishedAt = new Date().toISOString();
    job.expiresAt = Date.now() + DP_JOB_TTL_MS;
    await persistBulkJob(job, 'dp').catch(() => {});
  } finally {
    activeBulkJobs.delete(key);
  }
}

app.post('/api/group-dp/image', requireAuth, (req, res) => {
  try {
    const type = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) return res.status(415).json({ error: 'Please upload a JPG, PNG or WEBP image.' });
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
    if (!buffer.length) return res.status(400).json({ error: 'Please upload an image.' });
    if (buffer.length > DP_IMAGE_MAX_BYTES) return res.status(413).json({ error: `Image is too large. Maximum size is ${Math.round(DP_IMAGE_MAX_BYTES / 1024 / 1024)} MB.` });
    const token = crypto.randomUUID();
    dpImages.set(token, { userId: String(req.user.userId), buffer, type, expiresAt: Date.now() + DP_IMAGE_TTL_MS });
    res.json({ ok: true, token });
  } catch (e) { res.status(400).json({ error: dpErrorText(e) }); }
});

async function createDpJob(req, action, ids, imageBuffer = null) {
  const active = await findActiveBulkJob(req.user.userId, 'dp');
  if (active) throw new Error(`A DP job is already ${active.state}. Wait for it to finish or reconnect to it.`);
  const all = await getGroups(getWA(req.user.userId), false);
  const results = ids.map((id) => ({ id, name: String(all[id]?.subject || id), status: 'pending', error: null }));
  const job = { id: `DP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex')}`, type: 'dp', userId: String(req.user.userId), action, imageBuffer, results, total: results.length, done: 0, success: 0, failed: 0, current: null, state: 'queued', cancelled: false, startedAt: null, finishedAt: null, updatedAt: Date.now(), error: null, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  dpJobs.set(job.id, job);
  await persistBulkJob(job, 'dp');
  runDpJob(job).catch((e) => console.error(`[dp:${job.id}]`, e.message));
  return job;
}

app.post('/api/group-dp/apply', requireAuth, needWA, async (req, res) => {
  try {
    cleanupDpStore();
    const ids = dpValidateIds(req.body?.ids);
    const token = String(req.body?.imageToken || '');
    const image = dpImages.get(token);
    if (!image || image.userId !== String(req.user.userId)) return res.status(400).json({ error: 'The uploaded image has expired. Please upload it again.' });
    const normalized = await normalizeDpImage(image.buffer);
    dpImages.delete(token);
    const job = await createDpJob(req, 'update', ids, normalized);
    res.json({ ok: true, job: dpJobPublic(job) });
  } catch (e) { res.status(400).json({ error: dpErrorText(e) }); }
});

app.post('/api/group-dp/remove', requireAuth, needWA, async (req, res) => {
  try {
    const ids = dpValidateIds(req.body?.ids);
    const job = await createDpJob(req, 'remove', ids, null);
    res.json({ ok: true, job: dpJobPublic(job) });
  } catch (e) { res.status(400).json({ error: dpErrorText(e) }); }
});

app.get('/api/group-dp/job/:id', requireAuth, async (req, res) => {
  const job = await loadBulkJob(req.params.id, req.user.userId, 'dp');
  if (!job || (job.expiresAt && job.expiresAt <= Date.now() && !['running','queued','paused'].includes(job.state))) return res.status(404).json({ error: 'DP job not found or expired.' });
  if (job.state === 'paused') {
    const wa = getWA(req.user.userId);
    if (wa.state === 'connected' && wa.sock) runDpJob(job).catch(() => {});
  }
  res.json({ job: dpJobPublic(job), error: job.error || null });
});

app.get('/api/group-dp/active', requireAuth, async (req, res) => {
  const active = await findActiveBulkJob(req.user.userId, 'dp');
  const job = active || await findLatestBulkJob(req.user.userId, 'dp');
  if (active && getWA(req.user.userId).state === 'connected') runDpJob(active).catch(() => {});
  res.json({ job: dpJobPublic(job) });
});

app.post('/api/group-dp/job/:id/retry', requireAuth, needWA, async (req, res) => {
  const old = await loadBulkJob(req.params.id, req.user.userId, 'dp');
  if (!old) return res.status(404).json({ error: 'DP job not found or expired.' });
  if (old.state === 'running' || old.state === 'queued' || old.state === 'paused') return res.status(409).json({ error: 'The current DP job is still active.' });
  const failed = old.results.filter((x) => x.status === 'failed');
  if (!failed.length) return res.status(400).json({ error: 'There are no failed groups to retry.' });
  if (old.action === 'update' && !old.imageBuffer) return res.status(410).json({ error: 'The uploaded image has expired. Please start a new update.' });
  const active = await findActiveBulkJob(req.user.userId, 'dp');
  if (active) return res.status(409).json({ error: 'Another DP job is already active.' });
  const retry = { id: `DP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex')}`, type:'dp', userId: old.userId, action: old.action, imageBuffer: old.imageBuffer || null, results: failed.map((x) => ({ ...x, status: 'pending', error: null })), total: failed.length, done: 0, success: 0, failed: 0, current: null, state: 'queued', startedAt: null, finishedAt: null, updatedAt: Date.now(), error: null, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  dpJobs.set(retry.id, retry);
  await persistBulkJob(retry, 'dp');
  runDpJob(retry).catch(() => {});
  res.json({ ok: true, job: dpJobPublic(retry) });
});

/* ---------- Group Description Manager ---------- */

function descriptionErrorText(e) { return String(e?.message || e || 'Unknown error').replace(/\s+/g, ' ').trim().slice(0, 300); }
function descriptionValidateIds(ids) {
  if (!Array.isArray(ids)) throw new Error('Please select at least one group.');
  const clean = [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
  if (!clean.length) throw new Error('Please select at least one group.');
  if (clean.length > DESCRIPTION_MAX_GROUPS) throw new Error(`Please process no more than ${DESCRIPTION_MAX_GROUPS} groups at once.`);
  if (clean.some((id) => !id.endsWith('@g.us'))) throw new Error('One or more selected groups are invalid.');
  return clean;
}

function descriptionJobPublic(job) {
  if (!job) return null;
  return { id: job.id, action: job.action, state: job.state, total: job.total, done: job.done, success: job.success, failed: job.failed, current: job.current, startedAt: job.startedAt, finishedAt: job.finishedAt, updatedAt: job.updatedAt || null, error: job.error || null, cancelled: !!job.cancelled, results: (job.results || []).map((x) => ({ id:x.id, name:x.name, status:x.status, error:x.error || null })) };
}

function isDescriptionRateError(e) { return /rate|overlimit|429|too many|throttl|temporar/i.test(descriptionErrorText(e)); }
function isDescriptionPermanentError(e) { return /not-authorized|forbidden|403|not admin|not an admin|invalid|not a participant/i.test(descriptionErrorText(e)); }

async function updateGroupDescriptionWithRetry(wa, jid, description) {
  let last = null;
  for (let attempt = 1; attempt <= DESCRIPTION_MAX_ATTEMPTS; attempt++) {
    try {
      if (!wa.sock || wa.state !== 'connected') throw new Error('WhatsApp is not connected');
      await withWALinkLimit(wa, () => wa.sock.groupUpdateDescription(jid, description));
      const g = wa.groupCache.data?.[jid];
      if (g) g.desc = description;
      return;
    } catch (e) {
      last = e;
      if (isDescriptionPermanentError(e) || !isDescriptionRateError(e) || attempt >= DESCRIPTION_MAX_ATTEMPTS) break;
      await sleep(Math.min(8000, DESCRIPTION_START_GAP_MS * attempt * 2));
    }
  }
  throw last || new Error('Description update failed');
}

async function runDescriptionJob(job) {
  const key = activeJobKey(job.userId, 'description');
  if (activeBulkJobs.has(key)) return;
  activeBulkJobs.add(key);
  const wa = getWA(job.userId);
  try {
    job.state = 'running'; job.error = null; job.startedAt ||= new Date().toISOString(); job.expiresAt = Date.now() + 24*60*60*1000;
    await persistBulkJob(job, 'description');
    for (let i = 0; i < job.results.length; i++) {
      if (job.cancelled) { job.state='cancelled'; job.finishedAt=new Date().toISOString(); job.current=null; job.expiresAt=Date.now()+DESCRIPTION_JOB_TTL_MS; await persistBulkJob(job,'description'); return; }
      if (wa.state !== 'connected' || !wa.sock) { markJobPaused(job, 'WhatsApp disconnected. The job will resume automatically after reconnection.'); await persistBulkJob(job, 'description'); return; }
      const result = job.results[i];
      if (result.status === 'success') continue;
      job.current = { index:i+1, total:job.total, name:result.name }; result.status='running'; await persistBulkJob(job,'description');
      try {
        await updateGroupDescriptionWithRetry(wa, result.id, job.description);
        result.status='success'; result.error=null; job.success++;
      } catch (e) {
        result.status='failed'; result.error=descriptionErrorText(e); job.failed++;
      }
      job.done = job.results.filter((x)=>x.status==='success'||x.status==='failed').length;
      job.current=null; await persistBulkJob(job,'description');
      if (i < job.results.length-1) await sleep(DESCRIPTION_START_GAP_MS);
    }
    job.state='finished'; job.finishedAt=new Date().toISOString(); job.expiresAt=Date.now()+DESCRIPTION_JOB_TTL_MS; await persistBulkJob(job,'description');
  } catch(e) {
    job.state='error'; job.error=descriptionErrorText(e); job.finishedAt=new Date().toISOString(); job.expiresAt=Date.now()+DESCRIPTION_JOB_TTL_MS; await persistBulkJob(job,'description').catch(()=>{});
  } finally { activeBulkJobs.delete(key); }
}

async function createDescriptionJob(req, action, ids, description) {
  const active = await findActiveBulkJob(req.user.userId, 'description');
  if (active) throw new Error(`A description job is already ${active.state}. Wait for it to finish or reconnect to it.`);
  const all = await getGroups(getWA(req.user.userId), false);
  const results = ids.map((id)=>({id,name:String(all[id]?.subject||id),status:'pending',error:null}));
  const job={id:`DESC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex')}`,type:'description',userId:String(req.user.userId),action,description,total:results.length,results,done:0,success:0,failed:0,current:null,state:'queued',cancelled:false,startedAt:null,finishedAt:null,updatedAt:Date.now(),error:null,createdAt:Date.now(),expiresAt:Date.now()+24*60*60*1000};
  descriptionJobs.set(job.id,job); await persistBulkJob(job,'description'); runDescriptionJob(job).catch(()=>{}); return job;
}

app.post('/api/group-description/apply', requireAuth, needWA, async (req,res)=>{
  try {
    const ids=descriptionValidateIds(req.body?.ids); const action=String(req.body?.action||'update');
    if(!['update','remove'].includes(action)) throw new Error('Invalid description action.');
    const description=action==='remove'?'':String(req.body?.description ?? '');
    if(action==='update' && description.length>512) throw new Error('Group description cannot exceed 512 characters.');
    if(action==='update' && !description.trim()) throw new Error('Enter a group description first.');
    const job=await createDescriptionJob(req,action,ids,description); res.json({ok:true,job:descriptionJobPublic(job)});
  } catch(e){ res.status(400).json({error:descriptionErrorText(e)}); }
});

app.get('/api/group-description/job/:id', requireAuth, async (req,res)=>{
  const job=await loadBulkJob(req.params.id,req.user.userId,'description');
  if(!job || (job.expiresAt && job.expiresAt<=Date.now()&&!['running','queued','paused'].includes(job.state))) return res.status(404).json({error:'Description job not found or expired.'});
  if(job.state==='paused'&&getWA(req.user.userId).state==='connected') runDescriptionJob(job).catch(()=>{});
  res.json({job:descriptionJobPublic(job),error:job.error||null});
});

app.get('/api/group-description/active', requireAuth, async (req,res)=>{
  const active=await findActiveBulkJob(req.user.userId,'description');
  const job=active||await findLatestBulkJob(req.user.userId,'description');
  if(active&&getWA(req.user.userId).state==='connected') runDescriptionJob(active).catch(()=>{});
  res.json({job:descriptionJobPublic(job)});
});

app.post('/api/group-description/job/:id/retry', requireAuth, needWA, async (req,res)=>{
  const old=await loadBulkJob(req.params.id,req.user.userId,'description');
  if(!old) return res.status(404).json({error:'Description job not found or expired.'});
  if(['running','queued','paused'].includes(old.state)) return res.status(409).json({error:'The current description job is still active.'});
  const failed=old.results.filter((x)=>x.status==='failed'); if(!failed.length) return res.status(400).json({error:'There are no failed groups to retry.'});
  const active=await findActiveBulkJob(req.user.userId,'description'); if(active) return res.status(409).json({error:'Another description job is already active.'});
  const retry={id:`DESC-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex')}`,type:'description',userId:old.userId,action:old.action,description:old.description,total:failed.length,results:failed.map((x)=>({...x,status:'pending',error:null})),done:0,success:0,failed:0,current:null,state:'queued',startedAt:null,finishedAt:null,updatedAt:Date.now(),error:null,createdAt:Date.now(),expiresAt:Date.now()+24*60*60*1000};
  descriptionJobs.set(retry.id,retry); await persistBulkJob(retry,'description'); runDescriptionJob(retry).catch(()=>{}); res.json({ok:true,job:descriptionJobPublic(retry)});
});


async function cancelBulkJob(type, id, userId) {
  const map = type === 'dp' ? dpJobs : type === 'description' ? descriptionJobs : memberRemovalJobs;
  const job = await loadBulkJob(id, userId, type);
  if (!job) throw new Error('Job not found or expired.');
  if (!['queued','running','paused'].includes(job.state)) return job;
  job.cancelled = true;
  job.state = 'cancelling';
  job.error = 'Cancellation requested. Finishing the current operation…';
  job.updatedAt = Date.now();
  map.set(job.id, job);
  await persistBulkJob(job, type);
  return job;
}

app.post('/api/group-dp/job/:id/cancel', requireAuth, async (req,res)=>{
  try { res.json({ok:true,job:dpJobPublic(await cancelBulkJob('dp',req.params.id,req.user.userId))}); }
  catch(e){ res.status(400).json({error:dpErrorText(e)}); }
});
app.post('/api/group-description/job/:id/cancel', requireAuth, async (req,res)=>{
  try { res.json({ok:true,job:descriptionJobPublic(await cancelBulkJob('description',req.params.id,req.user.userId))}); }
  catch(e){ res.status(400).json({error:descriptionErrorText(e)}); }
});

async function resumeBulkJobsForUser(userId) {
  const wa=getWA(userId); if(wa.state!=='connected'||!wa.sock)return;
  for(const type of ['dp','description','member-removal']) {
    const map=type==='dp'?dpJobs:type==='description'?descriptionJobs:memberRemovalJobs;
    const job=await findActiveBulkJob(userId,type); if(!job)continue;
    if(job.state==='running') { const running=job.results?.find((x)=>x.status==='running'); if(running) running.status='pending'; job.current=null; }
    map.set(job.id,job);
    if(type==='dp') runDpJob(job).catch(()=>{});
    else if(type==='description') runDescriptionJob(job).catch(()=>{});
    else runMemberRemovalJob(job).catch(()=>{});
  }
}


/* ---------- Group Member Remover ---------- */
function memberRemovalPublic(job){
  if(!job) return null;
  return {id:job.id,state:job.state,total:job.total,done:job.done,removed:job.removed,failed:job.failed,skipped:job.skipped,current:job.current,results:job.results||[],error:job.error||null,cancelled:!!job.cancelled,startedAt:job.startedAt,finishedAt:job.finishedAt};
}
function cleanMemberJid(v){
  const s=String(v||'').trim();
  return s.includes('@') ? s : (s ? `${s}@s.whatsapp.net` : '');
}
function memberDisplay(p){ return String(p?.notify || p?.name || p?.jid || p?.id || '').trim() || String(p?.id||''); }
function memberSelfJid(wa){
  return cleanMemberJid(String(wa?.sock?.user?.id || '').replace(/:.+$/,''));
}
function memberRemovalTransient(e){
  const s=String(e?.message||e||'').toLowerCase();
  return /429|rate.?limit|too many|timed out|timeout|connection closed|connection reset|temporar|503|502|network/.test(s);
}
async function removeMemberSafely(wa, task){
  let last;
  for(let attempt=0; attempt<=MEMBER_REMOVER_RETRY_LIMIT; attempt++){
    try{
      await Promise.race([
        withWALinkLimit(wa,()=>wa.sock.groupParticipantsUpdate(task.groupId,[task.memberJid],'remove')),
        new Promise((_,reject)=>setTimeout(()=>reject(new Error('Member removal request timed out.')), MEMBER_REMOVER_REQUEST_TIMEOUT_MS))
      ]);
      return;
    }catch(e){
      last=e;
      if(!memberRemovalTransient(e) || attempt>=MEMBER_REMOVER_RETRY_LIMIT) throw e;
      await sleep(Math.min(5000, 1200 * (attempt + 1)));
    }
  }
  throw last || new Error('Member removal failed.');
}
async function loadSelectedMembers(userId, ids){
  const wa=getWA(userId);
  let all=await getGroups(wa,false);
  let selected=ids.map(id=>all[id]).filter(Boolean);
  if(selected.length!==ids.length || selected.some(g=>!Array.isArray(g.participants))){
    all=await getGroups(wa,true);
    selected=ids.map(id=>all[id]).filter(Boolean);
  }
  if(!selected.length) throw new Error('The selected groups could not be loaded. Refresh groups and try again.');
  const members=new Map();
  for(const g of selected){
    for(const p of (Array.isArray(g.participants)?g.participants:[])){
      const jid=cleanMemberJid(p?.id||p?.jid); if(!jid) continue;
      if(!members.has(jid)) members.set(jid,{jid,name:memberDisplay(p),groups:[]});
      members.get(jid).groups.push({id:g.id,name:String(g.subject||g.id),admin:p.admin||null,self:jid===memberSelfJid(wa)});
    }
  }
  return {groups:selected.map(g=>({id:g.id,name:String(g.subject||g.id),size:g.participants?.length||0})),members:[...members.values()]};
}
async function runMemberRemovalJob(job){
  const key=activeJobKey(job.userId,'member-removal');
  if(activeBulkJobs.has(key)) return;
  activeBulkJobs.add(key); const wa=getWA(job.userId);
  try{
    job.state='running'; job.startedAt ||= new Date().toISOString(); await persistMemberRemovalJob(job);
    for(let i=0;i<job.tasks.length;i++){
      if(job.cancelled){job.state='cancelled';job.finishedAt=new Date().toISOString();job.current=null;await persistMemberRemovalJob(job);break;}
      const t=job.tasks[i]; if(t.status==='success'||t.status==='skipped') continue;
      if(wa.state!=='connected'||!wa.sock){t.status='pending';job.state='paused';job.error='WhatsApp disconnected. Reconnect and reopen this job to resume.';job.current=null;await persistMemberRemovalJob(job);return;}
      job.current={index:i+1,total:job.total,name:t.groupName,member:t.memberName}; t.status='running';
      try{
        const self=memberSelfJid(wa);
        if(t.admin || t.self || (self && t.memberJid===self)){t.status='skipped';t.note='Admin/self skipped for safety.';job.skipped++;}
        else { await removeMemberSafely(wa,t); t.status='success';job.removed++;}
      }catch(e){
        if(wa.state!=='connected' || !wa.sock){t.status='pending';job.state='paused';job.error='WhatsApp disconnected during removal. Reconnect and reopen this job to resume.';job.current=null;await persistMemberRemovalJob(job);return;}
        t.status='failed';t.error=errText(e);job.failed++;
      }
      job.done=job.tasks.filter(x=>['success','failed','skipped'].includes(x.status)).length; job.current=null; await persistMemberRemovalJob(job);
      if(job.cancelled){job.state='cancelled';job.finishedAt=new Date().toISOString();break;}
      if(i<job.tasks.length-1) await sleep(MEMBER_REMOVER_GAP_MS);
    }
    if(job.state==='running'){job.state='finished';job.finishedAt=new Date().toISOString();await persistMemberRemovalJob(job);}
  }catch(e){job.state='error';job.error=errText(e);job.finishedAt=new Date().toISOString();await persistMemberRemovalJob(job);}
  finally{activeBulkJobs.delete(key);}
}
app.post('/api/member-remover/members',requireAuth,needWA,async(req,res)=>{try{const ids=[...new Set(Array.isArray(req.body?.ids)?req.body.ids.map(String).filter(x=>x.endsWith('@g.us')):[])];if(!ids.length)throw new Error('Select at least one group.');if(ids.length>MEMBER_REMOVER_MAX_GROUPS)throw new Error(`Please select no more than ${MEMBER_REMOVER_MAX_GROUPS} groups.`);const data=await loadSelectedMembers(req.user.userId,ids);res.json(data);}catch(e){res.status(400).json({error:errText(e)});}});
app.post('/api/member-remover/start',requireAuth,needWA,async(req,res)=>{try{const ids=[...new Set(Array.isArray(req.body?.groupIds)?req.body.groupIds.map(String):[])];const members=[...new Set(Array.isArray(req.body?.memberJids)?req.body.memberJids.map(cleanMemberJid).filter(Boolean):[])];if(!ids.length||!members.length)throw new Error('Select groups and at least one member.');if(ids.length>MEMBER_REMOVER_MAX_GROUPS)throw new Error(`Please select no more than ${MEMBER_REMOVER_MAX_GROUPS} groups.`);if(members.length>MEMBER_REMOVER_MAX_MEMBERS)throw new Error(`Please select no more than ${MEMBER_REMOVER_MAX_MEMBERS} members.`);const active=await findActiveBulkJob(req.user.userId,'member-removal');if(active&&['queued','running','paused','cancelling'].includes(active.state))throw new Error('A member removal job is already active.');const data=await loadSelectedMembers(req.user.userId,ids);const memberMap=new Map(data.members.map(m=>[m.jid,m]));const tasks=[];for(const m of members){const info=memberMap.get(m);if(!info)continue;for(const g of info.groups){tasks.push({groupId:g.id,groupName:g.name,memberJid:m,memberName:info.name,admin:!!g.admin,self:!!g.self,status:(g.admin||g.self)?'skipped':'pending',error:null,note:(g.admin||g.self)?'Admin/self skipped for safety.':null});}}if(!tasks.length)throw new Error('None of the selected members are present in the selected groups.');const preSkipped=tasks.filter(t=>t.status==='skipped').length;const job={id:`REM-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex')}`,userId:String(req.user.userId),state:'queued',total:tasks.length,done:preSkipped,removed:0,failed:0,skipped:preSkipped,current:null,tasks,results:tasks,error:null,cancelled:false,startedAt:null,finishedAt:null,createdAt:Date.now()};memberRemovalJobs.set(job.id,job);await persistMemberRemovalJob(job);runMemberRemovalJob(job).catch(async e=>{job.state='error';job.error=errText(e);await persistMemberRemovalJob(job);});res.json({ok:true,job:memberRemovalPublic(job)});}catch(e){res.status(400).json({error:errText(e)});}});
app.get('/api/member-remover/job/:id',requireAuth,async(req,res)=>{let j=await loadBulkJob(req.params.id,req.user.userId,'member-removal');if(!j||String(j.userId)!==String(req.user.userId))return res.status(404).json({error:'Member removal job not found'});memberRemovalJobs.set(j.id,j);if(j.state==='paused'&&getWA(req.user.userId).state==='connected')runMemberRemovalJob(j).catch(()=>{});res.json({job:memberRemovalPublic(j)});});
app.get('/api/member-remover/active',requireAuth,async(req,res)=>{let j=await findLatestBulkJob(req.user.userId,'member-removal');if(j) memberRemovalJobs.set(j.id,j);res.json({job:memberRemovalPublic(j)});});
app.post('/api/member-remover/job/:id/cancel',requireAuth,async(req,res)=>{let j=await loadBulkJob(req.params.id,req.user.userId,'member-removal');if(!j||String(j.userId)!==String(req.user.userId))return res.status(404).json({error:'Member removal job not found'});memberRemovalJobs.set(j.id,j);if(!['queued','running','paused','cancelling'].includes(j.state))return res.json({ok:true,job:memberRemovalPublic(j)});j.cancelled=true;j.state='cancelling';await persistMemberRemovalJob(j);res.json({ok:true,job:memberRemovalPublic(j)});});

/* ---------- Group permissions ---------- */

const permissionJobs = new Map();

function permissionJobPublic(job) {
  return {
    id: job.id,
    state: job.state,
    cancelled: !!job.cancelled,
    total: job.total,
    done: job.done,
    updated: job.updated,
    phase: job.phase || 'running',
    remaining: job.remaining ?? 0,
    results: job.results,
    error: job.error || null,
    cancelled: !!job.cancelled
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
      if (job.cancelled) return;
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

  if (job.cancelled) { job.state='cancelled'; job.phase='cancelled'; job.updated=Date.now(); return; }

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
      error: null,
      cancelled: false
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
app.post('/api/group-permission-job/:id/cancel', requireAuth, (req,res)=>{
  const job=permissionJobs.get(req.params.id);
  if(!job || job.userId!==req.user.userId) return res.status(404).json({error:'Permission job not found'});
  if(['done','error','cancelled'].includes(job.state)) return res.json({ok:true,job:permissionJobPublic(job)});
  job.cancelled=true; job.state='cancelling'; job.phase='cancelling'; job.updated=Date.now();
  res.json({ok:true,job:permissionJobPublic(job)});
});

  }
  res.json(permissionJobPublic(job));
});

/* ---------- Group name manager ---------- */

// Group renaming is intentionally isolated from the Link Organizer, Stats and
// Permissions workers.  It reuses the already-connected WhatsApp socket and
// existing group cache so adding this feature does not add another connection
// or a permanent background workload.
const GROUP_NAME_MAX = Math.max(1, Math.min(1000, Number(process.env.GROUP_NAME_MAX || 200)));
const GROUP_NAME_DELAY_MS = Math.max(250, Number(process.env.GROUP_NAME_DELAY_MS || 500));
const GROUP_NAME_RETRIES = Math.max(0, Math.min(4, Number(process.env.GROUP_NAME_RETRIES || 3)));
const groupNameJobs = new Map();

function groupNamePublic(job) {
  return {
    id: job.id,
    state: job.state,
    phase: job.phase,
    total: job.total,
    done: job.done,
    updated: job.updated,
    results: job.results,
    error: job.error || null
  };
}

function cleanGroupName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function trailingGroupNumber(name) {
  const m = cleanGroupName(name).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

function normalizeGroupIds(ids) {
  return [...new Set(
    (Array.isArray(ids) ? ids : [])
      .filter((id) => typeof id === 'string' && id.trim())
      .map((id) => id.trim())
  )];
}

function formatGroupNumber(value, digits) {
  const n = Number(value);
  const d = Number(digits) || 0;
  return d > 0 ? String(n).padStart(d, '0') : String(n);
}

function makeTargetName(prefix, number, separator = ' ', digits = 0) {
  const p = cleanGroupName(prefix);
  const n = formatGroupNumber(number, digits);
  return `${p}${separator}${n}`.trim();
}

function exactRangeGroups(groups, prefix, from, to) {
  const p = cleanGroupName(prefix);
  const a = Number(from);
  const b = Number(to);
  if (!p) throw new Error('Enter the existing group prefix.');
  if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) throw new Error('Enter a valid existing start and end number.');
  if (b - a + 1 > 1000) throw new Error('Please use a range of 1000 groups or less.');

  return groups.filter((g) => {
    const name = cleanGroupName(g.name);
    const m = name.match(/^(.*?)(\d+)\s*$/);
    if (!m) return false;
    return m[1].trimEnd() === p && Number(m[2]) >= a && Number(m[2]) <= b;
  });
}

function buildGroupNamePlan(all, input) {
  const groups = Object.values(all || {})
    .map((g) => ({
      id: g.id,
      name: cleanGroupName(g.subject || ''),
      num: trailingGroupNumber(g.subject || ''),
      size: g.size ?? g.participants?.length ?? 0
    }))
    .sort((a, b) => ((a.num ?? Infinity) - (b.num ?? Infinity)) || a.name.localeCompare(b.name));

  const mode = ['range', 'select', 'list'].includes(input?.mode) ? input.mode : 'select';
  let selected;
  let names;

  if (mode === 'range') {
    const ids = normalizeGroupIds(input?.ids);
    const byId = new Map(groups.map((g) => [g.id, g]));

    if (ids.length) {
      selected = ids.map((id) => byId.get(id)).filter(Boolean);
      if (!selected.length) throw new Error('No valid groups selected. Refresh groups and try again.');
    } else {
      selected = exactRangeGroups(groups, input?.currentPrefix, input?.currentFrom, input?.currentTo);
    }

    const currentPrefix = cleanGroupName(input?.currentPrefix);
    if (currentPrefix && Number.isInteger(Number(input?.currentFrom)) && Number.isInteger(Number(input?.currentTo))) {
      const allowed = new Set(exactRangeGroups(groups, currentPrefix, input.currentFrom, input.currentTo).map((g) => g.id));
      selected = selected.filter((g) => allowed.has(g.id));
    }

    if (!selected.length) throw new Error('No groups matched the existing prefix and number range.');
    const prefix = cleanGroupName(input?.prefix);
    const start = Number(input?.startNumber);
    const step = Number(input?.step || 1);
    const separator = typeof input?.separator === 'string' ? input.separator : ' ';
    const digits = Number(input?.digits || 0);
    if (!prefix) throw new Error('Enter the new group prefix.');
    if (!Number.isInteger(start)) throw new Error('Enter a valid new starting number.');
    if (!Number.isInteger(step) || step < 1) throw new Error('Step must be a positive number.');
    if (![0,2,3,4].includes(digits)) throw new Error('Invalid number format.');
    names = selected.map((_, i) => makeTargetName(prefix, start + i * step, separator, digits));
  } else {
    const ids = normalizeGroupIds(input?.ids);
    const byId = new Map(groups.map((g) => [g.id, g]));
    selected = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!selected.length) throw new Error('No valid groups selected.');

    if (mode === 'list') {
      names = String(input?.names || '').split(/\r?\n/).map(cleanGroupName);
      while (names.length && !names[names.length - 1]) names.pop();
      if (names.length !== selected.length) throw new Error(`Provide exactly ${selected.length} names for ${selected.length} selected groups.`);
    } else {
      const prefix = cleanGroupName(input?.prefix);
      const start = Number(input?.startNumber);
      const step = Number(input?.step || 1);
      const separator = typeof input?.separator === 'string' ? input.separator : ' ';
      const digits = Number(input?.digits || 0);
      if (!prefix) throw new Error('Enter the new group prefix.');
      if (!Number.isInteger(start)) throw new Error('Enter a valid starting number.');
      if (!Number.isInteger(step) || step < 1) throw new Error('Step must be a positive number.');
      if (![0,2,3,4].includes(digits)) throw new Error('Invalid number format.');
      names = selected.map((_, i) => makeTargetName(prefix, start + i * step, separator, digits));
    }
  }

  // Preserve the user's selection order for Select/Name List. Range mode is
  // sorted by the actual existing numeric suffix so numbering is predictable.
  if (mode === 'range') {
    selected = [...selected].sort((a, b) => ((a.num ?? Infinity) - (b.num ?? Infinity)) || a.name.localeCompare(b.name));
    const prefix = cleanGroupName(input?.prefix);
    const start = Number(input?.startNumber);
    const step = Number(input?.step || 1);
    const separator = typeof input?.separator === 'string' ? input.separator : ' ';
    const digits = Number(input?.digits || 0);
    names = selected.map((_, i) => makeTargetName(prefix, start + i * step, separator, digits));
  }

  if (selected.length > GROUP_NAME_MAX) {
    throw new Error(`Please select no more than ${GROUP_NAME_MAX} groups at once.`);
  }

  const seen = new Set();
  for (const name of names) {
    if (!name || name.length > 100) throw new Error('Every group name must be between 1 and 100 characters.');
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate target name: ${name}`);
    seen.add(key);
  }

  const selectedIds = new Set(selected.map((g) => g.id));
  const existing = new Set(groups.filter((g) => !selectedIds.has(g.id)).map((g) => g.name.toLocaleLowerCase()));
  const conflict = names.find((name) => existing.has(name.toLocaleLowerCase()));
  if (conflict) throw new Error(`Target name already exists: ${conflict}`);

  return {
    mode,
    plan: selected.map((g, i) => ({ id: g.id, oldName: g.name, newName: names[i] }))
  };
}

function isGroupNameRateError(error) {
  return /rate|overlimit|429|too many|temporar/i.test(errText(error));
}

function isGroupNameAdminError(error) {
  return /not-authorized|forbidden|403|not admin|not an admin/i.test(errText(error));
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameOneGroup(wa, item) {
  let last = null;
  for (let attempt = 0; attempt <= GROUP_NAME_RETRIES; attempt++) {
    try {
      if (!wa.sock || wa.state !== 'connected') throw new Error('WhatsApp is not connected');
      await wa.sock.groupUpdateSubject(item.id, item.newName);
      const g = wa.groupCache.data?.[item.id];
      if (g) g.subject = item.newName;
      return { ok: true };
    } catch (e) {
      last = e;
      if (!isGroupNameRateError(e) || attempt >= GROUP_NAME_RETRIES || isGroupNameAdminError(e)) break;
      await sleepMs(1500 * (attempt + 1));
    }
  }
  return { ok: false, error: errText(last || 'Rename failed') };
}

async function runGroupNameJob(job, plan, wa) {
  job.state = 'running';
  job.phase = 'renaming';
  job.updated = Date.now();
  job.results = plan.map((x) => ({ ...x, ok: null, error: null }));

  // One mutation at a time is deliberate: concurrent subject updates are a
  // common cause of WhatsApp rate-overlimit responses. A small cooldown keeps
  // the worker fast for normal batches while avoiding bursty traffic.
  for (let i = 0; i < job.results.length; i++) {
    if (job.cancelled) { job.state='cancelled'; job.phase='cancelled'; job.updated=Date.now(); return; }
    const item = job.results[i];
    if (item.oldName === item.newName) {
      item.ok = true;
      item.error = null;
    } else {
      const result = await renameOneGroup(wa, item);
      item.ok = result.ok;
      item.error = result.ok ? null : result.error;
      if (!result.ok && isGroupNameRateError(result.error)) job.phase = 'retrying';
    }
    job.done++;
    job.updated = Date.now();
    if (i + 1 < job.results.length) await sleepMs(GROUP_NAME_DELAY_MS);
    job.phase = 'renaming';
  }

  job.phase = 'done';
  job.state = 'done';
  job.updated = Date.now();
}

app.get('/api/group-names', requireAuth, needWA, async (req, res) => {
  try {
    const wa = getWA(req.user.userId);
    const all = await getGroups(wa, req.query.refresh === '1');
    const groups = Object.values(all)
      .map((g) => {
        const name = cleanGroupName(g.subject || '');
        return { id: g.id, name, num: trailingGroupNumber(name), size: g.size ?? g.participants?.length ?? 0 };
      })
      .sort((a, b) => ((a.num ?? Infinity) - (b.num ?? Infinity)) || a.name.localeCompare(b.name));
    res.json({ groups, maxGroups: GROUP_NAME_MAX });
  } catch (e) {
    res.status(500).json({ error: 'Could not load groups: ' + e.message });
  }
});

app.post('/api/group-names/preview', requireAuth, needWA, async (req, res) => {
  try {
    const wa = getWA(req.user.userId);
    const all = await getGroups(wa);
    const { mode, plan } = buildGroupNamePlan(all, req.body || {});
    res.json({ ok: true, mode, total: plan.length, plan });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not build rename preview' });
  }
});

app.post('/api/group-names', requireAuth, needWA, async (req, res) => {
  try {
    const wa = getWA(req.user.userId);
    const all = await getGroups(wa);
    const { mode, plan } = buildGroupNamePlan(all, req.body || {});
    if (!plan.length) return res.status(400).json({ error: 'No groups matched the request.' });

    const job = {
      id: crypto.randomUUID(),
      userId: req.user.userId,
      state: 'queued',
      phase: 'queued',
      total: plan.length,
      done: 0,
      updated: Date.now(),
      results: [],
      error: null,
      cancelled: false,
      mode
    };

    groupNameJobs.set(job.id, job);
    while (groupNameJobs.size > 30) {
      const first = groupNameJobs.keys().next().value;
      if (!first) break;
      groupNameJobs.delete(first);
    }

    runGroupNameJob(job, plan, wa).catch((e) => {
      job.state = 'error';
      job.phase = 'error';
      job.error = e.message;
      job.updated = Date.now();
    });

    res.json({ ok: true, job: groupNamePublic(job) });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Could not start group rename' });
  }
});

app.get('/api/group-name-job/:id', requireAuth, (req, res) => {
  const job = groupNameJobs.get(req.params.id);
  if (!job || job.userId !== req.user.userId) {
    return res.status(404).json({ error: 'Group name job not found' });
app.post('/api/group-name-job/:id/cancel', requireAuth, (req,res)=>{
  const job=groupNameJobs.get(req.params.id);
  if(!job || job.userId!==req.user.userId) return res.status(404).json({error:'Group name job not found'});
  if(['done','error','cancelled'].includes(job.state)) return res.json({ok:true,job:groupNamePublic(job)});
  job.cancelled=true; job.state='cancelling'; job.phase='cancelling'; job.updated=Date.now();
  res.json({ok:true,job:groupNamePublic(job)});
});

  }
  res.json(groupNamePublic(job));
});


/* ---------- Group Creator ----------
   Uses the CURRENT user's existing WhatsApp socket. It does not create a
   second Baileys connection, so existing Link Organizer, Permissions,
   Group Names and Stats sessions remain untouched.
--------------------------------------------------------------- */
const CREATOR_BATCH_MAX = 25;
const CREATOR_MAX_PER_DAY = 100;
const CREATOR_FIXED_GAP_MS = 5000;
const CREATOR_WARNING_WINDOW_MS = 30 * 1000;
const CREATOR_GROUP_CREATE_TIMEOUT_MS = 45000;
const CREATOR_LINK_RETRY_DELAY_MS = 2500;
const CREATOR_LINK_RECOVERY_ATTEMPTS = 2;
const creatorJobs = new Map();
const creatorLastBatchFinishedAt = new Map();
const creatorLinkQueues = new Map();
const creatorLinkRunning = new Set();
let creatorSaveTimer = null;
function creatorPersistSoon() {
  clearTimeout(creatorSaveTimer);
  creatorSaveTimer = setTimeout(() => { saveData().catch(() => {}); }, 250);
}

function creatorState(userId) {
  const key = String(userId);
  if (!appData.creatorDailyByUser[key] || typeof appData.creatorDailyByUser[key] !== 'object') {
    appData.creatorDailyByUser[key] = {};
  }
  if (!appData.creatorHistoryByUser[key] || !Array.isArray(appData.creatorHistoryByUser[key])) {
    appData.creatorHistoryByUser[key] = [];
  }
  return {
    daily: appData.creatorDailyByUser[key],
    history: appData.creatorHistoryByUser[key]
  };
}

function creatorTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function creatorUsage(userId) {
  const state = creatorState(userId);
  const key = creatorTodayKey();
  const value = Number(state.daily[key] || 0);
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function incrementCreatorUsage(userId, amount = 1) {
  const state = creatorState(userId);
  const key = creatorTodayKey();
  state.daily[key] = creatorUsage(userId) + amount;
  for (const date of Object.keys(state.daily)) {
    if (date !== key) {
      const age = Date.now() - new Date(`${date}T00:00:00Z`).getTime();
      if (age > 8 * 24 * 60 * 60 * 1000) delete state.daily[date];
    }
  }
  creatorPersistSoon();
}

function creatorErrorText(e) {
  return String(e?.message || e?.data || e || 'unknown error');
}

function creatorCleanPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function creatorUniqueMembers(input) {
  const seen = new Set();
  const valid = [];
  let invalid = 0;
  let duplicate = 0;

  for (const raw of input) {
    const n = creatorCleanPhone(raw);
    if (!n) { invalid++; continue; }
    if (seen.has(n)) { duplicate++; continue; }
    seen.add(n);
    valid.push(n);
  }
  return { valid, invalid, duplicate };
}

function creatorConnectedNumber(wa) {
  const raw = wa?.sock?.user?.id;
  if (!raw) return null;
  return creatorCleanPhone(String(raw).split(':')[0]);
}

function creatorBuildNames(prefix, start, amount) {
  const p = String(prefix || '').trim();
  return Array.from({ length: amount }, (_, i) => `${p} ${start + i}`.trim());
}

function creatorPublicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    prefix: job.prefix,
    start: job.start,
    requested: job.requested,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    pending: Math.max(0, job.total - job.completed - job.failed),
    paused: job.paused,
    cancelled: job.cancelled,
    running: job.running,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    current: job.current,
    results: job.results,
    validation: job.validation,
    accountNumber: job.accountNumber
  };
}

function creatorRecentWarning(userId) {
  const last = creatorLastBatchFinishedAt.get(String(userId)) || 0;
  if (!last) return null;
  const elapsed = Date.now() - last;
  if (elapsed >= CREATOR_WARNING_WINDOW_MS) return null;
  const seconds = Math.max(1, Math.ceil((CREATOR_WARNING_WINDOW_MS - elapsed) / 1000));
  return `Previous batch just finished. For smoother operation, try again after about ${seconds} seconds. You can still create this batch now.`;
}

function creatorAddHistory(userId, job) {
  const state = creatorState(userId);
  state.history.unshift({
    id: job.id,
    accountNumber: job.accountNumber,
    prefix: job.prefix,
    start: job.start,
    requested: job.requested,
    total: job.total,
    members: job.members,
    delay: job.delay,
    completed: job.completed,
    failed: job.failed,
    results: job.results,
    running: false,
    paused: false,
    cancelled: job.cancelled,
    current: null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    validation: job.validation
  });
  state.history.splice(50);
  creatorPersistSoon();
}

function creatorEnqueueLinkRecovery(userId, job, result) {
  if (!result?.id || result.link) return;
  const key = String(userId);
  if (!creatorLinkQueues.has(key)) creatorLinkQueues.set(key, []);
  creatorLinkQueues.get(key).push({ job, result, attempts: 0, nextAt: Date.now() + CREATOR_LINK_RETRY_DELAY_MS });
  creatorProcessLinkRecovery(key).catch(() => {});
}

async function creatorProcessLinkRecovery(userId) {
  const key = String(userId);
  if (creatorLinkRunning.has(key)) return;
  creatorLinkRunning.add(key);
  try {
    const queue = creatorLinkQueues.get(key) || [];
    while (queue.length) {
      const item = queue[0];
      const wait = item.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      queue.shift();
      if (item.result.link) continue;
      const wa = getWA(key);
      if (wa.state !== 'connected' || !wa.sock) {
        item.nextAt = Date.now() + 5000;
        queue.push(item);
        continue;
      }
      item.attempts++;
      try {
        const code = await wa.sock.groupInviteCode(item.result.id);
        if (code) {
          item.result.link = `https://chat.whatsapp.com/${code}`;
          item.result.linkAvailable = true;
          item.result.linkPending = false;
          item.result.linkError = null;
          creatorPersistSoon();
          continue;
        }
      } catch (e) {
        item.result.linkError = creatorErrorText(e);
      }
      if (item.attempts < CREATOR_LINK_RECOVERY_ATTEMPTS) {
        item.nextAt = Date.now() + (item.attempts === 1 ? 5000 : 10000);
        queue.push(item);
      } else {
        item.result.linkPending = false;
        item.result.linkAvailable = false;
        creatorPersistSoon();
      }
    }
  } finally {
    creatorLinkRunning.delete(key);
    if (creatorLinkQueues.get(key)?.length) creatorProcessLinkRecovery(key).catch(() => {});
  }
}

async function creatorWithTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

async function creatorCreateOne(userId, job, name, index) {
  const wa = getWA(userId);
  if (job.cancelled) throw new Error('Job cancelled.');
  if (!wa.sock || wa.state !== 'connected') throw new Error('WhatsApp is no longer connected.');

  const jidList = job.members.map((n) => `${n}@s.whatsapp.net`);
  const group = await creatorWithTimeout(
    wa.sock.groupCreate(name, jidList),
    CREATOR_GROUP_CREATE_TIMEOUT_MS,
    `Group creation timed out after ${CREATOR_GROUP_CREATE_TIMEOUT_MS / 1000}s.`
  );

  let link = '';
  try {
    const code = await wa.sock.groupInviteCode(group.id);
    link = code ? `https://chat.whatsapp.com/${code}` : '';
  } catch {}

  const result = {
    index,
    name,
    id: group.id,
    link,
    linkAvailable: Boolean(link),
    linkPending: !link,
    status: 'success',
    createdAt: new Date().toISOString()
  };

  if (!link) creatorEnqueueLinkRecovery(userId, job, result);
  return result;
}

async function creatorWaitBetween(job, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (job.cancelled) return;
    while (job.paused && !job.cancelled) await sleep(250);
    if (job.cancelled) return;
    await sleep(Math.min(250, Math.max(50, end - Date.now())));
  }
}

async function creatorRunJob(userId, job) {
  job.running = true;
  job.startedAt = new Date().toISOString();
  creatorPersistSoon();

  for (let i = 0; i < job.names.length; i++) {
    if (job.cancelled) break;
    while (job.paused && !job.cancelled) await sleep(250);
    if (job.cancelled) break;

    const name = job.names[i];
    job.current = { index: i + 1, name };
    try {
      const result = await creatorCreateOne(userId, job, name, i + 1);
      job.results.push(result);
      job.completed++;
      incrementCreatorUsage(userId, 1);
    } catch (e) {
      job.results.push({ index: i + 1, name, status: 'failed', error: creatorErrorText(e), createdAt: new Date().toISOString() });
      job.failed++;
    }
    creatorPersistSoon();
    if (i < job.names.length - 1 && !job.cancelled) await creatorWaitBetween(job, CREATOR_FIXED_GAP_MS);
  }

  job.current = null;
  job.running = false;
  job.finishedAt = new Date().toISOString();
  creatorAddHistory(userId, job);
  creatorLastBatchFinishedAt.set(String(userId), Date.now());
  creatorJobs.delete(String(userId));
}

function creatorStartJob(userId, payload) {
  const key = String(userId);
  const wa = getWA(key);
  if (wa.state !== 'connected' || !wa.sock) throw new Error('WhatsApp is not connected.');
  if (creatorJobs.has(key)) throw new Error('Another group creation job is already active.');

  const accountNumber = creatorConnectedNumber(wa);
  if (!accountNumber) throw new Error('Unable to identify the connected WhatsApp account. Please reconnect WhatsApp.');

  const prefix = String(payload?.prefix ?? '').trim();
  const start = Number.parseInt(payload?.start, 10);
  const rawAmount = Number.parseInt(payload?.amount, 10);
  if (!prefix) throw new Error('Please enter a group prefix.');
  if (!Number.isInteger(start) || start < 0) throw new Error('Please enter a valid starting number.');
  if (!Number.isInteger(rawAmount) || rawAmount < 1 || rawAmount > CREATOR_BATCH_MAX) throw new Error(`One batch can contain maximum ${CREATOR_BATCH_MAX} groups.`);

  const membersRaw = Array.isArray(payload?.members) ? payload.members : String(payload?.members || '').split(/\r?\n/);
  const cleanedInput = membersRaw.map((v) => String(v).trim()).filter(Boolean);
  let members = creatorUniqueMembers(cleanedInput);
  let usedConnectedNumber = false;
  if (!members.valid.length && cleanedInput.length === 0) {
    members = { valid: [accountNumber], invalid: 0, duplicate: 0 };
    usedConnectedNumber = true;
  }
  if (!members.valid.length) throw new Error('Please enter at least one valid member number.');

  const createdToday = creatorUsage(key);
  const remaining = CREATOR_MAX_PER_DAY - createdToday;
  if (remaining <= 0) throw new Error(`Daily limit reached for +${accountNumber}. This WhatsApp account has already created ${CREATOR_MAX_PER_DAY}/${CREATOR_MAX_PER_DAY} groups today.`);
  if (rawAmount > remaining) throw new Error(`Only ${remaining} group creation slot${remaining === 1 ? '' : 's'} remain today for +${accountNumber}.`);

  const names = creatorBuildNames(prefix, start, rawAmount);
  const job = {
    id: `JOB-${Date.now().toString(36).toUpperCase()}`,
    userId: key,
    accountNumber,
    prefix,
    start,
    requested: rawAmount,
    total: rawAmount,
    names,
    members: members.valid,
    delay: CREATOR_FIXED_GAP_MS / 1000,
    completed: 0,
    failed: 0,
    results: [],
    running: false,
    paused: false,
    cancelled: false,
    current: null,
    startedAt: null,
    finishedAt: null,
    validation: {
      validMembers: members.valid.length,
      invalidMembers: members.invalid,
      duplicateMembers: members.duplicate,
      effectiveAmount: rawAmount,
      batchMax: CREATOR_BATCH_MAX,
      fixedGapSeconds: CREATOR_FIXED_GAP_MS / 1000,
      usedConnectedNumber,
      accountNumber,
      dailyUsedBefore: createdToday,
      dailyRemainingBefore: remaining
    }
  };
  creatorJobs.set(key, job);
  return job;
}

app.get('/api/group-creator/status', requireAuth, (req, res) => {
  const key = String(req.user.userId);
  const wa = getWA(key);
  const state = creatorState(key);
  res.json({
    state: wa.state,
    accountNumber: creatorConnectedNumber(wa),
    createdToday: creatorUsage(key),
    maxPerDay: CREATOR_MAX_PER_DAY,
    batchMax: CREATOR_BATCH_MAX,
    fixedGap: CREATOR_FIXED_GAP_MS / 1000,
    job: creatorPublicJob(creatorJobs.get(key)),
    history: state.history.slice(0, 20)
  });
});

app.post('/api/group-creator/create', requireAuth, needWA, (req, res) => {
  try {
    const key = String(req.user.userId);
    const job = creatorStartJob(key, req.body || {});
    const warning = creatorRecentWarning(key);
    res.json({ ok: true, job: creatorPublicJob(job), validation: job.validation, warning });
    creatorRunJob(key, job).catch((e) => {
      job.running = false;
      job.finishedAt = new Date().toISOString();
      job.failed++;
      job.results.push({ index: job.results.length + 1, name: job.current?.name || 'Unknown', status: 'failed', error: creatorErrorText(e), createdAt: new Date().toISOString() });
      creatorAddHistory(key, job);
      creatorJobs.delete(key);
    });
  } catch (e) {
    res.status(400).json({ error: creatorErrorText(e) });
  }
});

app.post('/api/group-creator/link/retry', requireAuth, needWA, async (req, res) => {
  const key = String(req.user.userId);
  const jobId = String(req.body?.jobId || '');
  const index = Number.parseInt(req.body?.index, 10);
  const history = creatorState(key).history;
  const job = history.find((j) => j.id === jobId);
  if (!job) return res.status(404).json({ error: 'The requested batch was not found.' });
  const result = (job.results || []).find((r) => Number(r.index) === index);
  if (!result) return res.status(404).json({ error: 'The requested group result was not found.' });
  if (result.link) return res.json({ ok: true, result });
  try {
    const wa = getWA(key);
    const code = await wa.sock.groupInviteCode(result.id);
    if (!code) return res.status(503).json({ error: 'WhatsApp did not return an invite link yet. Please try again shortly.' });
    result.link = `https://chat.whatsapp.com/${code}`;
    result.linkAvailable = true;
    result.linkPending = false;
    result.linkError = null;
    await saveData();
    res.json({ ok: true, result });
  } catch (e) {
    res.status(503).json({ error: `Invite-link retry failed: ${creatorErrorText(e)}` });
  }
});

app.post('/api/group-creator/job/pause', requireAuth, (req, res) => {
  const job = creatorJobs.get(String(req.user.userId));
  if (!job) return res.status(404).json({ error: 'No active job.' });
  job.paused = true;
  res.json({ ok: true });
});

app.post('/api/group-creator/job/resume', requireAuth, (req, res) => {
  const job = creatorJobs.get(String(req.user.userId));
  if (!job) return res.status(404).json({ error: 'No active job.' });
  job.paused = false;
  res.json({ ok: true });
});

app.post('/api/group-creator/job/cancel', requireAuth, (req, res) => {
  const job = creatorJobs.get(String(req.user.userId));
  if (!job) return res.status(404).json({ error: 'No active job.' });
  job.cancelled = true;
  job.paused = false;
  res.json({ ok: true });
});

app.post('/api/group-creator/job/retry', requireAuth, needWA, (req, res) => {
  try {
    const key = String(req.user.userId);
    if (creatorJobs.has(key)) return res.status(409).json({ error: 'Another group creation job is already active.' });
    const id = String(req.body?.id || '');
    const old = creatorState(key).history.find((j) => j.id === id);
    if (!old) return res.status(404).json({ error: 'The requested batch was not found.' });
    const failed = (old.results || []).filter((r) => r.status === 'failed').map((r) => r.name);
    if (!failed.length) return res.status(400).json({ error: 'This job has no failed groups to retry.' });

    const wa = getWA(key);
    const accountNumber = creatorConnectedNumber(wa);
    if (!accountNumber || accountNumber !== old.accountNumber) return res.status(409).json({ error: 'Reconnect the same WhatsApp account that created this batch before retrying it.' });

    const remaining = CREATOR_MAX_PER_DAY - creatorUsage(key);
    if (remaining <= 0) return res.status(400).json({ error: `Daily limit reached for +${accountNumber}.` });
    const names = failed.slice(0, Math.min(CREATOR_BATCH_MAX, remaining));
    const job = {
      id: `RETRY-${Date.now().toString(36).toUpperCase()}`,
      userId: key,
      accountNumber,
      prefix: old.prefix,
      start: old.start,
      requested: names.length,
      total: names.length,
      names,
      members: old.members,
      delay: CREATOR_FIXED_GAP_MS / 1000,
      completed: 0,
      failed: 0,
      results: [],
      running: false,
      paused: false,
      cancelled: false,
      current: null,
      startedAt: null,
      finishedAt: null,
      validation: { retryOf: old.id, batchMax: CREATOR_BATCH_MAX, fixedGapSeconds: CREATOR_FIXED_GAP_MS / 1000, accountNumber }
    };
    creatorJobs.set(key, job);
    res.json({ ok: true, job: creatorPublicJob(job) });
    creatorRunJob(key, job).catch(() => {});
  } catch (e) {
    res.status(400).json({ error: creatorErrorText(e) });
  }
});

/* ---------- Link jobs ---------- */

const errText = (e) => String(e?.message || e?.data || e || 'unknown error');
const isAdminErr = (m) => /not-authorized|forbidden|403/i.test(m);
const isRateErr = (m) => /rate|overlimit|429/i.test(m);
const jobs = new Map();

async function tryCode(wa, it, fresh = false) {
  if (!fresh) {
    const local = wa.codeCache.get(it.id);

    if (local?.code) {
      return { code: local.code };
    }

    if (appData.codes[it.id]) {
      return { code: appData.codes[it.id] };
    }
  }

  if (wa.codeInflight.has(it.id)) {
    return wa.codeInflight.get(it.id);
  }

  const promise = withWALinkLimit(wa, async () => {
    try {
      if (!wa.sock || wa.state !== 'connected') {
        return {
          err: 'WhatsApp is not connected',
          kind: 'other'
        };
      }

      const code = await wa.sock.groupInviteCode(it.id);

      if (code) {
        wa.codeCache.set(it.id, {
          code,
          at: Date.now()
        });

        return { code };
      }

      return {
        err: 'empty response from WhatsApp',
        kind: 'other'
      };

    } catch (e) {
      const m = errText(e);

      return {
        err: m,
        kind:
          isAdminErr(m)
            ? 'admin'
            : isRateErr(m)
              ? 'rate'
              : 'other'
      };
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

  const codes =
    appData.codesByUser[job.userId] || {};

  appData.codesByUser[job.userId] = codes;

  const todo = [];

  // -----------------------------------------
  // CACHE / MISSING GROUP FILTER
  // -----------------------------------------

  items.forEach((it, i) => {
    if (!it.id) {
      out[i] = bad(it, 'Group not found');
      job.done++;
      return;
    }

    if (!fresh && codes[it.id]) {
      out[i] = ok(it, codes[it.id]);
      job.done++;
      return;
    }

    todo.push(i);
  });

  // -----------------------------------------
  // CONTINUOUS WORKER QUEUE
  // -----------------------------------------

  const concurrency = Math.min(
    12,
    Math.max(
      8,
      Number(process.env.MAX_WA_LINK_REQUESTS || 12)
    )
  );

  let nextIndex = 0;

  const retry = [];

  async function worker() {
    while (true) {
      if (job.cancelled) return;
      const index = nextIndex++;

      if (index >= todo.length) {
        return;
      }

      const i = todo[index];
      const it = items[i];

      const r = await tryCode(
        wa,
        it,
        fresh
      );

      if (r.code) {
        codes[it.id] = r.code;

        out[i] = ok(
          it,
          r.code
        );

        job.done++;

        continue;
      }

      if (r.kind === 'admin') {
        out[i] = bad(
          it,
          'You are not an admin of this group'
        );

        job.done++;

        continue;
      }

      retry.push(i);
    }
  }

  // IMPORTANT:
  // Workers continuously pick the next group.
  // There is no 8-group batch waiting anymore.

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          concurrency,
          todo.length
        )
      },
      () => worker()
    )
  );

  // -----------------------------------------
  // RETRIES
  // -----------------------------------------

  if (retry.length) {
    let retryIndex = 0;

    const retryConcurrency = Math.min(
      4,
      retry.length
    );

    async function retryWorker() {
      while (true) {
        if (job.cancelled) return;
        const index = retryIndex++;

        if (index >= retry.length) {
          return;
        }

        const i = retry[index];
        const it = items[i];

        let result = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
          // Small adaptive delay.
          // Rate-limit errors get a little more time.
          const delay =
            attempt === 1
              ? 500
              : attempt === 2
                ? 1000
                : 1800;

          await sleep(delay);

          result = await tryCode(
            wa,
            it,
            fresh
          );

          if (
            result.code ||
            result.kind === 'admin'
          ) {
            break;
          }

          if (result.kind === 'rate') {
            await sleep(1500 * attempt);
          }
        }

        if (result?.code) {
          codes[it.id] = result.code;

          out[i] = ok(
            it,
            result.code
          );

        } else if (
          result?.kind === 'admin'
        ) {
          out[i] = bad(
            it,
            'You are not an admin of this group'
          );

        } else if (
          result?.kind === 'rate'
        ) {
          out[i] = bad(
            it,
            'WhatsApp is rate limiting requests right now. Retry failed groups after a short wait'
          );

        } else {
          out[i] = bad(
            it,
            `Could not get link (${result?.err || 'unknown error'})`
          );
        }

        job.done++;
      }
    }

    await Promise.all(
      Array.from(
        {
          length: retryConcurrency
        },
        () => retryWorker()
      )
    );
  }

  // -----------------------------------------
  // SAVE ONCE AT THE END
  // -----------------------------------------

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
      cancelled: false,
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


app.post('/api/job/:id/cancel', requireAuth, (req,res)=>{
  const job=jobs.get(req.params.id);
  if(!job || job.userId!==req.user.userId) return res.status(404).json({error:'Job not found'});
  if(job.finished) return res.json({ok:true,job});
  job.cancelled=true; job.error=null;
  res.json({ok:true,job});
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
    wa.manualStop = true;

    const current = wa.sock;
    wa.sock = null;
    wa.state = 'idle';
    wa.qrDataUrl = null;
    wa.groupCache = { at: 0, data: null };
    wa.codeCache.clear();
    wa.codeInflight.clear();

    if (current) {
      try { await current.logout(); } catch {}
      try { current.end(undefined); } catch {}
    }

    await clearWAAuth(wa);
    wa.reconnectDelay = 2000;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Could not disconnect WhatsApp: ' + e.message });
  }
});

/* ---------- Live group stats ---------- */

registerStatsRoutes(app, requireAuth, needWA, getStats);


/* ---------- Dashboard / Page Routes ---------- */

app.get('/', (req, res) => {
  res.sendFile('dashboard.html', { root: 'public' });
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile('dashboard.html', { root: 'public' });
});

app.get('/link-organizer.html', (req, res) => {
  res.sendFile('link-organizer.html', { root: 'public' });
});

app.get('/group-dp.html', (req, res) => {
  res.sendFile('group-dp.html', { root: 'public' });
});

app.get('/member-remover.html', (req, res) => { res.sendFile('member-remover.html', { root: 'public' }); });

app.get('/group-description.html', (req, res) => {
  res.sendFile('group-description.html', { root: 'public' });
});

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