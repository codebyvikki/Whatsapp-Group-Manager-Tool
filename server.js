import express from 'express';
import crypto from 'crypto';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const PORT = process.env.PORT || 3000;
const PANEL_USER = process.env.PANEL_USER || 'admin';
const PANEL_PASS = process.env.PANEL_PASS || 'change-me';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let groupCache = { at: 0, data: null };
async function getGroups() {
  if (groupCache.data && Date.now() - groupCache.at < 5 * 60 * 1000) return groupCache.data;
  groupCache = { at: Date.now(), data: await sock.groupFetchAllParticipating() };
  return groupCache.data;
}

/* ---------- WhatsApp connection ---------- */
let sock = null;
let state = 'starting'; // starting | qr | connected | closed
let qrDataUrl = null;

async function startWA() {
  const { state: auth, saveCreds } = await useMultiFileAuthState('./auth');
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
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        state = 'closed';
        const fs = await import('fs');
        fs.rmSync('./auth', { recursive: true, force: true });
      } else {
        state = 'starting';
      }
      setTimeout(startWA, 2000);
    }
  });
}
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
  sessions.has(getCookie(req, 'sid')) ? next() : res.status(401).json({ error: 'login required' });

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === PANEL_USER && pass === PANEL_PASS) {
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Galat user ya password' });
});

app.get('/api/me', (req, res) => res.json({ loggedIn: sessions.has(getCookie(req, 'sid')) }));
app.get('/api/status', authed, (req, res) => res.json({ state, qr: qrDataUrl }));

/* ---------- Link organizer ---------- */
app.post('/api/links', authed, async (req, res) => {
  if (state !== 'connected') return res.status(400).json({ error: 'WhatsApp connect nahi hai' });
  const { prefix = '', from, to } = req.body || {};
  const a = parseInt(from, 10), b = parseInt(to, 10);
  if (!prefix.trim() || isNaN(a) || isNaN(b) || a > b)
    return res.status(400).json({ error: 'Prefix aur number range sahi daalo' });

  try {
    const all = await getGroups();
    const wanted = new Map(); // number -> {id, name}
    for (const g of Object.values(all)) {
      const name = (g.subject || '').trim();
      if (!name.startsWith(prefix.trim())) continue;
      const rest = name.slice(prefix.trim().length).trim();
      if (!/^\d+$/.test(rest)) continue;
      const n = parseInt(rest, 10);
      if (n >= a && n <= b) wanted.set(n, { id: g.id, name });
    }

    const nums = [];
    for (let n = a; n <= b; n++) nums.push(n);
    const results = [];
    const BATCH = 5;
    for (let i = 0; i < nums.length; i += BATCH) {
      const part = await Promise.all(
        nums.slice(i, i + BATCH).map(async (n) => {
          const g = wanted.get(n);
          if (!g) return { n, name: `${prefix.trim()}${n}`, link: null, note: 'group nahi mila' };
          try {
            const code = await sock.groupInviteCode(g.id);
            return { n, name: g.name, link: `https://chat.whatsapp.com/${code}` };
          } catch {
            return { n, name: g.name, link: null, note: 'link nahi mila (admin nahi ho)' };
          }
        })
      );
      results.push(...part);
      await sleep(400);
    }
    const text = results.filter((r) => r.link).map((r) => `${r.name}\n${r.link}`).join('\n\n');
    res.json({ results, text });
  } catch (e) {
    res.status(500).json({ error: 'Groups fetch nahi ho paye: ' + e.message });
  }
});

app.post('/api/logout-wa', authed, async (req, res) => {
  try { await sock.logout(); } catch {}
  res.json({ ok: true });
});

app.use(express.static('public'));
app.listen(PORT, () => console.log('Running on ' + PORT));
