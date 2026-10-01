import fs from 'fs';

/* =========================================================
   LIVE GROUP STATS
   - Pending join requests: read straight from WhatsApp (accurate at any time)
   - Joined via link / added by member / left / removed: recorded live from
     WhatsApp events, so they are accurate from the moment tracking starts
     (WhatsApp does not expose this history for the past).
   - A baseline snapshot is stored per group the first time it is seen.
========================================================= */

const FILE = './stats.json';
const EVENT_CAP = 8000;
const TZ = process.env.STATS_TZ || 'Asia/Kolkata';

const norm = (j) => String(j || '').split('@')[0].split(':')[0];
const jidOf = (x) => (typeof x === 'string' ? x : x?.id || x?.jid || x?.phoneNumber || '');
const isPN = (j) => /@s\.whatsapp\.net$/.test(j || '');
const fmtTime = (t) => t
  ? new Date(t).toLocaleString('en-GB', { timeZone: TZ, hour12: false }).replace(',', '')
  : '';
const trailingNum = (name) => {
  const m = String(name || '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : Infinity;
};

export function createStats(ctx) {
  const { getDb, getSock, getGroupCache, withLimit, sleep, refreshGroups } = ctx;

  const recs = new Map();
  const dirty = new Set();
  const clients = new Set();
  const changed = new Set();
  const refresh = { running: false, done: 0, total: 0, at: 0 };
  let saveTimer = null;
  let castTimer = null;

  /* ---------------- persistence ---------------- */

  async function load() {
    try {
      const d = await getDb();
      if (d) {
        for (const doc of await d.collection('gstats').find({}).toArray()) recs.set(doc._id, doc);
      } else if (fs.existsSync(FILE)) {
        const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        for (const r of Object.values(j)) recs.set(r._id, r);
      }
    } catch (e) {
      console.error('[stats] load:', e.message);
    }
  }

  async function flush() {
    saveTimer = null;
    const ids = [...dirty].filter((i) => recs.has(i));
    dirty.clear();
    if (!ids.length) return;
    try {
      const d = await getDb();
      if (d) {
        await d.collection('gstats').bulkWrite(ids.map((i) => ({
          replaceOne: { filter: { _id: i }, replacement: recs.get(i), upsert: true }
        })));
      } else {
        const out = {};
        for (const [k, v] of recs) out[k] = v;
        fs.writeFileSync(FILE + '.tmp', JSON.stringify(out));
        fs.renameSync(FILE + '.tmp', FILE);
      }
    } catch (e) {
      console.error('[stats] save:', e.message);
      ids.forEach((i) => dirty.add(i));
    }
  }

  function touch(id) {
    dirty.add(id);
    changed.add(id);
    if (!saveTimer) saveTimer = setTimeout(flush, 4000);
    if (!castTimer) castTimer = setTimeout(broadcastChanges, 400);
  }

  /* ---------------- live push (SSE) ---------------- */

  function send(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) { try { res.write(msg); } catch { clients.delete(res); } }
  }

  function broadcastChanges() {
    castTimer = null;
    const cache = getGroupCache().data || {};
    const rows = [...changed].map((id) => cache[id] && summary(cache[id])).filter(Boolean);
    changed.clear();
    if (rows.length && clients.size) send('rows', { rows });
  }

  /* ---------------- helpers ---------------- */

  function ensure(id, g) {
    let r = recs.get(id);
    if (!r) {
      const members = (g?.participants || []).map((p) => norm(p.id));
      r = {
        _id: id, name: '', since: Date.now(), baseline: members.length, members,
        events: [], req: {}, pending: null, pendingErr: null, ph: {},
        counts: { link: 0, added: 0, other: 0, left: 0, removed: 0 },
        adders: {}, approvers: {}
      };
      recs.set(id, r);
    }
    if (g?.subject) r.name = g.subject.trim();
    return r;
  }

  function phoneIndex(id) {
    const g = getGroupCache().data?.[id];
    const m = new Map();
    for (const p of g?.participants || []) {
      const ph = p.phoneNumber || (isPN(p.id) ? p.id : isPN(p.jid) ? p.jid : null);
      const n = ph ? norm(ph) : null;
      m.set(norm(p.id), n);
      if (p.lid) m.set(norm(p.lid), n);
      if (p.jid) m.set(norm(p.jid), n);
    }
    return m;
  }

  const phoneOf = (idx, jid) => (jid ? idx.get(norm(jid)) || (isPN(jid) ? norm(jid) : null) : null);

  function remember(r, idx, jid) {
    const n = norm(jid);
    const ph = phoneOf(idx, jid);
    if (n && ph) r.ph[n] = ph;
  }

  function push(r, ev) {
    r.events.push({ t: Date.now(), ...ev });
    if (r.events.length > EVENT_CAP) r.events.splice(0, r.events.length - EVENT_CAP);
  }

  const who = (r, n) => (n ? (r.ph[n] ? r.ph[n] : `lid:${n}`) : '');
  const shown = (r, n) => (n ? (r.ph[n] ? `+${r.ph[n]}` : `ID ${n}`) : '');

  /* New members arrive as bare IDs in some groups (LID addressing). A single
     debounced metadata fetch fills in their phone numbers. */
  const resolveTimers = new Map();
  function resolveLater(id) {
    if (resolveTimers.has(id)) return;
    resolveTimers.set(id, setTimeout(async () => {
      resolveTimers.delete(id);
      const sock = getSock();
      const g = getGroupCache().data?.[id];
      if (!sock || !g) return;
      try {
        const md = await withLimit(() => sock.groupMetadata(id));
        g.participants = md.participants || g.participants;
        g.joinApprovalMode = !!md.joinApprovalMode;
        const r = ensure(id, g);
        const idx = phoneIndex(id);
        for (const p of g.participants) remember(r, idx, p.id);
        for (const row of r.pending?.rows || []) if (!row.ph) row.ph = idx.get(row.p) || null;
        touch(id);
      } catch { /* phone numbers stay as IDs; counts are unaffected */ }
    }, 2500));
  }

  /* ---------------- WhatsApp events ---------------- */

  function onParticipants({ id, author, authorPn, participants, action }) {
    const g = getGroupCache().data?.[id];
    const r = ensure(id, g);
    const authorKeys = [norm(author), norm(authorPn)].filter(Boolean);

    for (const raw of participants || []) {
      const pj = jidOf(raw);
      if (!pj) continue;
      const p = norm(pj);
      const pKeys = [...new Set([
        norm(pj),
        norm(raw?.phoneNumber),
        norm(raw?.jid),
        norm(raw?.lid)
      ].filter(Boolean))];

      if (action === 'add') {
        if (g && !g.participants.some((x) => pKeys.includes(norm(x.id)) || pKeys.includes(norm(x.jid)) || pKeys.includes(norm(x.lid)) || pKeys.includes(norm(x.phoneNumber)))) {
          g.participants.push(typeof raw === 'object' ? raw : { id: pj });
        }
        const idx = phoneIndex(id);
        pKeys.forEach((k) => remember(r, idx, k));
        if (author) remember(r, idx, author);
        if (raw?.phoneNumber) r.ph[p] = norm(raw.phoneNumber);

        const reqKey = pKeys.find((k) => r.req[k]);
        const req = reqKey ? r.req[reqKey] : null;
        pKeys.forEach((k) => delete r.req[k]);
        let k, actor = null, approvedBy = null;
        const sameUser = authorKeys.length && pKeys.some((x) => authorKeys.includes(x));
        const approvedByKey = authorKeys[0] || null;

        if (req) {
          approvedBy = approvedByKey;
          if (req.method === 'invite_link') k = 'link';
          else if (req.method === 'non_admin_add') { k = 'added'; actor = req.by; }
          else k = 'other';
        } else if (sameUser) k = 'link';
        else if (approvedByKey) { k = 'added'; actor = approvedByKey; }
        else k = 'other';

        r.counts[k]++;
        if (k === 'added' && actor) r.adders[actor] = (r.adders[actor] || 0) + 1;
        if (approvedBy) r.approvers[approvedBy] = (r.approvers[approvedBy] || 0) + 1;
        if (!r.members.includes(p)) r.members.push(p);
        if (r.pending) r.pending.rows = r.pending.rows.filter((x) => !pKeys.includes(x.p) && !pKeys.includes(x.ph));
        push(r, { k, p, a: actor, by: approvedBy, m: req?.method || null });
        if (!r.ph[p] && !raw?.phoneNumber) resolveLater(id);
      } else if (action === 'remove') {
        const k = a && a === p ? 'left' : 'removed';
        r.counts[k]++;
        r.members = r.members.filter((x) => x !== p);
        if (g) g.participants = g.participants.filter((x) => norm(x.id) !== p);
        push(r, { k, p, a: k === 'removed' ? a : null });
      } else if (action === 'promote' || action === 'demote') {
        const part = g?.participants.find((x) => norm(x.id) === p);
        if (part) part.admin = action === 'promote' ? 'admin' : null;
      }
    }
    touch(id);
  }

  function onJoinRequest({ id, author, authorPn, participant, participantPn, action, method }) {
    const g = getGroupCache().data?.[id];
    const r = ensure(id, g);
    const p = norm(jidOf(participant));
    const pKeys = [...new Set([norm(jidOf(participant)), norm(participantPn)].filter(Boolean))];
    if (!p || !pKeys.length) return;
    const idx = phoneIndex(id);
    pKeys.forEach((k) => remember(r, idx, k));
    if (participantPn) r.ph[p] = norm(participantPn);
    if (author) remember(r, idx, author);
    if (authorPn) remember(r, idx, authorPn);

    if (action === 'created') {
      const by = method === 'non_admin_add' && (authorPn || author) ? norm(authorPn || author) : p;
      const request = { method: method || null, by, t: Date.now() };
      pKeys.forEach((k) => { r.req[k] = request; });
      if (r.pending && !r.pending.rows.some((x) => pKeys.includes(x.p) || pKeys.includes(x.ph))) {
        r.pending.rows.push({ p, ph: r.ph[p] || norm(participantPn) || null, m: method || null, t: Date.now(), by });
      }
      push(r, { k: 'req', p, a: method === 'non_admin_add' ? by : null, m: method || null });
      if (!r.pending) refreshPending(id).catch(() => {});
    } else {
      pKeys.forEach((k) => delete r.req[k]);
      if (r.pending) r.pending.rows = r.pending.rows.filter((x) => !pKeys.includes(x.p) && !pKeys.includes(x.ph));
      push(r, { k: action === 'rejected' ? 'rejected' : 'revoked', p });
    }
    touch(id);
  }

  function attach(sock) {
    sock.ev.on('group-participants.update', (u) => { try { onParticipants(u); } catch (e) { console.error('[stats] participants:', e.message); } });
    sock.ev.on('group.join-request', (u) => { try { onJoinRequest(u); } catch (e) { console.error('[stats] join-request:', e.message); } });
    sock.ev.on('groups.upsert', (list) => {
      const gc = getGroupCache();
      if (!gc.data) return;
      for (const g of list || []) { gc.data[g.id] = g; ensure(g.id, g); touch(g.id); }
    });
    sock.ev.on('groups.update', (list) => {
      const gc = getGroupCache();
      if (!gc.data) return;
      for (const u of list || []) {
        if (!gc.data[u.id]) continue;
        Object.assign(gc.data[u.id], u, { participants: gc.data[u.id].participants });
        ensure(u.id, gc.data[u.id]);
        touch(u.id);
      }
    });
  }

  /* ---------------- pending requests ---------------- */

  async function refreshPending(id) {
    const sock = getSock();
    const g = getGroupCache().data?.[id];
    if (!sock || !g) return;
    const r = ensure(id, g);
    const now = Date.now();

    if (!g.joinApprovalMode) {
      r.pending = { at: now, rows: [] };
      r.pendingErr = null;
      r.req = {};
      touch(id);
      return;
    }

    try {
      const list = await withLimit(() => sock.groupRequestParticipantsList(id));
      const idx = phoneIndex(id);
      const rows = (list || []).map((x) => {
        const jid = x.jid || x.phone_number || '';
        const ph = x.phone_number ? norm(x.phone_number) : (isPN(jid) ? norm(jid) : phoneOf(idx, jid));
        const by = x.requestor || x.requester ? norm(x.requestor || x.requester) : null;
        if (ph) r.ph[norm(jid)] = ph;
        return { p: norm(jid), ph: ph || null, m: x.request_method || null, t: x.request_time ? Number(x.request_time) * 1000 : null, by };
      });
      r.pending = { at: now, rows };
      r.pendingErr = null;

      const live = new Set(rows.map((x) => x.p));
      for (const row of rows) {
        if (!r.req[row.p]) r.req[row.p] = { method: row.m, by: row.m === 'non_admin_add' ? row.by : row.p, t: row.t || now };
      }
      for (const k of Object.keys(r.req)) if (!live.has(k) && now - r.req[k].t > 60000) delete r.req[k];
    } catch (e) {
      const m = String(e?.message || e?.data || e);
      r.pendingErr = /not-authorized|forbidden|403/i.test(m) ? 'not-admin' : 'error';
    }
    touch(id);
  }

  async function refreshAll(forceGroups = false) {
    if (refresh.running) return refresh;
    if (forceGroups && refreshGroups) await refreshGroups();
    const groups = Object.values(getGroupCache().data || {});
    refresh.running = true;
    refresh.done = 0;
    refresh.total = groups.length;
    send('progress', refresh);
    try {
      for (let i = 0; i < groups.length; i += 5) {
        await Promise.all(groups.slice(i, i + 5).map((g) =>
          refreshPending(g.id).catch(() => {}).finally(() => { refresh.done++; })
        ));
        send('progress', refresh);
        await sleep(250);
      }
    } finally {
      refresh.running = false;
      refresh.at = Date.now();
      send('progress', refresh);
    }
    return refresh;
  }

  /* Called after every (re)connect once the group list is loaded. Anything that
     changed while the tracker was offline is reconciled so totals stay right. */
  async function onOpen() {
    const groups = Object.values(getGroupCache().data || {});
    const idxFor = (id) => phoneIndex(id);
    for (const g of groups) {
      const known = recs.has(g.id);
      const r = ensure(g.id, g);
      if (known) {
        const cur = new Set(g.participants.map((p) => norm(p.id)));
        const old = new Set(r.members);
        const idx = idxFor(g.id);
        for (const p of g.participants) remember(r, idx, p.id);
        for (const p of cur) if (!old.has(p)) { r.counts.other++; push(r, { k: 'other', p, m: 'offline' }); }
        for (const p of old) if (!cur.has(p)) { r.counts.left++; push(r, { k: 'left', p, m: 'offline' }); }
        r.members = [...cur];
      }
      touch(g.id);
    }
    refreshAll().catch((e) => console.error('[stats] refresh:', e.message));
  }

  /* ---------------- summaries ---------------- */

  function myIds() {
    const u = getSock()?.user || {};
    return [norm(u.id), norm(u.lid)].filter(Boolean);
  }

  function summary(g) {
    const r = ensure(g.id, g);
    const me = myIds();
    const total = g.participants?.length ?? g.size ?? 0;
    const admin = (g.participants || []).some((p) => me.includes(norm(p.id)) && p.admin);

    let state = 'unknown';
    let pending = null;
    if (!g.joinApprovalMode) { state = 'off'; pending = 0; }
    else if (r.pendingErr === 'not-admin') state = 'not-admin';
    else if (r.pending) { state = 'ok'; pending = r.pending.rows.length; }
    else if (r.pendingErr) state = 'error';

    const adders = Object.entries(r.adders)
      .map(([k, n]) => ({ k, who: shown(r, k), n }))
      .sort((x, y) => y.n - x.n);

    return {
      id: g.id, name: r.name || (g.subject || '').trim(), num: trailingNum(g.subject),
      total, admin, joinApproval: !!g.joinApprovalMode,
      pending, state, pendingAt: r.pending?.at || null,
      link: r.counts.link, added: r.counts.added, other: r.counts.other,
      left: r.counts.left, removed: r.counts.removed,
      baseline: r.baseline, since: r.since, adders
    };
  }

  const sortedRows = (ids) => {
    let groups = Object.values(getGroupCache().data || {});
    if (ids?.length) { const s = new Set(ids); groups = groups.filter((g) => s.has(g.id)); }
    return groups.map(summary).sort((a, b) => (a.num - b.num) || a.name.localeCompare(b.name));
  };

  function leaderboard() {
    const acc = new Map();
    for (const g of Object.values(getGroupCache().data || {})) {
      const r = recs.get(g.id);
      if (!r) continue;
      for (const [k, n] of Object.entries(r.adders)) {
        const e = acc.get(k) || { k, who: shown(r, k), n: 0, groups: [] };
        if (!r.ph[k] && e.who.startsWith('ID')) e.who = shown(r, k);
        e.n += n;
        e.groups.push({ name: r.name, n });
        acc.set(k, e);
      }
    }
    return [...acc.values()].sort((a, b) => b.n - a.n);
  }

  /* ---------------- export ---------------- */

  const csvCell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s) && !/^\+?\d+$/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const TAB_LABEL = {
    pending: 'PENDING MEMBERS',
    link: 'JOINED THROUGH INVITE LINKS',
    added: 'TOTAL ADDED',
    total: 'TOTAL MEMBERS'
  };

  function buildExport(tab, scope, ids) {
    const rows = sortedRows(ids);
    const idxOf = (id) => recs.get(id);
    const head = [], lines = [];

    if (scope === 'summary') {
      if (tab === 'pending') {
        head.push('Group', 'Pending Members');
        rows.forEach((r) => lines.push([r.name, r.pending ?? (r.state === 'not-admin' ? 'not admin' : 'unknown')]));
      } else if (tab === 'link') {
        head.push('Group', 'Joined via Invite Link');
        rows.forEach((r) => lines.push([r.name, r.link]));
      } else if (tab === 'added') {
        head.push('Group', 'Total Added', 'Added By');
        rows.forEach((r) => lines.push([r.name, r.added, r.adders.map((a) => `${a.who} (${a.n})`).join('; ')]));
      } else {
        head.push('Group', 'Total Members', 'At Start', 'Via Invite Link', 'Added by Members', 'Other', 'Left', 'Removed');
        rows.forEach((r) => lines.push([r.name, r.total, r.baseline, r.link, r.added, r.other, r.left, r.removed]));
      }
    } else if (tab === 'pending') {
      head.push('Group', 'Phone', 'Request Method', 'Requested At', 'Added By');
      for (const row of rows) {
        const r = idxOf(row.id);
        for (const x of r?.pending?.rows || []) {
          lines.push([row.name, x.ph || `ID ${x.p}`, x.m || '', fmtTime(x.t), x.m === 'non_admin_add' ? shown(r, x.by) : '']);
        }
      }
    } else if (tab === 'link') {
      head.push('Group', 'Phone', 'Joined At', 'Approved By');
      for (const row of rows) {
        const r = idxOf(row.id);
        for (const e of r?.events || []) if (e.k === 'link') lines.push([row.name, who(r, e.p).replace('lid:', 'ID '), fmtTime(e.t), shown(r, e.by)]);
      }
    } else if (tab === 'added') {
      head.push('Group', 'Added Member', 'Added By', 'Time');
      for (const row of rows) {
        const r = idxOf(row.id);
        for (const e of r?.events || []) if (e.k === 'added') lines.push([row.name, who(r, e.p).replace('lid:', 'ID '), shown(r, e.a), fmtTime(e.t)]);
      }
    } else {
      head.push('Group', 'Phone', 'Role');
      const cache = getGroupCache().data || {};
      for (const row of rows) {
        const g = cache[row.id];
        const idx = phoneIndex(row.id);
        for (const p of g?.participants || []) {
          lines.push([row.name, phoneOf(idx, p.id) || `ID ${norm(p.id)}`, p.admin === 'superadmin' ? 'owner' : p.admin ? 'admin' : 'member']);
        }
      }
    }
    return { head, lines, rows };
  }

  function renderExport(tab, scope, format, ids) {
    const { head, lines, rows } = buildExport(tab, scope, ids);
    const label = TAB_LABEL[tab];
    const stamp = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
    const base = `${tab}-${scope}-${stamp}`;

    if (format === 'csv') {
      const body = [head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n');
      return { name: `${base}.csv`, type: 'text/csv; charset=utf-8', body: '\uFEFF' + body };
    }

    let txt = '';
    if (scope === 'summary' && tab !== 'total' && tab !== 'added') {
      txt = `GROUP.  ${label}\n` + lines.map((l) => `${l[0]}= ${l[1]}`).join('\n');
      const sum = lines.reduce((s, l) => s + (Number(l[1]) || 0), 0);
      txt += `\n\nTOTAL= ${sum}`;
    } else if (scope === 'summary' && tab === 'added') {
      txt = `GROUP.  ${label}\n`;
      for (const r of rows) {
        txt += `${r.name}= ${r.added}\n`;
        for (const a of r.adders) txt += `    ${a.who} = ${a.n}\n`;
      }
      txt += `\nTOTAL= ${rows.reduce((s, r) => s + r.added, 0)}`;
    } else if (scope === 'summary') {
      txt = `GROUP.  ${label}\n` + lines.map((l) => `${l[0]}= ${l[1]}  (start ${l[2]}, link +${l[3]}, added +${l[4]}, other +${l[5]}, left -${l[6]}, removed -${l[7]})`).join('\n');
      txt += `\n\nTOTAL= ${rows.reduce((s, r) => s + r.total, 0)}`;
    } else {
      const groups = new Map();
      for (const l of lines) { if (!groups.has(l[0])) groups.set(l[0], []); groups.get(l[0]).push(l.slice(1).filter((x) => x !== '').join(' | ')); }
      txt = [...groups].map(([g, items]) => `${g}  (${items.length})\n${items.map((i) => '  ' + i).join('\n')}`).join('\n\n');
    }
    return { name: `${base}.txt`, type: 'text/plain; charset=utf-8', body: txt + '\n' };
  }

  /* ---------------- routes ---------------- */

  function routes(app, requireAuth, needWA) {
    app.get('/api/stats/overview', requireAuth, needWA, (req, res) => {
      const currentRows = sortedRows();
      res.json({
        rows: currentRows,
        leaderboard: leaderboard(),
        refresh,
        groupCount: currentRows.length,
        lastSync: refresh.at || null,
        tz: TZ,
        now: Date.now()
      });
    });

    app.post('/api/stats/refresh', requireAuth, needWA, (req, res) => {
      refreshAll(true).catch((e) => console.error('[stats] refresh:', e.message));
      res.json({ refresh });
    });

    app.get('/api/stats/group/:id', requireAuth, needWA, (req, res) => {
      const g = getGroupCache().data?.[req.params.id];
      if (!g) return res.status(404).json({ error: 'Group not found' });
      const r = ensure(g.id, g);
      res.json({
        row: summary(g),
        pending: (r.pending?.rows || []).map((x) => ({ who: x.ph ? `+${x.ph}` : `ID ${x.p}`, method: x.m, at: x.t, by: x.m === 'non_admin_add' ? shown(r, x.by) : '' })),
        recent: r.events.slice(-60).reverse().map((e) => ({
          at: e.t, kind: e.k, who: shown(r, e.p), by: shown(r, e.a || e.by), method: e.m
        }))
      });
    });

    app.get('/api/stats/stream', requireAuth, (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.write('retry: 3000\n\n');
      clients.add(res);
      const beat = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); });
    });

    const exporter = (req, res) => {
      const q = { ...req.query, ...(req.body || {}) };
      const tab = ['pending', 'link', 'added', 'total'].includes(q.tab) ? q.tab : 'pending';
      const scope = q.scope === 'detail' ? 'detail' : 'summary';
      const format = q.format === 'txt' ? 'txt' : 'csv';
      const ids = (Array.isArray(q.ids) ? q.ids : String(q.ids || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
      const out = renderExport(tab, scope, format, ids);
      res.setHeader('Content-Type', out.type);
      res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
      res.send(out.body);
    };
    app.get('/api/stats/export', requireAuth, needWA, exporter);
    app.post('/api/stats/export', requireAuth, needWA, exporter);
  }

  setInterval(() => { if (getSock()) refreshAll().catch(() => {}); }, 10 * 60 * 1000).unref?.();

  return { load, attach, onOpen, routes, flush, _t: { onParticipants, onJoinRequest, summary, renderExport, recs } };
}
