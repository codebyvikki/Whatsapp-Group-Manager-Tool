import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import { MongoClient } from 'mongodb';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  BufferJSON,
  initAuthCreds,
  proto
} from '@whiskeysockets/baileys';

const PORT = process.env.PORT || 3000;
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'change-me';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Helpers ---------- */
const numOf = (name) => {
  const m = (name || '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : Infinity;
};
const byNum = (a, b) => (a.num - b.num) || a.name.localeCompare(b.name);

/* ---------- Storage (MongoDB if MONGODB_URI is set, otherwise local file) ---------- */
let db = null;
async function getDb() {
  if (!process.env.MONGODB_URI) return null;
  if (db) return db;
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('wa_link_organizer');
  return db;
}
const getAuthCol = async () => (await getDb())?.collection('auth') || null;

async function useMongoAuthState(col) {
  const write = (data, id) =>
    col.replaceOne({ _id: id }, { _id: id, v: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true });
  const read = async (id) => {
    const d = await col.findOne({ _id: id });
    return d ? JSON.parse(d.v, BufferJSON.reviver) : null;
  };
  const remove = (id) => col.deleteOne({ _id: id });
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let v = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            data[id] = v;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const cat in data)
            for (const id in data[cat]) {
              const v = data[cat][id];
              tasks.push(v ? write(v, `${cat}-${id}`) : remove(`${cat}-${id}`));
            }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => write(creds, 'creds')
  };
}

/* Saved lists: [{ name, ids: [] }] and cached invite codes */
const DATA_FILE = './data.json';
let appData = { lists: [], codes: {} };
async function loadData() {
  try {
    const d = await getDb();
    if (d) {
      const doc = await d.collection('data').findOne({ _id: 'appdata' });
      if (doc) appData = { lists: doc.lists || [], codes: doc.codes || {} };
    } else if (fs.existsSync(DATA_FILE)) {
      const j = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      appData = { lists: j.lists || [], codes: j.codes || {} };
    }
  } catch (e) { console.log('loadData error', e.message); }
}
async function saveData() {
  try {
    const d = await getDb();
    if (d) await d.collection('data').replaceOne({ _id: 'appdata' }, { _id: 'appdata', lists: appData.lists, codes: appData.codes }, { upsert: true });
    else fs.writeFileSync(DATA_FILE, JSON.stringify({ lists: appData.lists, codes: appData.codes }, null, 2));
  } catch (e) { console.log('saveData error', e.message); }
}

/* ---------- WhatsApp connection ---------- */
let sock = null;
let state = 'starting'; // starting | qr | connected | closed
let qrDataUrl = null;

let groupCache = { at: 0, data: null };
async function getGroups(force = false) {
  if (!force && groupCache.data && Date.now() - groupCache.at < 10 * 60 * 1000) return groupCache.data;
  groupCache = { at: Date.now(), data: await sock.groupFetchAllParticipating() };
  return groupCache.data;
}

async function startWA() {
  const col = await getAuthCol();
  const { state: auth, saveCreds } = col
    ? await useMongoAuthState(col)
    : await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth,
    logger: pino({ level: 'silent' }),
    browser: ['Link Organizer', 'Chrome', '1.0']
  });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      state = 'qr';
      qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
    }
    if (connection === 'open') {
      state = 'connected';
      qrDataUrl = null;
      getGroups(true).catch(() => {}); // preload the group list
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        state = 'closed';
        const col2 = await getAuthCol();
        if (col2) await col2.deleteMany({});
        else fs.rmSync('./auth', { recursive: true, force: true });
      } else {
        state = 'starting';
      }
      setTimeout(startWA, 2000);
    }
  });
}
await loadData();
startWA();

/* ---------- Panel login (in-memory sessions) ---------- */
const sessions = new Set();
const app = express();
app.use(express.json());

function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
const authed = (req, res, next) =>
  sessions.has(getCookie(req, 'sid')) ? next() : res.status(401).json({ error: 'Login required' });
const needWA = (req, res, next) =>
  state === 'connected' ? next() : res.status(400).json({ error: 'WhatsApp is not connected' });

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === PANEL_USER && pass === PANEL_PASS) {
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Incorrect username or password' });
});

app.get('/api/me', (req, res) => res.json({ loggedIn: sessions.has(getCookie(req, 'sid')) }));
app.get('/api/status', authed, (req, res) => res.json({ state, qr: qrDataUrl }));

/* ---------- Groups list ---------- */
app.get('/api/groups', authed, needWA, async (req, res) => {
  try {
    const all = await getGroups(req.query.refresh === '1');
    const groups = Object.values(all)
      .map((g) => {
        const name = (g.subject || '').trim();
        return { id: g.id, name, num: numOf(name), size: g.size ?? g.participants?.length ?? 0 };
      })
      .sort(byNum);
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: 'Could not load groups: ' + e.message });
  }
});

/* ---------- Fetching links (cache + background job + smart retry) ---------- */
const errText = (e) => String(e?.message || e?.data || e || 'unknown error');
const isAdminErr = (m) => /not-authorized|forbidden|403/i.test(m);
const isRateErr = (m) => /rate|overlimit|429/i.test(m);

async function tryCode(it) {
  try {
    const code = await sock.groupInviteCode(it.id);
    return code ? { code } : { err: 'empty response from WhatsApp', kind: 'other' };
  } catch (e) {
    const m = errText(e);
    console.log(`[link] ${it.name}:`, m);
    return { err: m, kind: isAdminErr(m) ? 'admin' : isRateErr(m) ? 'rate' : 'other' };
  }
}

const ok = (it, code) => ({ id: it.id, n: it.num, name: it.name, link: `https://chat.whatsapp.com/${code}` });
const bad = (it, note) => ({ id: it.id, n: it.num, name: it.name, link: null, note });
const jobs = new Map();

async function runJob(job, items, fresh) {
  const out = job.results;
  const codes = appData.codes;
  const todo = [];

  items.forEach((it, i) => {
    if (!it.id) { out[i] = bad(it, 'Group not found'); job.done++; }
    else if (!fresh && codes[it.id]) { out[i] = ok(it, codes[it.id]); job.done++; }
    else todo.push(i);
  });

  // Pass 1: fast (5 at a time)
  const retry = [];
  for (let s = 0; s < todo.length; s += 5) {
    await Promise.all(todo.slice(s, s + 5).map(async (i) => {
      const it = items[i];
      const r = await tryCode(it);
      if (r.code) { codes[it.id] = r.code; out[i] = ok(it, r.code); job.done++; }
      else if (r.kind === 'admin') { out[i] = bad(it, 'You are not an admin of this group'); job.done++; }
      else retry.push(i);
    }));
    await sleep(250);
  }

  // Pass 2: only the failed ones, slower and more carefully
  retry.sort((x, y) => x - y);
  for (const i of retry) {
    const it = items[i];
    let r = null;
    for (let a = 1; a <= 4; a++) {
      await sleep(1200 * a);
      r = await tryCode(it);
      if (r.code || r.kind === 'admin') break;
    }
    if (r.code) { codes[it.id] = r.code; out[i] = ok(it, r.code); }
    else if (r.kind === 'admin') out[i] = bad(it, 'You are not an admin of this group');
    else if (r.kind === 'rate') out[i] = bad(it, 'WhatsApp is rate limiting requests right now. Wait 1-2 minutes, then click "Retry Failed Groups"');
    else out[i] = bad(it, `Could not get link (${r.err})`);
    job.done++;
  }
  await saveData();
}

app.post('/api/links', authed, needWA, async (req, res) => {
  const { prefix = '', from, to, ids, fresh } = req.body || {};
  try {
    const all = await getGroups();
    let items = [];

    if (Array.isArray(ids)) {
      if (!ids.length) return res.status(400).json({ error: 'No groups selected' });
      items = ids
        .map((id) => all[id]
          ? { id, name: (all[id].subject || '').trim(), num: numOf(all[id].subject) }
          : { id: null, name: 'Group no longer available', num: Infinity })
        .sort(byNum);
    } else {
      const a = parseInt(from, 10), b = parseInt(to, 10);
      const p = prefix.trim();
      if (!p || isNaN(a) || isNaN(b) || a > b)
        return res.status(400).json({ error: 'Enter a valid prefix and number range' });
      const wanted = new Map();
      for (const g of Object.values(all)) {
        const name = (g.subject || '').trim();
        if (!name.startsWith(p)) continue;
        const rest = name.slice(p.length).trim();
        if (!/^\d+$/.test(rest)) continue;
        const n = parseInt(rest, 10);
        if (n >= a && n <= b) wanted.set(n, { id: g.id, name, num: n });
      }
      for (let n = a; n <= b; n++) items.push(wanted.get(n) || { id: null, name: `${p}${n}`, num: n });
    }

    const job = { id: crypto.randomBytes(6).toString('hex'), total: items.length, done: 0, results: [], finished: false, error: null };
    jobs.set(job.id, job);
    setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000);
    runJob(job, items, !!fresh)
      .catch((e) => { job.error = 'Could not fetch links: ' + e.message; })
      .finally(() => { job.finished = true; });
    res.json({ jobId: job.id });
  } catch (e) {
    res.status(500).json({ error: 'Could not fetch links: ' + e.message });
  }
});

app.get('/api/job/:id', authed, (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found, please try again' });
  res.json({ done: j.done, total: j.total, finished: j.finished, error: j.error, results: j.results.filter(Boolean) });
});

/* ---------- Saved lists ---------- */
app.get('/api/lists', authed, (req, res) => res.json({ lists: appData.lists }));

app.post('/api/lists', authed, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!name || !ids.length) return res.status(400).json({ error: 'A list name and at least one group are required' });
  const i = appData.lists.findIndex((l) => l.name === name);
  if (i >= 0) appData.lists[i].ids = ids; else appData.lists.push({ name, ids });
  await saveData();
  res.json({ lists: appData.lists });
});

app.post('/api/lists/rename', authed, async (req, res) => {
  const from = String(req.body?.from || ''), to = String(req.body?.to || '').trim();
  if (!to) return res.status(400).json({ error: 'Enter a new name' });
  if (appData.lists.some((l) => l.name === to)) return res.status(400).json({ error: 'A list with this name already exists' });
  const l = appData.lists.find((x) => x.name === from);
  if (l) l.name = to;
  await saveData();
  res.json({ lists: appData.lists });
});

app.post('/api/lists/delete', authed, async (req, res) => {
  appData.lists = appData.lists.filter((l) => l.name !== req.body?.name);
  await saveData();
  res.json({ lists: appData.lists });
});

app.post('/api/logout-wa', authed, async (req, res) => {
  try { await sock.logout(); } catch {}
  res.json({ ok: true });
});

app.use(express.static('public'));
app.listen(PORT, () => console.log('Running on ' + PORT));