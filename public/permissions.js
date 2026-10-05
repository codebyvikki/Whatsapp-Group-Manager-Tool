const $ = (id) => document.getElementById(id);

const PERMISSIONS = [
  { key: 'editGroupSettings', label: 'Edit group settings' },
  { key: 'sendNewMessages', label: 'Send new messages' },
  { key: 'addOtherMembers', label: 'Add other members' },
  { key: 'approveNewMembers', label: 'Approve new members' }
];

let activePermissionJobId = null;

const state = {
  groups: [],
  selected: new Set(),
  pending: {},
  maxGroups: 500,
  busy: false,
  lastResults: [],
  lastChanges: {}
};

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  return data;
}

function setStatus(connected, text) {
  $('waStatus').classList.toggle('connected', Boolean(connected));
  $('waStatus').classList.toggle('disconnected', !connected);
  $('waStatusText').textContent = text;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>'"]/g,
    (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[c])
  );
}

function groupById(id) {
  return state.groups.find((g) => g.id === id) || null;
}

function filteredGroups() {
  const q = $('search').value.trim().toLowerCase();

  if (!q) {
    return state.groups;
  }

  return state.groups.filter((g) =>
    String(g.name || '').toLowerCase().includes(q)
  );
}

function renderGroups() {
  const groups = filteredGroups();

  $('visibleCount').textContent = groups.length;
  $('totalCount').textContent = state.groups.length;
  $('selectedCount').textContent = state.selected.size;

  if (!groups.length) {
    $('groupList').innerHTML =
      '<div class="empty">No matching groups found.</div>';
    return;
  }

  $('groupList').innerHTML = groups.map((g) => `
    <label class="group-row">
      <input
        class="group-check"
        type="checkbox"
        data-group-id="${escapeHtml(g.id)}"
        ${state.selected.has(g.id) ? 'checked' : ''}
      >

      <span>
        <span class="group-name">
          ${escapeHtml(g.name || '(Unnamed group)')}
        </span>

        <span class="group-sub">
          ${Number.isFinite(g.num) ? `Number ${g.num} · ` : ''}
          ${g.size ?? 0} members
        </span>
      </span>

      <span class="group-sub">
        ${state.selected.has(g.id) ? 'Selected' : ''}
      </span>
    </label>
  `).join('');

  document.querySelectorAll('.group-check').forEach((el) => {
    el.addEventListener('change', () => {
      if (el.checked) {
        state.selected.add(el.dataset.groupId);
      } else {
        state.selected.delete(el.dataset.groupId);
      }

      /*
       * Changing the selection invalidates any staged bulk permission
       * changes because the target group set has changed.
       */
      state.pending = {};

      renderGroups();
      renderPermissions();
      renderPending();
    });
  });
}

function selectedGroups() {
  return [...state.selected]
    .map(groupById)
    .filter(Boolean);
}

function aggregate(key) {
  const groups = selectedGroups();

  if (!groups.length) {
    return null;
  }

  const values = groups.map((g) => g.permissions?.[key]);

  /*
   * If any group does not expose a valid boolean value,
   * don't guess its state.
   */
  if (values.some((v) => typeof v !== 'boolean')) {
    return null;
  }

  /*
   * All same -> true / false.
   * Different -> mixed.
   *
   * "mixed" remains an internal state only.
   * The UI will intentionally display it as OFF.
   */
  return values.every((v) => v === values[0])
    ? values[0]
    : 'mixed';
}

function effectiveAggregate(key) {
  if (
    Object.prototype.hasOwnProperty.call(
      state.pending,
      key
    )
  ) {
    return state.pending[key];
  }

  return aggregate(key);
}

/*
 * IMPORTANT UI BEHAVIOUR
 *
 * We keep "mixed" internally so the application still knows that
 * selected groups have different real states.
 *
 * Visually:
 *   true  -> ON
 *   false -> OFF
 *   mixed -> OFF
 *
 * Therefore the switch NEVER sits in the middle.
 */
function renderPermissionButton(key) {
  const value = effectiveAggregate(key);

  const btn = $(`perm-${key}`);
  const stateEl = $(`state-${key}`);

  if (!btn || !stateEl) {
    return;
  }

  /*
   * Always remove both visual states first.
   * This is important when switching from mixed -> normal.
   */
  btn.classList.remove('on');
  btn.classList.remove('mixed');

  const hasSelection = state.selected.size > 0;

  btn.disabled = !hasSelection || state.busy;

  /*
   * Accessibility state.
   *
   * Mixed is intentionally treated as OFF visually.
   * Clicking it will stage ON.
   */
  btn.setAttribute(
    'aria-pressed',
    value === true ? 'true' : 'false'
  );

  if (value === true) {
    btn.classList.add('on');
    stateEl.textContent = 'ON';
  } else if (value === false) {
    stateEl.textContent = 'OFF';
  } else if (value === 'mixed') {
    /*
     * No .mixed class.
     * No center position.
     *
     * The UI intentionally presents mixed as OFF.
     */
    stateEl.textContent = 'OFF';
  } else {
    stateEl.textContent = '—';
  }
}

function renderPermissions() {
  const groups = selectedGroups();
  const count = groups.length;

  $('selectionNotice').innerHTML = count
    ? `<strong>${count} group${count === 1 ? '' : 's'} selected.</strong> Toggle a permission to stage a bulk change for all selected groups.`
    : '<strong>No groups selected.</strong> Select one or more groups above to view their current permission state.';

  /*
   * Render all supported permissions.
   */
  for (const permission of PERMISSIONS) {
    renderPermissionButton(permission.key);
  }

  /*
   * Send message history is intentionally unsupported.
   * Keep it disabled exactly as before.
   */
  const historyBtn = $('perm-sendMessageHistory');

  historyBtn.disabled = true;
  historyBtn.classList.remove('on');
  historyBtn.classList.remove('mixed');
  historyBtn.classList.add('unsupported');

  $('state-sendMessageHistory').textContent = 'Unavailable';
}

function renderPending() {
  const entries = Object.entries(state.pending);

  $('pendingBox').classList.toggle(
    'show',
    entries.length > 0
  );

  $('applyChanges').disabled =
    !entries.length ||
    !state.selected.size ||
    state.busy;

  $('pendingList').innerHTML = entries.map(
    ([key, value]) => {
      const label =
        PERMISSIONS.find((p) => p.key === key)?.label ||
        key;

      return `
        <span class="chip">
          ${escapeHtml(label)} → ${value ? 'ON' : 'OFF'}
        </span>
      `;
    }
  ).join('');
}

function setRangeInfo(text, warning = false) {
  const el = $('rangeInfo');

  if (!text) {
    el.classList.add('hidden');
    el.classList.remove('warning');
    el.innerHTML = '';
    return;
  }

  el.classList.remove('hidden');
  el.classList.toggle('warning', warning);
  el.innerHTML = text;
}

function selectRange() {
  const prefix = $('prefix').value.trim();
  const from = Number($('from').value);
  const to = Number($('to').value);

  if (
    !prefix ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < 0 ||
    to < from
  ) {
    setRangeInfo(
      '<strong>Enter a valid prefix and range.</strong> Example: School Group · 10 → 40',
      true
    );
    return;
  }

  const wanted = [];

  for (let n = from; n <= to; n++) {
    wanted.push(n);
  }

  const byNum = new Map();

  const prefixEsc = prefix.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );

  const re = new RegExp(
    `^${prefixEsc}\\s*(\\d+)\\s*$`,
    'i'
  );

  for (const g of state.groups) {
    const m = String(g.name || '').match(re);

    if (!m) {
      continue;
    }

    const n = Number(m[1]);

    if (!byNum.has(n)) {
      byNum.set(n, g);
    }
  }

  const found = [];
  const missing = [];

  for (const n of wanted) {
    const g = byNum.get(n);

    if (g) {
      found.push(g);
    } else {
      missing.push(n);
    }
  }

  state.selected = new Set(
    found
      .slice(0, state.maxGroups)
      .map((g) => g.id)
  );

  state.pending = {};

  renderGroups();
  renderPermissions();
  renderPending();

  const limitNote =
    found.length > state.maxGroups
      ? ` · limited to ${state.maxGroups}`
      : '';

  const missingNote = missing.length
    ? ` <span>Missing: <strong>${missing.length}</strong> (${missing
        .slice(0, 12)
        .join(', ')}${missing.length > 12 ? ', …' : ''})</span>`
    : '<span>Missing: <strong>0</strong></span>';

  setRangeInfo(
    `<span>Requested: <strong>${wanted.length}</strong></span>` +
    `<span>Available: <strong>${found.length}</strong>${limitNote}</span>` +
    missingNote
  );
}

function togglePermission(key) {
  if (state.busy || !state.selected.size) {
    return;
  }

  const current = effectiveAggregate(key);

  /*
   * ON -> OFF
   * OFF -> ON
   * MIXED -> ON
   *
   * This keeps bulk behaviour deterministic.
   */
  const next = current === true ? false : true;

  state.pending[key] = next;

  renderPermissions();
  renderPending();
}

function clearSelection() {
  state.selected.clear();
  state.pending = {};

  setRangeInfo();

  renderGroups();
  renderPermissions();
  renderPending();
}

function selectVisible() {
  for (const g of filteredGroups()) {
    if (state.selected.size >= state.maxGroups) {
      break;
    }

    state.selected.add(g.id);
  }

  state.pending = {};

  renderGroups();
  renderPermissions();
  renderPending();
}

async function loadGroups(force = false) {
  try {
    setStatus(false, 'Loading groups…');

    const data = await api(
      `/api/group-permissions${force ? '?refresh=1' : ''}`
    );

    state.groups = data.groups || [];
    state.maxGroups = data.maxGroups || 500;

    state.selected.clear();
    state.pending = {};

    setStatus(
      true,
      `${state.groups.length} groups loaded`
    );

    renderGroups();
    renderPermissions();
    renderPending();

  } catch (e) {
    if (/Login required/i.test(e.message)) {
      window.location.replace('/');
      return;
    }

    setStatus(false, e.message);

    $('groupList').innerHTML =
      `<div class="empty">${escapeHtml(e.message)}</div>`;
  }
}

function setBusy(busy) {
  state.busy = busy;

  $('refreshGroups').disabled = busy;
  $('selectVisible').disabled = busy;
  $('clearSelection').disabled = busy;
  $('selectRange').disabled = busy;

  renderGroups();
  renderPermissions();
  renderPending();
}

function renderJob(job) {
  const total = Math.max(1, job.total || 0);

  const pct = Math.min(
    100,
    Math.round((job.done / total) * 100)
  );

  $('progressWrap').classList.add('show');

  $('progressFill').style.width = `${pct}%`;
  $('progressPercent').textContent = `${pct}%`;

  $('cancelPermission').hidden = !['queued','running','cancelling'].includes(job.state);
  $('cancelPermission').disabled = job.state === 'cancelling';

  if (job.state === 'done') {
    const failed =
      (job.results || []).filter(
        (r) => !r.ok
      ).length;

    $('progressText').textContent = failed
      ? `Finished ${job.done} / ${job.total} groups · ${failed} still need attention`
      : `Completed & verified ${job.done} / ${job.total} groups`;

  } else if (job.state === 'cancelled') {
    $('progressText').textContent = `Cancelled after ${job.done} / ${job.total} groups`;
  } else if (job.state === 'cancelling') {
    $('progressText').textContent = `Cancelling after ${job.done} / ${job.total} groups…`;
  } else if (job.phase === 'retrying') {
    $('progressText').textContent =
      `Retrying ${job.remaining ?? 0} groups that still need changes`;

  } else if (job.phase === 'verifying') {
    $('progressText').textContent =
      `Verifying WhatsApp state · ${job.remaining ?? 0} groups still need checking`;

  } else {
    $('progressText').textContent =
      `Applying ${job.done} / ${job.total} groups`;
  }
}

function renderResult(job) {
  state.lastResults = job.results || [];

  const ok =
    state.lastResults.filter((r) => r.ok).length;

  const failed =
    state.lastResults.length - ok;

  $('resultBox').classList.add('show');

  $('resultDescription').textContent =
    `${ok} updated successfully${failed ? ` · ${failed} failed` : ''}.`;

  $('resultSummary').innerHTML = `
    <span class="result-pill ok">
      ✓ ${ok} updated
    </span>

    <span class="result-pill fail">
      ⚠ ${failed} failed
    </span>
  `;

  $('retryFailed').disabled = failed === 0;

  $('resultList').innerHTML =
    state.lastResults.map((r) => `
      <div class="result-row">
        <span class="${r.ok ? 'result-ok' : 'result-fail'}">
          ${r.ok ? '✓' : '!'}
        </span>

        <span>
          ${escapeHtml(r.name)}
        </span>

        <span class="${r.ok ? 'result-ok' : 'result-fail'}">
          ${r.ok
            ? 'Updated'
            : escapeHtml(r.error || 'Failed')}
        </span>
      </div>
    `).join('');
}

async function waitForJob(id) {
  for (;;) {
    const job = await api(
      `/api/group-permission-job/${encodeURIComponent(id)}`
    );

    renderJob(job);

    if (
      ['done','cancelled','error'].includes(job.state)
    ) {
      if (job.state === 'error') {
        throw new Error(
          job.error || 'Permission job failed'
        );
      }

      renderResult(job);
      return job;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 250)
    );
  }
}

async function applyChanges(
  ids = [...state.selected],
  changes = { ...state.pending }
) {
  if (
    !ids.length ||
    !Object.keys(changes).length ||
    state.busy
  ) {
    return;
  }

  if (ids.length > state.maxGroups) {
    alert(
      `Please select no more than ${state.maxGroups} groups at once.`
    );
    return;
  }

  /*
   * Only send groups whose current state actually differs
   * from the requested state.
   *
   * This keeps the existing performance optimisation.
   */
  const targetIds = ids.filter((id) => {
    const group = groupById(id);

    return (
      group &&
      Object.entries(changes).some(
        ([key, value]) =>
          group.permissions?.[key] !== value
      )
    );
  });

  if (!targetIds.length) {
    alert(
      'All selected groups already have these permission settings. No WhatsApp changes are needed.'
    );
    return;
  }

  const labels = Object.entries(changes)
    .map(([key, value]) => {
      const label =
        PERMISSIONS.find(
          (p) => p.key === key
        )?.label || key;

      return `${label} → ${value ? 'ON' : 'OFF'}`;
    })
    .join('\n');

  const confirmed = window.confirm(
    `Apply these permission changes to ${targetIds.length} group${
      targetIds.length === 1 ? '' : 's'
    }?\n\n${labels}`
  );

  if (!confirmed) {
    return;
  }

  setBusy(true);

  $('resultBox').classList.remove('show');

  $('progressWrap').classList.add('show');
  $('progressFill').style.width = '0%';
  $('progressPercent').textContent = '0%';
  $('progressText').textContent = 'Starting…';

  try {
    const data = await api(
      '/api/group-permissions',
      {
        method: 'POST',
        body: JSON.stringify({
          ids: targetIds,
          changes
        })
      }
    );

    activePermissionJobId = data.job.id;
    await waitForJob(data.job.id);

    state.pending = {};

    /*
     * Refresh from WhatsApp so the next toggle reflects
     * the actual server state.
     */
    await loadGroups(true);

  } catch (e) {
    alert(e.message);

  } finally {
    setBusy(false);
  }
}

function retryFailed() {
  const failedIds =
    state.lastResults
      .filter((r) => !r.ok)
      .map((r) => r.id);

  if (!failedIds.length) {
    return;
  }

  if (
    !state.lastChanges ||
    !Object.keys(state.lastChanges).length
  ) {
    return;
  }

  applyChanges(
    failedIds,
    { ...state.lastChanges }
  );
}

async function boot() {
  try {
    const me = await api('/api/me');

    if (!me.loggedIn) {
      window.location.replace('/');
      return;
    }

    $('accountName').textContent =
      me.user.username;

    document.querySelector(
      '.account-role'
    ).textContent =
      me.user.role === 'admin'
        ? 'Admin'
        : 'User';

    $('loading').classList.add('hidden');
    $('app').style.display = 'grid';

    await loadGroups(false);

  } catch (e) {
    window.location.replace('/');
  }
}

$('search').addEventListener(
  'input',
  renderGroups
);

$('selectVisible').addEventListener(
  'click',
  selectVisible
);

$('clearSelection').addEventListener(
  'click',
  clearSelection
);

$('selectRange').addEventListener(
  'click',
  selectRange
);

$('refreshGroups').addEventListener(
  'click',
  () => loadGroups(true)
);

$('signOut').addEventListener(
  'click',
  async () => {
    try {
      await api(
        '/api/logout',
        { method: 'POST' }
      );
    } finally {
      window.location.replace('/');
    }
  }
);

for (
  const btn of
  document.querySelectorAll('.switch[data-key]')
) {
  btn.addEventListener(
    'click',
    () => togglePermission(btn.dataset.key)
  );
}

$('cancelPermission').addEventListener('click', async () => {
  if (!activePermissionJobId || !confirm('Cancel this operation? Changes already completed cannot be undone.')) return;
  try {
    const job = await api(`/api/group-permission-job/${encodeURIComponent(activePermissionJobId)}/cancel`, { method:'POST', body:'{}' });
    renderJob(job);
  } catch (e) { alert(e.message); }
});

$('applyChanges').addEventListener(
  'click',
  async () => {
    state.lastChanges = {
      ...state.pending
    };

    await applyChanges();
  }
);

$('retryFailed').addEventListener(
  'click',
  retryFailed
);

boot();