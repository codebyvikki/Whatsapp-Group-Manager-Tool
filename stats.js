import fs from 'fs';

/* =========================================================
   LIVE GROUP STATS

   - Pending join requests: read straight from WhatsApp (accurate at any time)
   - Joined via link / added by member / left / removed: recorded live from
     WhatsApp events, so they are accurate from the moment tracking starts
     (WhatsApp does not expose this history for the past).

   ========================================================= */

const FILE = './stats.json';
const EVENT_CAP = 8000;
const TZ = process.env.STATS_TZ || 'Asia/Kolkata';

const norm = (j) =>
  String(j || '')
    .split('@')[0]
    .split(':')[0];

const jidOf = (x) =>
  typeof x === 'string'
    ? x
    : x?.id || x?.jid || x?.phoneNumber || '';

const isPN = (j) =>
  /@s\.whatsapp\.net$/.test(j || '');

const fmtTime = (t) =>
  t
    ? new Date(t)
        .toLocaleString('en-GB', {
          timeZone: TZ,
          hour12: false
        })
        .replace(',', '')
    : '';

const trailingNum = (name) => {
  const m = String(name || '').match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : Infinity;
};

export function createStats(ctx) {
  const {
    getDb,
    getSock,
    getGroupCache,
    withLimit,
    sleep,
    refreshGroups,
    ownerId = 'default'
  } = ctx;

  const statKey = (id) => `${ownerId}::${id}`;

  const recs = new Map();
  const dirty = new Set();
  const clients = new Set();
  const changed = new Set();

  const refresh = {
    running: false,
    done: 0,
    total: 0,
    at: 0
  };

  let saveTimer = null;
  let castTimer = null;

  /* ---------------- persistence ---------------- */

  async function load() {
    try {
      const d = await getDb();

      if (d) {
        for (
          const doc of await d
            .collection('gstats')
            .find({ ownerId })
            .toArray()
        ) {
          recs.set(doc._id, doc);
        }
      } else if (fs.existsSync(FILE)) {
        const j = JSON.parse(
          fs.readFileSync(FILE, 'utf8')
        );

        for (const r of Object.values(j)) {
          if (r.ownerId === ownerId) {
            recs.set(r._id, r);
          }
        }
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
        await d.collection('gstats').bulkWrite(
          ids.map((i) => ({
            replaceOne: {
              filter: { _id: i },
              replacement: recs.get(i),
              upsert: true
            }
          }))
        );
      } else {
        const out = {};

        for (const [k, v] of recs) {
          out[k] = v;
        }

        fs.writeFileSync(
          FILE + '.tmp',
          JSON.stringify(out)
        );

        fs.renameSync(
          FILE + '.tmp',
          FILE
        );
      }
    } catch (e) {
      console.error('[stats] save:', e.message);

      ids.forEach((i) => dirty.add(i));
    }
  }

  function touch(id) {
    dirty.add(statKey(id));
    changed.add(id);

    if (!saveTimer) {
      saveTimer = setTimeout(flush, 4000);
    }

    if (!castTimer) {
      castTimer = setTimeout(
        broadcastChanges,
        400
      );
    }
  }

  /* ---------------- live push (SSE) ---------------- */

  function send(event, data) {
    const msg =
      `event: ${event}\n` +
      `data: ${JSON.stringify(data)}\n\n`;

    for (const res of clients) {
      try {
        res.write(msg);
      } catch {
        clients.delete(res);
      }
    }
  }

  function broadcastChanges() {
    castTimer = null;

    const cache =
      getGroupCache().data || {};

    const rows = [...changed]
      .map(
        (id) =>
          cache[id] &&
          summary(cache[id])
      )
      .filter(Boolean);

    changed.clear();

    if (rows.length && clients.size) {
      send('rows', { rows });
    }
  }

  /* ---------------- helpers ---------------- */

  function ensure(id, g) {
    let r = recs.get(statKey(id));

    if (!r) {
      const members = (
        g?.participants || []
      ).map((p) => norm(p.id));

      r = {
        _id: statKey(id),
        ownerId,
        groupId: id,
        name: '',
        since: Date.now(),
        baseline: members.length,
        members,

        events: [],

        req: {},
        pending: null,
        pendingErr: null,
        ph: {},

        counts: {
          link: 0,
          added: 0,
          other: 0,
          left: 0,
          removed: 0
        },

        adders: {},
        approvers: {}
      };

      recs.set(
        statKey(id),
        r
      );
    }

    if (g?.subject) {
      r.name = g.subject.trim();
    }

    return r;
  }

  function phoneIndex(id) {
    const g =
      getGroupCache().data?.[id];

    const m = new Map();

    for (const p of g?.participants || []) {
      const ph =
        p.phoneNumber ||
        (isPN(p.id)
          ? p.id
          : isPN(p.jid)
            ? p.jid
            : null);

      const n = ph
        ? norm(ph)
        : null;

      m.set(
        norm(p.id),
        n
      );

      if (p.lid) {
        m.set(
          norm(p.lid),
          n
        );
      }

      if (p.jid) {
        m.set(
          norm(p.jid),
          n
        );
      }
    }

    return m;
  }

  const phoneOf = (idx, jid) =>
    jid
      ? idx.get(norm(jid)) ||
        (isPN(jid)
          ? norm(jid)
          : null)
      : null;

  function remember(r, idx, jid) {
    const n = norm(jid);
    const ph = phoneOf(idx, jid);

    if (n && ph) {
      r.ph[n] = ph;
    }
  }

  function push(r, ev) {
    r.events.push({
      t: Date.now(),
      ...ev
    });

    if (r.events.length > EVENT_CAP) {
      r.events.splice(
        0,
        r.events.length - EVENT_CAP
      );
    }
  }

  const who = (r, n) =>
    n
      ? r.ph[n]
        ? r.ph[n]
        : `lid:${n}`
      : '';

  const shown = (r, n) =>
    n
      ? r.ph[n]
        ? `+${r.ph[n]}`
        : `ID ${n}`
      : '';

  /*
    New members arrive as bare IDs in some groups (LID addressing).
    A single debounced metadata fetch fills in their phone numbers.
  */

  const resolveTimers = new Map();

  function resolveLater(id) {
    if (resolveTimers.has(id)) return;

    resolveTimers.set(
      id,
      setTimeout(async () => {
        resolveTimers.delete(id);

        const sock = getSock();
        const g =
          getGroupCache().data?.[id];

        if (!sock || !g) return;

        try {
          const md = await withLimit(
            () => sock.groupMetadata(id)
          );

          g.participants =
            md.participants ||
            g.participants;

          g.joinApprovalMode =
            !!md.joinApprovalMode;

          const r = ensure(id, g);
          const idx = phoneIndex(id);

          for (const p of g.participants) {
            remember(
              r,
              idx,
              p.id
            );
          }

          for (
            const row of r.pending?.rows || []
          ) {
            if (!row.ph) {
              row.ph =
                idx.get(row.p) ||
                null;
            }
          }

          touch(id);
        } catch {
          /*
            Phone numbers stay as IDs;
            counts are unaffected.
          */
        }
      }, 2500)
    );
  }

  /* ---------------- WhatsApp events ---------------- */

  function onParticipants({
    id,
    author,
    authorPn,
    participants,
    action
  }) {
    const g =
      getGroupCache().data?.[id];

    const r = ensure(id, g);

    const authorKeys = [
      norm(author),
      norm(authorPn)
    ].filter(Boolean);

    for (const raw of participants || []) {
      const pj = jidOf(raw);

      if (!pj) continue;

      const p = norm(pj);

      const pKeys = [
        ...new Set(
          [
            norm(pj),
            norm(raw?.phoneNumber),
            norm(raw?.jid),
            norm(raw?.lid)
          ].filter(Boolean)
        )
      ];

      if (action === 'add') {
        if (
          g &&
          !g.participants.some(
            (x) =>
              pKeys.includes(norm(x.id)) ||
              pKeys.includes(norm(x.jid)) ||
              pKeys.includes(norm(x.lid)) ||
              pKeys.includes(
                norm(x.phoneNumber)
              )
          )
        ) {
          g.participants.push(
            typeof raw === 'object'
              ? raw
              : { id: pj }
          );
        }

        const idx = phoneIndex(id);

        pKeys.forEach((k) =>
          remember(r, idx, k)
        );

        if (author) {
          remember(
            r,
            idx,
            author
          );
        }

        if (raw?.phoneNumber) {
          r.ph[p] =
            norm(raw.phoneNumber);
        }

        const reqKey =
          pKeys.find(
            (k) => r.req[k]
          );

        const req =
          reqKey
            ? r.req[reqKey]
            : null;

        pKeys.forEach(
          (k) => delete r.req[k]
        );

        let k;
        let actor = null;
        let approvedBy = null;

        const sameUser =
          authorKeys.length &&
          pKeys.some((x) =>
            authorKeys.includes(x)
          );

        const approvedByKey =
          authorKeys[0] || null;

        if (req) {
          approvedBy =
            approvedByKey;

          if (
            req.method ===
            'invite_link'
          ) {
            k = 'link';
          } else if (
            req.method ===
            'non_admin_add'
          ) {
            k = 'added';
            actor = req.by;
          } else {
            k = 'other';
          }
        } else if (sameUser) {
          k = 'link';
        } else if (approvedByKey) {
          k = 'added';
          actor = approvedByKey;
        } else {
          k = 'other';
        }

        r.counts[k]++;

        if (
          k === 'added' &&
          actor
        ) {
          r.adders[actor] =
            (r.adders[actor] || 0) +
            1;
        }

        if (approvedBy) {
          r.approvers[approvedBy] =
            (r.approvers[approvedBy] || 0) +
            1;
        }

        if (!r.members.includes(p)) {
          r.members.push(p);
        }

        if (r.pending) {
          r.pending.rows =
            r.pending.rows.filter(
              (x) =>
                !pKeys.includes(x.p) &&
                !pKeys.includes(x.ph)
            );
        }

        push(r, {
          k,
          p,
          a: actor,
          by: approvedBy,
          m: req?.method || null
        });

        if (
          !r.ph[p] &&
          !raw?.phoneNumber
        ) {
          resolveLater(id);
        }

      } else if (action === 'remove') {

        /*
          FIX:
          Previously this used undefined variable `a`.
          Use the event author instead.
        */

        const actor =
          author
            ? norm(author)
            : null;

        const k =
          actor && actor === p
            ? 'left'
            : 'removed';

        r.counts[k]++;

        r.members =
          r.members.filter(
            (x) => x !== p
          );

        if (g) {
          g.participants =
            g.participants.filter(
              (x) =>
                norm(x.id) !== p
            );
        }

        push(r, {
          k,
          p,
          a:
            k === 'removed'
              ? actor
              : null
        });

      } else if (
        action === 'promote' ||
        action === 'demote'
      ) {
        const part =
          g?.participants.find(
            (x) =>
              norm(x.id) === p
          );

        if (part) {
          part.admin =
            action === 'promote'
              ? 'admin'
              : null;
        }
      }
    }

    touch(id);
  }

  function onJoinRequest({
    id,
    author,
    authorPn,
    participant,
    participantPn,
    action,
    method
  }) {
    const g =
      getGroupCache().data?.[id];

    const r = ensure(id, g);

    const p =
      norm(jidOf(participant));

    const pKeys = [
      ...new Set(
        [
          norm(jidOf(participant)),
          norm(participantPn)
        ].filter(Boolean)
      )
    ];

    if (!p || !pKeys.length) {
      return;
    }

    const idx =
      phoneIndex(id);

    pKeys.forEach((k) =>
      remember(r, idx, k)
    );

    if (participantPn) {
      r.ph[p] =
        norm(participantPn);
    }

    if (author) {
      remember(
        r,
        idx,
        author
      );
    }

    if (authorPn) {
      remember(
        r,
        idx,
        authorPn
      );
    }

    if (action === 'created') {
      const by =
        method === 'non_admin_add' &&
        (authorPn || author)
          ? norm(authorPn || author)
          : p;

      const request = {
        method:
          method || null,
        by,
        t: Date.now()
      };

      pKeys.forEach((k) => {
        r.req[k] = request;
      });

      if (
        r.pending &&
        !r.pending.rows.some(
          (x) =>
            pKeys.includes(x.p) ||
            pKeys.includes(x.ph)
        )
      ) {
        r.pending.rows.push({
          p,
          ph:
            r.ph[p] ||
            norm(participantPn) ||
            null,
          m: method || null,
          t: Date.now(),
          by
        });
      }

      push(r, {
        k: 'req',
        p,
        a:
          method === 'non_admin_add'
            ? by
            : null,
        m: method || null
      });

      if (!r.pending) {
        refreshPending(id).catch(
          () => {}
        );
      }

    } else {
      pKeys.forEach(
        (k) => delete r.req[k]
      );

      if (r.pending) {
        r.pending.rows =
          r.pending.rows.filter(
            (x) =>
              !pKeys.includes(x.p) &&
              !pKeys.includes(x.ph)
          );
      }

      push(r, {
        k:
          action === 'rejected'
            ? 'rejected'
            : 'revoked',
        p
      });
    }

    touch(id);
  }

  function attach(sock) {
    sock.ev.on(
      'group-participants.update',
      (u) => {
        try {
          onParticipants(u);
        } catch (e) {
          console.error(
            '[stats] participants:',
            e.message
          );
        }
      }
    );

    sock.ev.on(
      'group.join-request',
      (u) => {
        try {
          onJoinRequest(u);
        } catch (e) {
          console.error(
            '[stats] join-request:',
            e.message
          );
        }
      }
    );

    sock.ev.on(
      'groups.upsert',
      (list) => {
        const gc =
          getGroupCache();

        if (!gc.data) return;

        for (const g of list || []) {
          gc.data[g.id] = g;

          ensure(
            g.id,
            g
          );

          touch(g.id);
        }
      }
    );

    sock.ev.on(
      'groups.update',
      (list) => {
        const gc =
          getGroupCache();

        if (!gc.data) return;

        for (const u of list || []) {
          if (!gc.data[u.id]) {
            continue;
          }

          Object.assign(
            gc.data[u.id],
            u,
            {
              participants:
                gc.data[u.id]
                  .participants
            }
          );

          ensure(
            u.id,
            gc.data[u.id]
          );

          touch(u.id);
        }
      }
    );
  }

  /* ---------------- pending requests ---------------- */

  async function refreshPending(id) {
    const sock = getSock();

    const g =
      getGroupCache().data?.[id];

    if (!sock || !g) return;

    const r = ensure(id, g);
    const now = Date.now();

    if (!g.joinApprovalMode) {
      r.pending = {
        at: now,
        rows: []
      };

      r.pendingErr = null;
      r.req = {};

      touch(id);

      return;
    }

    try {
      const list =
        await withLimit(() =>
          sock.groupRequestParticipantsList(
            id
          )
        );

      const idx =
        phoneIndex(id);

      const rows =
        (list || []).map((x) => {
          const jid =
            x.jid ||
            x.phone_number ||
            '';

          const ph =
            x.phone_number
              ? norm(x.phone_number)
              : isPN(jid)
                ? norm(jid)
                : phoneOf(
                    idx,
                    jid
                  );

          const by =
            x.requestor ||
            x.requester
              ? norm(
                  x.requestor ||
                  x.requester
                )
              : null;

          if (ph) {
            r.ph[norm(jid)] =
              ph;
          }

          return {
            p: norm(jid),
            ph: ph || null,
            m:
              x.request_method ||
              null,
            t:
              x.request_time
                ? Number(
                    x.request_time
                  ) * 1000
                : null,
            by
          };
        });

      r.pending = {
        at: now,
        rows
      };

      r.pendingErr = null;

      const live =
        new Set(
          rows.map(
            (x) => x.p
          )
        );

      for (const row of rows) {
        if (!r.req[row.p]) {
          r.req[row.p] = {
            method: row.m,
            by:
              row.m ===
              'non_admin_add'
                ? row.by
                : row.p,
            t:
              row.t || now
          };
        }
      }

      for (
        const k of Object.keys(r.req)
      ) {
        if (
          !live.has(k) &&
          now - r.req[k].t >
            60000
        ) {
          delete r.req[k];
        }
      }

    } catch (e) {
      const m = String(
        e?.message ||
          e?.data ||
          e
      );

      r.pendingErr =
        /not-authorized|forbidden|403/i.test(
          m
        )
          ? 'not-admin'
          : 'error';
    }

    touch(id);
  }

  async function refreshAll(
    forceGroups = false
  ) {
    if (refresh.running) {
      return refresh;
    }

    if (
      forceGroups &&
      refreshGroups
    ) {
      await refreshGroups();
    }

    const groups =
      Object.values(
        getGroupCache().data || {}
      );

    refresh.running = true;
    refresh.done = 0;
    refresh.total =
      groups.length;

    send(
      'progress',
      refresh
    );

    try {
      for (
        let i = 0;
        i < groups.length;
        i += 5
      ) {
        await Promise.all(
          groups
            .slice(i, i + 5)
            .map((g) =>
              refreshPending(
                g.id
              )
                .catch(() => {})
                .finally(() => {
                  refresh.done++;
                })
            )
        );

        send(
          'progress',
          refresh
        );

        await sleep(250);
      }
    } finally {
      refresh.running = false;
      refresh.at =
        Date.now();

      send(
        'progress',
        refresh
      );
    }

    return refresh;
  }

  /*
    Called after every (re)connect once the group list is loaded.
    Anything that changed while the tracker was offline is reconciled
    so totals stay right.
  */

  async function onOpen() {
    const groups =
      Object.values(
        getGroupCache().data || {}
      );

    const idxFor = (id) =>
      phoneIndex(id);

    for (const g of groups) {
      const known =
        recs.has(
          statKey(g.id)
        );

      /*
        FIX:
        Previously this incorrectly used:
        stats._t.ensure(g.id, g)

        `stats` does not exist inside createStats().
        The correct function is directly `ensure()`.
      */
      const r =
        ensure(g.id, g);

      if (known) {
        const cur =
          new Set(
            g.participants.map(
              (p) => norm(p.id)
            )
          );

        const old =
          new Set(r.members);

        const idx =
          idxFor(g.id);

        for (
          const p of g.participants
        ) {
          remember(
            r,
            idx,
            p.id
          );
        }

        for (const p of cur) {
          if (!old.has(p)) {
            r.counts.other++;

            push(r, {
              k: 'other',
              p,
              m: 'offline'
            });
          }
        }

        for (const p of old) {
          if (!cur.has(p)) {
            r.counts.left++;

            push(r, {
              k: 'left',
              p,
              m: 'offline'
            });
          }
        }

        r.members = [
          ...cur
        ];
      }

      touch(g.id);
    }

    refreshAll().catch(
      (e) =>
        console.error(
          '[stats] refresh:',
          e.message
        )
    );
  }

  /* ---------------- summaries ---------------- */

  function myIds() {
    const u =
      getSock()?.user || {};

    return [
      norm(u.id),
      norm(u.lid)
    ].filter(Boolean);
  }

  function summary(g) {
    const r =
      ensure(g.id, g);

    const me = myIds();

    const total =
      g.participants?.length ??
      g.size ??
      0;

    const admin =
      (g.participants || [])
        .some(
          (p) =>
            me.includes(
              norm(p.id)
            ) &&
            p.admin
        );

    let state =
      'unknown';

    let pending = null;

    if (!g.joinApprovalMode) {
      state = 'off';
      pending = 0;
    } else if (
      r.pendingErr ===
      'not-admin'
    ) {
      state = 'not-admin';
    } else if (r.pending) {
      state = 'ok';
      pending =
        r.pending.rows.length;
    } else if (
      r.pendingErr
    ) {
      state = 'error';
    }

    const adders =
      Object.entries(r.adders)
        .map(
          ([k, n]) => ({
            k,
            who: shown(r, k),
            n
          })
        )
        .sort(
          (x, y) =>
            y.n - x.n
        );

    return {
      id: g.id,
      name:
        r.name ||
        (g.subject || '').trim(),

      num: trailingNum(
        g.subject
      ),

      total,
      admin,

      joinApproval:
        !!g.joinApprovalMode,

      pending,
      state,

      pendingAt:
        r.pending?.at ||
        null,

      link:
        r.counts.link,

      added:
        r.counts.added,

      other:
        r.counts.other,

      left:
        r.counts.left,

      removed:
        r.counts.removed,

      baseline:
        r.baseline,

      since:
        r.since,

      adders
    };
  }

  const sortedRows = (
    ids
  ) => {
    let groups =
      Object.values(
        getGroupCache().data || {}
      );

    if (ids?.length) {
      const s =
        new Set(ids);

      groups =
        groups.filter(
          (g) =>
            s.has(g.id)
        );
    }

    return groups
      .map(summary)
      .sort(
        (a, b) =>
          (a.num - b.num) ||
          a.name.localeCompare(
            b.name
          )
      );
  };

  function leaderboard() {
    const acc =
      new Map();

    for (
      const g of Object.values(
        getGroupCache().data || {}
      )
    ) {
      const r =
        recs.get(
          statKey(g.id)
        );

      if (!r) continue;

      for (
        const [k, n] of Object.entries(
          r.adders
        )
      ) {
        const e =
          acc.get(k) || {
            k,
            who: shown(r, k),
            n: 0,
            groups: []
          };

        if (
          !r.ph[k] &&
          e.who.startsWith('ID')
        ) {
          e.who =
            shown(r, k);
        }

        e.n += n;

        e.groups.push({
          name: r.name,
          n
        });

        acc.set(k, e);
      }
    }

    return [
      ...acc.values()
    ].sort(
      (a, b) =>
        b.n - a.n
    );
  }

  /* ---------------- export ---------------- */

  const csvCell = (v) => {
    let s =
      String(v ?? '');

    if (
      /^[=+\-@]/.test(s) &&
      !/^\+?\d+$/.test(s)
    ) {
      s = "'" + s;
    }

    return /[",\n]/.test(s)
      ? `"${s.replace(
          /"/g,
          '""'
        )}"`
      : s;
  };

  const TAB_LABEL = {
    pending:
      'PENDING MEMBERS',

    link:
      'JOINED THROUGH INVITE LINKS',

    added:
      'TOTAL ADDED',

    total:
      'TOTAL MEMBERS'
  };

  function buildExport(
    tab,
    scope,
    ids
  ) {
    const rows =
      sortedRows(ids);

    const idxOf = (id) =>
      recs.get(
        statKey(id)
      );

    const head = [];
    const lines = [];

    if (tab === 'pending') {
      head.push(
        'GROUPS',
        'PENDING MEMBERS'
      );

      rows.forEach((r) => {
        lines.push([
          r.name,
          r.pending ??
            (
              r.state ===
              'not-admin'
                ? 'not admin'
                : 'unknown'
            )
        ]);
      });

    } else if (tab === 'link') {
      head.push(
        'GROUPS',
        'JOINED THROUGH INVITE LINKS'
      );

      rows.forEach((r) => {
        lines.push([
          r.name,
          r.link
        ]);
      });

    } else if (tab === 'added') {
      head.push(
        'GROUPS',
        'TOTAL ADDED'
      );

      rows.forEach((r) => {
        lines.push([
          r.name,
          r.added
        ]);
      });

    } else if (tab === 'total') {
      head.push(
        'GROUPS',
        'MEMBERS'
      );

      rows.forEach((r) => {
        lines.push([
          r.name,
          Number(r.total) || 0
        ]);
      });
    }

    return {
      head,
      lines,
      rows
    };
  }

  /*
    FIXED EXPORT FUNCTION

    CSV:
      - creates `body`
      - returns body

    TXT:
      - creates `txt`
      - returns txt

    Previous version mixed these variables and caused:
      ReferenceError: body is not defined
  */

  function renderExport(
    tab,
    scope,
    format,
    ids
  ) {
    const {
      head,
      lines,
      rows
    } = buildExport(
      tab,
      scope,
      ids
    );

    const stamp =
      new Date().toLocaleDateString(
        'en-CA',
        {
          timeZone: TZ
        }
      );

    const base =
      `${tab}-list-${stamp}`;

    /* ---------------- CSV ---------------- */

    if (format === 'csv') {
      const body =
        [head, ...lines]
          .map((line) =>
            line
              .map(csvCell)
              .join(',')
          )
          .join('\r\n');

      return {
        name:
          `${base}.csv`,

        type:
          'text/csv; charset=utf-8',

        body:
          Buffer.from(
            '\uFEFF' +
              body,
            'utf8'
          )
      };
    }

    /* ---------------- TXT ---------------- */

    let txt = '';

    if (tab === 'total') {
      txt =
        'GROUPS           MEMBERS\n' +
        lines
          .map(
            ([group, count]) =>
              `${group} = ${count}`
          )
          .join('\n');

      const total =
        rows.reduce(
          (sum, r) =>
            sum +
            (Number(r.total) || 0),
          0
        );

      txt +=
        `\n\nTOTAL = ${total}`;

    } else if (tab === 'added') {
      txt =
        'GROUPS           TOTAL ADDED\n' +
        lines
          .map(
            ([group, count]) =>
              `${group} = ${count}`
          )
          .join('\n');

      const total =
        rows.reduce(
          (sum, r) =>
            sum +
            (Number(r.added) || 0),
          0
        );

      txt +=
        `\n\nTOTAL = ${total}`;

    } else if (tab === 'pending') {
      txt =
        'GROUPS           PENDING MEMBERS\n' +
        lines
          .map(
            ([group, count]) =>
              `${group} = ${count}`
          )
          .join('\n');

      const total =
        rows.reduce(
          (sum, r) =>
            sum +
            (Number(r.pending) || 0),
          0
        );

      txt +=
        `\n\nTOTAL = ${total}`;

    } else if (tab === 'link') {
      txt =
        'GROUPS           JOINED THROUGH INVITE LINKS\n' +
        lines
          .map(
            ([group, count]) =>
              `${group} = ${count}`
          )
          .join('\n');

      const total =
        rows.reduce(
          (sum, r) =>
            sum +
            (Number(r.link) || 0),
          0
        );

      txt +=
        `\n\nTOTAL = ${total}`;
    }

    return {
      name:
        `${base}.txt`,

      type:
        'text/plain; charset=utf-8',

      body:
        Buffer.from(
          '\uFEFF' +
            txt,
          'utf8'
        )
    };
  }

  /* ---------------- automatic refresh ---------------- */

  setInterval(
    () => {
      if (getSock()) {
        refreshAll().catch(
          () => {}
        );
      }
    },
    10 * 60 * 1000
  ).unref?.();

  return {
    load,
    attach,
    onOpen,
    flush,

    _t: {
      onParticipants,
      onJoinRequest,
      summary,
      renderExport,
      recs,
      statKey,
      ensure,
      getGroupCache,
      clients,
      refresh,
      refreshAll,
      sortedRows,
      leaderboard
    }
  };
}

/* =========================================================
   ROUTES
   ========================================================= */

export function registerStatsRoutes(
  app,
  requireAuth,
  needWA,
  getStats
) {
  /* ---------------- overview ---------------- */

  app.get(
    '/api/stats/overview',
    requireAuth,
    needWA,
    (req, res) => {
      const stats =
        getStats(
          req.user.userId
        );

      const rows =
        stats._t.sortedRows();

      const rf =
        stats._t.refresh;

      res.json({
        rows,

        leaderboard:
          stats._t.leaderboard(),

        refresh: rf,

        groupCount:
          rows.length,

        lastSync:
          rf.at || null,

        tz: TZ,

        now: Date.now()
      });
    }
  );

  /* ---------------- refresh ---------------- */

  app.post(
    '/api/stats/refresh',
    requireAuth,
    needWA,
    (req, res) => {
      const stats =
        getStats(
          req.user.userId
        );

      stats._t
        .refreshAll(true)
        .catch((e) =>
          console.error(
            '[stats] refresh:',
            e.message
          )
        );

      res.json({
        refresh:
          stats._t.refresh
      });
    }
  );

  /* ---------------- group detail ---------------- */

  app.get(
    '/api/stats/group/:id',
    requireAuth,
    needWA,
    (req, res) => {
      const stats =
        getStats(
          req.user.userId
        );

      const g =
        stats._t
          .getGroupCache()
          .data?.[
            req.params.id
          ];

      if (!g) {
        return res
          .status(404)
          .json({
            error:
              'Group not found'
          });
      }

      const r =
        stats._t.ensure(
          g.id,
          g
        );

      res.json({
        row:
          stats._t.summary(g),

        pending:
          (
            r.pending?.rows ||
            []
          ).map((x) => ({
            who:
              x.ph
                ? `+${x.ph}`
                : `ID ${x.p}`,

            method: x.m,

            at: x.t,

            by:
              x.m ===
              'non_admin_add'
                ? (
                    x.by
                      ? `ID ${x.by}`
                      : ''
                  )
                : ''
          })),

        recent:
          r.events
            .slice(-60)
            .reverse()
            .map((e) => ({
              at: e.t,

              kind: e.k,

              who:
                e.p
                  ? `ID ${e.p}`
                  : '',

              by:
                e.a || e.by
                  ? `ID ${
                      e.a || e.by
                    }`
                  : '',

              method: e.m
            }))
      });
    }
  );

  /* ---------------- SSE stream ---------------- */

  app.get(
    '/api/stats/stream',
    requireAuth,
    (req, res) => {
      const stats =
        getStats(
          req.user.userId
        );

      res.writeHead(
        200,
        {
          'Content-Type':
            'text/event-stream',

          'Cache-Control':
            'no-cache, no-transform',

          Connection:
            'keep-alive',

          'X-Accel-Buffering':
            'no'
        }
      );

      res.write(
        'retry: 3000\n\n'
      );

      stats._t.clients.add(
        res
      );

      const beat =
        setInterval(() => {
          try {
            res.write(
              ': hb\n\n'
            );
          } catch {}
        }, 25000);

      req.on(
        'close',
        () => {
          clearInterval(
            beat
          );

          stats._t.clients.delete(
            res
          );
        }
      );
    }
  );

  /* ---------------- export ---------------- */

  const exporter = (
    req,
    res
  ) => {
    const q = {
      ...req.query,
      ...(req.body || {})
    };

    const tab =
      [
        'pending',
        'link',
        'added',
        'total'
      ].includes(q.tab)
        ? q.tab
        : 'pending';

    const scope =
      q.scope === 'detail'
        ? 'detail'
        : 'summary';

    const format =
      q.format === 'txt'
        ? 'txt'
        : 'csv';

    const ids = (
      Array.isArray(q.ids)
        ? q.ids
        : String(
            q.ids || ''
          ).split(',')
    )
      .map((x) =>
        String(x).trim()
      )
      .filter(Boolean);

    const stats =
      getStats(
        req.user.userId
      );

    const out =
      stats._t.renderExport(
        tab,
        scope,
        format,
        ids
      );

    res.setHeader(
      'Content-Type',
      out.type
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${out.name}"`
    );

    res.send(out.body);
  };

  app.get(
    '/api/stats/export',
    requireAuth,
    needWA,
    exporter
  );

  app.post(
    '/api/stats/export',
    requireAuth,
    needWA,
    exporter
  );
}