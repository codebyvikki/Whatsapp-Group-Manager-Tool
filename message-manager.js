import crypto from 'crypto';

const MAX_GROUPS_DEFAULT = 500;
const MAX_MESSAGE_LENGTH_DEFAULT = 4096;
const SEND_GAP_DEFAULT = 900;

const isGroupJid = (jid) => /@g\.us$/.test(String(jid || ''));
const keyOf = (jid, id) => `${jid}::${id}`;

export function createMessageManager(ctx) {
  const {
    getSock,
    getGroupCache,
    refreshGroups,
    maxGroups = MAX_GROUPS_DEFAULT,
    maxMessageLength = MAX_MESSAGE_LENGTH_DEFAULT,
    sendGapMs = SEND_GAP_DEFAULT,
  } = ctx;

  const chats = new Map();
  const counts = new Map();
  const seen = new Set();
  const clients = new Set();
  const jobs = new Map();
  let lastSync = 0;
  let broadcastTimer = null;

  const markSeen = (jid, id) => {
    if (!jid || !id) return false;
    const k = keyOf(jid, id);
    if (seen.has(k)) return false;
    seen.add(k);
    if (seen.size > 150000) {
      const first = seen.values().next().value;
      if (first) seen.delete(first);
    }
    return true;
  };

  const ensureCount = (jid) => {
    let r = counts.get(jid);
    if (!r) {
      r = { total: 0, unread: 0 };
      counts.set(jid, r);
    }
    return r;
  };

  const setUnread = (jid, value, markedAsUnread = false) => {
    if (!isGroupJid(jid)) return;
    const r = ensureCount(jid);
    const n = Number(value);
    r.unread = Number.isFinite(n) && n >= 0
      ? Math.floor(n)
      : (markedAsUnread ? 1 : r.unread);
    if (markedAsUnread && r.unread === 0) r.unread = 1;
    lastSync = Date.now();
    scheduleBroadcast([jid]);
  };

  const touch = (ids = []) => {
    lastSync = Date.now();
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return;
    scheduleBroadcast(unique);
  };

  const scheduleBroadcast = (ids) => {
    if (broadcastTimer) {
      for (const id of ids) pendingChanged.add(id);
      return;
    }
    for (const id of ids) pendingChanged.add(id);
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      const rows = [...pendingChanged]
        .map((id) => rowFor(id))
        .filter(Boolean);
      pendingChanged.clear();
      if (!rows.length || !clients.size) return;
      send('rows', { rows, lastSync });
    }, 80);
  };

  const pendingChanged = new Set();

  const groupMap = () => getGroupCache()?.data || {};

  const rowFor = (id) => {
    const g = groupMap()[id];
    if (!g) return null;
    const c = ensureCount(id);
    const chat = chats.get(id) || {};
    return {
      id,
      name: String(g.subject || chat.name || '').trim() || id,
      num: (() => {
        const m = String(g.subject || '').match(/(\d+)\s*$/);
        return m ? Number(m[1]) : Infinity;
      })(),
      unread: Math.max(0, Number(c.unread) || 0),
      total: Math.max(0, Number(c.total) || 0),
      // Seen = messages already read on WhatsApp for the messages currently tracked.
      // When the chat is opened/read in WhatsApp, Baileys emits chats.update with
      // unreadCount 0 or -1; the unread counter is updated there and this value
      // therefore follows the WhatsApp read state in real time.
      seen: Math.max(0, Math.max(0, Number(c.total) || 0) - Math.max(0, Number(c.unread) || 0)),
      lastMessageAt: chat.lastMsgTimestamp || chat.lastMessageRecvTimestamp || null,
    };
  };

  const allRows = () =>
    Object.values(groupMap())
      .map((g) => rowFor(g.id))
      .filter(Boolean)
      .sort((a, b) => (a.num - b.num) || a.name.localeCompare(b.name));

  const unreadRows = () => allRows().filter((r) => r.unread > 0);

  const send = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try { res.write(msg); } catch { clients.delete(res); }
    }
  };

  function attach(sock) {
    sock.ev.on('messaging-history.set', (payload = {}) => {
      const changed = new Set();
      for (const chat of payload.chats || []) {
        if (!isGroupJid(chat?.id)) continue;
        chats.set(chat.id, { ...(chats.get(chat.id) || {}), ...chat });
        const r = ensureCount(chat.id);
        if (chat.unreadCount !== undefined || chat.markedAsUnread !== undefined) {
          const n = Number(chat.unreadCount);
          r.unread = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : r.unread;
          if (chat.markedAsUnread && r.unread === 0) r.unread = 1;
        }
        changed.add(chat.id);
      }

      for (const msg of payload.messages || []) {
        const jid = msg?.key?.remoteJid;
        const id = msg?.key?.id;
        if (!isGroupJid(jid) || !id || !markSeen(jid, id)) continue;
        ensureCount(jid).total++;
        changed.add(jid);
      }

      touch([...changed]);
    });

    sock.ev.on('chats.upsert', (list = []) => {
      const changed = [];
      for (const chat of list) {
        if (!isGroupJid(chat?.id)) continue;
        chats.set(chat.id, { ...(chats.get(chat.id) || {}), ...chat });
        if (chat.unreadCount !== undefined || chat.markedAsUnread !== undefined) {
          const r = ensureCount(chat.id);
          const n = Number(chat.unreadCount);
          if (Number.isFinite(n)) r.unread = Math.max(0, Math.floor(n));
          if (chat.markedAsUnread && r.unread === 0) r.unread = 1;
        }
        changed.push(chat.id);
      }
      touch(changed);
    });

    sock.ev.on('chats.update', (list = []) => {
      const changed = [];
      for (const update of list) {
        if (!isGroupJid(update?.id)) continue;
        const current = chats.get(update.id) || {};
        chats.set(update.id, { ...current, ...update });
        if (update.unreadCount !== undefined || update.markedAsUnread !== undefined) {
          const r = ensureCount(update.id);
          const n = Number(update.unreadCount);

          /*
           * Baileys 6.7.x does NOT always send an absolute unread count in
           * chats.update. For a newly received message, process-message emits
           * unreadCount: 1 for that message. Treating that value as the
           * absolute counter makes the UI get stuck at 1.
           *
           * The other important values are:
           *   0  -> chat was marked read
           *  -1  -> one unread item was consumed/marked read
           *  >0 -> unread delta (normally +1 for a received message)
           */
          if (Number.isFinite(n)) {
            const delta = Math.floor(n);
            if (delta === 0) {
              r.unread = 0;
            } else if (delta < 0) {
              r.unread = Math.max(0, r.unread + delta);
            } else {
              r.unread = Math.max(0, r.unread + delta);
            }
          }
          if (update.markedAsUnread && r.unread === 0) r.unread = 1;
        }
        changed.push(update.id);
      }
      touch(changed);
    });

    sock.ev.on('messages.upsert', (payload = {}) => {
      const changed = new Set();
      for (const msg of payload.messages || []) {
        const jid = msg?.key?.remoteJid;
        const id = msg?.key?.id;
        if (!isGroupJid(jid) || !id || !markSeen(jid, id)) continue;
        ensureCount(jid).total++;
        changed.add(jid);
      }
      touch([...changed]);
    });

    sock.ev.on('messages.delete', (payload) => {
      const changed = new Set();
      const keys = Array.isArray(payload?.keys) ? payload.keys : [];
      for (const k of keys) if (isGroupJid(k?.remoteJid)) changed.add(k.remoteJid);
      touch([...changed]);
    });

    sock.ev.on('groups.upsert', (list = []) => touch(list.map((g) => g?.id)));
    sock.ev.on('groups.update', (list = []) => touch(list.map((g) => g?.id)));
  }

  async function refresh() {
    if (!getSock()) throw new Error('WhatsApp is not connected');
    if (typeof refreshGroups === 'function') await refreshGroups();
    lastSync = Date.now();
    send('snapshot', {
      rows: allRows(),
      unread: unreadRows(),
      lastSync,
    });
    return { rows: allRows(), unread: unreadRows(), lastSync };
  }

  function overview() {
    return {
      rows: allRows(),
      unread: unreadRows(),
      lastSync: lastSync || null,
      groupCount: allRows().length,
      unreadGroups: unreadRows().length,
      totalMessages: allRows().reduce((n, r) => n + r.total, 0),
      totalUnread: unreadRows().reduce((n, r) => n + r.unread, 0),
    };
  }

  async function startSend(userId, groupIds, text) {
    const sock = getSock();
    if (!sock) throw new Error('WhatsApp is not connected');
    const message = String(text || '').trim();
    if (!message) throw new Error('Enter a message first.');
    if (message.length > maxMessageLength) {
      throw new Error(`Message is too long. Maximum ${maxMessageLength} characters.`);
    }

    const allowed = new Set(Object.keys(groupMap()));
    const ids = [...new Set(groupIds || [])].filter((id) => allowed.has(id));
    if (!ids.length) throw new Error('Please select at least one group.');
    if (ids.length > maxGroups) throw new Error(`You can send to no more than ${maxGroups} groups at once.`);

    const job = {
      id: crypto.randomUUID(),
      userId: String(userId),
      text: message,
      ids,
      state: 'queued',
      total: ids.length,
      done: 0,
      success: 0,
      failed: 0,
      results: [],
      createdAt: Date.now(),
      current: null,
      cancelRequested: false,
    };
    jobs.set(job.id, job);

    (async () => {
      job.state = 'running';
      for (let i = 0; i < ids.length; i++) {
        if (job.cancelRequested) break;
        const id = ids[i];
        const g = groupMap()[id];
        job.current = { index: i + 1, total: ids.length, name: g?.subject || id };
        try {
          await getSock().sendMessage(id, { text: message });
          job.success++;
          job.results.push({ id, name: g?.subject || id, status: 'success' });
        } catch (e) {
          job.failed++;
          job.results.push({ id, name: g?.subject || id, status: 'failed', error: e?.message || String(e) });
        }
        job.done++;
        send('send-progress', {
          job: serializeJob(job),
        });
        if (i < ids.length - 1 && !job.cancelRequested) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(250, sendGapMs)));
        }
      }
      job.current = null;
      job.state = job.cancelRequested ? 'cancelled' : 'finished';
      send('send-progress', { job: serializeJob(job) });
      setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000).unref?.();
    })().catch((e) => {
      job.state = 'error';
      job.error = e?.message || String(e);
      send('send-progress', { job: serializeJob(job) });
    });

    return serializeJob(job);
  }

  function serializeJob(job) {
    return {
      id: job.id,
      state: job.state,
      total: job.total,
      done: job.done,
      success: job.success,
      failed: job.failed,
      results: job.results.slice(-200),
      createdAt: job.createdAt,
      current: job.current,
      error: job.error || null,
    };
  }

  function getJob(id) {
    const job = jobs.get(id);
    return job ? serializeJob(job) : null;
  }

  function cancelJob(id) {
    const job = jobs.get(id);
    if (!job) return false;
    if (['finished', 'cancelled', 'error'].includes(job.state)) return false;
    job.cancelRequested = true;
    return true;
  }

  function removeGroup(id) {
    chats.delete(id);
    counts.delete(id);
    for (const k of [...seen]) if (k.startsWith(`${id}::`)) seen.delete(k);
    touch([id]);
  }

  return {
    attach,
    refresh,
    overview,
    getJob,
    startSend,
    cancelJob,
    removeGroup,
    _t: { chats, counts, seen, clients, allRows, unreadRows },
  };
}

export function registerMessageRoutes(app, requireAuth, needWA, getMessageManager) {
  app.get('/api/messages/overview', requireAuth, needWA, (req, res) => {
    res.json(getMessageManager(req.user.userId).overview());
  });

  app.post('/api/messages/refresh', requireAuth, needWA, async (req, res) => {
    try {
      const data = await getMessageManager(req.user.userId).refresh();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: 'Could not refresh message data: ' + (e?.message || e) });
    }
  });

  app.post('/api/messages/send', requireAuth, needWA, async (req, res) => {
    try {
      const manager = getMessageManager(req.user.userId);
      const job = await manager.startSend(req.user.userId, req.body?.groupIds, req.body?.message);
      res.json({ ok: true, job });
    } catch (e) {
      res.status(400).json({ error: e?.message || 'Could not start message job' });
    }
  });

  app.get('/api/messages/jobs/:id', requireAuth, needWA, (req, res) => {
    const job = getMessageManager(req.user.userId).getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Message job not found' });
    res.json({ job });
  });

  app.post('/api/messages/jobs/:id/cancel', requireAuth, needWA, (req, res) => {
    const ok = getMessageManager(req.user.userId).cancelJob(req.params.id);
    if (!ok) return res.status(400).json({ error: 'Job cannot be cancelled.' });
    res.json({ ok: true });
  });

  app.get('/api/messages/stream', requireAuth, (req, res) => {
    const manager = getMessageManager(req.user.userId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    manager._t.clients.add(res);
    try { res.write(`event: snapshot\ndata: ${JSON.stringify(manager.overview())}\n\n`); } catch {}
    const beat = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
    req.on('close', () => {
      clearInterval(beat);
      manager._t.clients.delete(res);
    });
  });
}

export function registerGroupDeleterRoutes(app, requireAuth, needWA, getWA, getMessageManager) {
  app.post('/api/group-deleter/delete', requireAuth, needWA, async (req, res) => {
    const wa = getWA(req.user.userId);
    const ids = [...new Set(Array.isArray(req.body?.groupIds) ? req.body.groupIds.map(String) : [])];
    const groups = wa.groupCache?.data || {};
    if (!ids.length) return res.status(400).json({ error: 'Please select at least one group.' });
    if (ids.length > maxSafeGroups()) return res.status(400).json({ error: `You can process no more than ${maxSafeGroups()} groups at once.` });

    const results = [];
    for (const id of ids) {
      const g = groups[id];
      if (!g) {
        results.push({ id, name: id, status: 'failed', error: 'Group not found' });
        continue;
      }
      try {
        await wa.sock.groupLeave(id);
        delete groups[id];
        results.push({ id, name: g.subject || id, status: 'success' });
        getMessageManager(req.user.userId)?.removeGroup(id);
      } catch (e) {
        results.push({ id, name: g.subject || id, status: 'failed', error: e?.message || String(e) });
      }
    }
    wa.groupCache.at = Date.now();
    res.json({
      ok: true,
      results,
      success: results.filter((x) => x.status === 'success').length,
      failed: results.filter((x) => x.status === 'failed').length,
    });
  });
}

function maxSafeGroups() {
  return Math.max(1, Number(process.env.MAX_GROUP_DELETE_GROUPS || 100));
}
