(() => {
  const $ = (id) => document.getElementById(id);
  const tabs = [...document.querySelectorAll('#modes [data-mode]')];
  let mode = 'range';
  let groups = [];
  let selected = new Set();
  let rangeMatches = new Set();
  let plan = [];
  let previewPayloadJson = '';
  let pollTimer = null;
  let busy = false;
  let activeJobId = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function setMessage(message = '', type = '') {
    const el = $('message');
    el.textContent = message;
    el.className = 'notice' + (type ? ` ${type}` : '') + (message ? '' : ' hidden');
  }

  async function api(url, options = {}) {
    const res = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function updateHeader(connected, text) {
    $('waStatus').classList.toggle('connected', Boolean(connected));
    $('waText').textContent = text;
  }

  async function refreshStatus() {
    try {
      const d = await api('/api/status');
      updateHeader(d.state === 'connected', d.state === 'connected' ? 'Connected' : d.state === 'qr' ? 'Scan QR' : 'Checking…');
    } catch { updateHeader(false, 'Unavailable'); }
  }

  function selectedGroups() {
    const byId = new Map(groups.map((g) => [g.id, g]));
    return [...selected].map((id) => byId.get(id)).filter(Boolean);
  }

  function currentVisible(target, searchId, source = groups) {
    const q = $(searchId)?.value.trim().toLocaleLowerCase() || '';
    return source.filter((g) => !q || g.name.toLocaleLowerCase().includes(q) || String(g.num ?? '').includes(q));
  }

  function renderPicker(targetId, searchId, source = groups) {
    const target = $(targetId);
    const visible = currentVisible(target, searchId, source);
    if (!visible.length) {
      target.innerHTML = '<div class="notice">No matching groups found.</div>';
      return;
    }
    target.innerHTML = visible.map((g) => `
      <label class="group">
        <input type="checkbox" data-group-id="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''}>
        <span class="group-name">${esc(g.name || '(Unnamed group)')}</span>
        <span class="group-meta">${Number.isInteger(g.num) ? `#${g.num}` : '—'}</span>
      </label>`).join('');
    target.querySelectorAll('input[data-group-id]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.dataset.groupId;
        if (box.checked) selected.add(id); else selected.delete(id);
        updateCounts();
        invalidatePreview();
      });
    });
  }

  function updateCounts() {
    $('count').textContent = selected.size;
    $('total').textContent = groups.length;
    $('listCount').textContent = selected.size;
    $('listTotal').textContent = groups.length;
    $('rangeCount').textContent = [...selected].filter((id) => rangeMatches.has(id)).length;
  }

  function invalidatePreview() {
    plan = [];
    previewPayloadJson = '';
    $('rename').disabled = true;
    $('previewBox').classList.add('hidden');
  }

  async function loadGroups(force = false) {
    setMessage('Loading groups…');
    try {
      const data = await api(`/api/group-names${force ? '?refresh=1' : ''}`);
      groups = Array.isArray(data.groups) ? data.groups : [];
      const valid = new Set(groups.map((g) => g.id));
      selected = new Set([...selected].filter((id) => valid.has(id)));
      rangeMatches = new Set([...rangeMatches].filter((id) => valid.has(id)));
      // A refresh can change the current group names, so never leave an old
      // preview/rename plan active against freshly loaded data.
      invalidatePreview();
      renderPicker('groupList', 'search');
      renderPicker('listGroups', 'listSearch');
      renderPicker('rangeList', 'rangeSearch', groups.filter((g) => rangeMatches.has(g.id)));
      updateCounts();
      setMessage(`${groups.length} groups loaded.`, 'ok');
    } catch (e) {
      setMessage(e.message, 'error');
    }
  }

  function buildRangeMatches() {
    const prefix = String($('currentPrefix').value || '').trim();
    const from = Number($('currentFrom').value);
    const to = Number($('currentTo').value);
    if (!prefix) throw new Error('Enter the existing group prefix.');
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new Error('Enter a valid existing start and end number.');
    if (to - from + 1 > 1000) throw new Error('Please use a range of 1000 groups or less.');

    const wanted = new Set();
    const exactPrefix = prefix.replace(/\s+$/,'');
    for (const g of groups) {
      const name = String(g.name || '').trim();
      const m = name.match(/^(.*?)(\d+)\s*$/);
      if (!m) continue;
      const p = m[1].trimEnd();
      const n = Number(m[2]);
      if (p === exactPrefix && n >= from && n <= to) wanted.add(g.id);
    }
    rangeMatches = wanted;
    selected = new Set(wanted);
    renderPicker('rangeList', 'rangeSearch', groups.filter((g) => rangeMatches.has(g.id)));
    updateCounts();
    invalidatePreview();
    return wanted.size;
  }

  function numberValue(id, fallback = null) {
    const n = Number($(id).value);
    return Number.isInteger(n) ? n : fallback;
  }

  function payload() {
    if (mode === 'range') {
      return {
        mode,
        ids: [...selected].filter((id) => rangeMatches.has(id)),
        currentPrefix: $('currentPrefix').value,
        currentFrom: numberValue('currentFrom'),
        currentTo: numberValue('currentTo'),
        prefix: $('rangePrefix').value,
        startNumber: numberValue('rangeStart'),
        step: numberValue('rangeStep', 1),
        separator: $('rangeSep').value,
        digits: numberValue('rangeDigits', 0)
      };
    }
    if (mode === 'select') {
      return {
        mode,
        ids: [...selected],
        prefix: $('selectPrefix').value,
        startNumber: numberValue('selectStart'),
        step: numberValue('selectStep', 1),
        separator: $('selectSep').value,
        digits: numberValue('selectDigits', 0)
      };
    }
    return { mode, ids: [...selected], names: $('names').value };
  }

  async function preview() {
    $('preview').disabled = true;
    $('rename').disabled = true;
    $('progress').classList.add('hidden');
    setMessage('Building preview…');
    try {
      const body = payload();
      const data = await api('/api/group-names/preview', { method: 'POST', body: JSON.stringify(body) });
      plan = data.plan || [];
      previewPayloadJson = JSON.stringify(body);
      $('previewMeta').textContent = `${plan.length} group${plan.length === 1 ? '' : 's'} selected. Check every new name before renaming.`;
      if (!plan.length) throw new Error('No groups selected.');
      $('previewTable').innerHTML = `
        <table class="preview-table"><thead><tr><th>Existing group</th><th style="width:28px"> </th><th>New name</th></tr></thead><tbody>
        ${plan.map((x) => `<tr><td>${esc(x.oldName)}</td><td>→</td><td class="newname">${esc(x.newName)}</td></tr>`).join('')}
        </tbody></table>`;
      $('previewBox').classList.remove('hidden');
      $('rename').disabled = false;
      setMessage('Preview ready. Nothing will be renamed until you click Rename Groups.', 'ok');
    } catch (e) {
      plan = [];
      $('previewBox').classList.add('hidden');
      setMessage(e.message, 'error');
    } finally { $('preview').disabled = false; }
  }

  async function startRename() {
    if (busy || !plan.length) return;
    const body = payload();
    if (JSON.stringify(body) !== previewPayloadJson) {
      setMessage('The form changed after preview. Build the preview again before renaming.', 'error');
      return;
    }
    const ok = window.confirm(`Rename ${plan.length} group${plan.length === 1 ? '' : 's'}?`);
    if (!ok) return;
    busy = true;
    $('rename').disabled = true;
    $('preview').disabled = true;
    $('refresh').disabled = true;
    setMessage('Rename job started…');
    $('progress').classList.remove('hidden');
    try {
      const data = await api('/api/group-names', { method: 'POST', body: JSON.stringify(body) });
      if (data.job?.id) { activeJobId = data.job.id; await pollJob(data.job.id); }
    } catch (e) {
      busy = false;
      $('preview').disabled = false;
      setMessage(e.message, 'error');
    }
  }

  async function pollJob(id) {
    if (pollTimer) clearInterval(pollTimer);
    const run = async () => {
      try {
        const job = await api(`/api/group-name-job/${encodeURIComponent(id)}`);
        const total = Number(job.total || 0);
        const done = Number(job.done || 0);
        const pct = total ? Math.min(100, Math.round(done * 100 / total)) : 0;
        $('progressText').textContent = `${done} / ${total}`;
        $('progressState').textContent = job.phase === 'retrying' ? 'Retrying rate-limited groups…' : job.state === 'cancelled' ? 'Cancelled' : job.state === 'cancelling' ? 'Cancelling…' : job.state === 'done' ? 'Completed' : 'Renaming…';
        $('cancelRename').hidden = !['queued','running','cancelling'].includes(job.state);
        $('cancelRename').disabled = job.state === 'cancelling';
        $('bar').style.width = `${pct}%`;
        renderResults(job);
        if (['done','cancelled','error'].includes(job.state)) {
          clearInterval(pollTimer); pollTimer = null;
          busy = false;
          $('refresh').disabled = false;
          $('preview').disabled = false;
          if (job.state === 'done') {
            const results = job.results || [];
            const success = results.filter((x) => x.ok).length;
            const failed = results.length - success;
            setMessage(`${success} renamed successfully${failed ? `, ${failed} failed. Failed groups are listed below.` : '.'}`, failed ? '' : 'ok');
            await loadGroups(false);
            invalidatePreview();
          } else {
            setMessage(job.error || 'Rename job failed.', 'error');
          }
        }
      } catch (e) {
        clearInterval(pollTimer); pollTimer = null; busy = false;
        $('refresh').disabled = false; $('preview').disabled = false;
        setMessage(e.message, 'error');
      }
    };
    await run();
    if (pollTimer === null && busy) pollTimer = setInterval(run, 900);
  }

  function renderResults(job) {
    const results = job.results || [];
    const box = $('results');
    box.innerHTML = results.map((x) => `<div class="result-row"><div><span class="${x.ok ? 'ok' : 'bad'}">${x.ok ? '✓' : '✕'}</span> <b>${esc(x.oldName)}</b><span class="arrow">→</span>${esc(x.newName)}</div><div class="small ${x.ok ? 'ok' : 'bad'}">${x.ok ? 'Renamed' : esc(x.error || 'Failed')}</div></div>`).join('');
  }

  function showMode(next) {
    mode = next;
    tabs.forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
    ['range','select','list'].forEach((x) => $(`${x}Panel`).classList.toggle('on', x === mode));
    invalidatePreview();
    $('progress').classList.add('hidden');
    setMessage('');
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => showMode(tab.dataset.mode)));
  $('refresh').addEventListener('click', () => loadGroups(true));
  $('findRange').addEventListener('click', () => { try { const n = buildRangeMatches(); setMessage(`${n} matching group${n === 1 ? '' : 's'} found and selected.`, n ? 'ok' : 'error'); } catch (e) { setMessage(e.message, 'error'); } });
  $('rangeSearch').addEventListener('input', () => renderPicker('rangeList', 'rangeSearch', groups.filter((g) => rangeMatches.has(g.id))));
  $('rangeSelectVisible').addEventListener('click', () => { currentVisible('rangeList','rangeSearch',groups.filter((g)=>rangeMatches.has(g.id))).forEach((g)=>selected.add(g.id)); renderPicker('rangeList','rangeSearch',groups.filter((g)=>rangeMatches.has(g.id))); updateCounts(); invalidatePreview(); });
  $('rangeClear').addEventListener('click', () => { [...rangeMatches].forEach((id)=>selected.delete(id)); renderPicker('rangeList','rangeSearch',groups.filter((g)=>rangeMatches.has(g.id))); updateCounts(); invalidatePreview(); });
  $('search').addEventListener('input', () => renderPicker('groupList','search'));
  $('listSearch').addEventListener('input', () => renderPicker('listGroups','listSearch'));
  $('selectVisible').addEventListener('click', () => { currentVisible('groupList','search').forEach((g)=>selected.add(g.id)); renderPicker('groupList','search'); renderPicker('listGroups','listSearch'); updateCounts(); invalidatePreview(); });
  $('listSelectVisible').addEventListener('click', () => { currentVisible('listGroups','listSearch').forEach((g)=>selected.add(g.id)); renderPicker('listGroups','listSearch'); renderPicker('groupList','search'); updateCounts(); invalidatePreview(); });
  $('clearSelection').addEventListener('click', () => { selected.clear(); renderPicker('groupList','search'); renderPicker('listGroups','listSearch'); renderPicker('rangeList','rangeSearch',groups.filter((g)=>rangeMatches.has(g.id))); updateCounts(); invalidatePreview(); });
  $('listClear').addEventListener('click', () => { selected.clear(); renderPicker('groupList','search'); renderPicker('listGroups','listSearch'); renderPicker('rangeList','rangeSearch',groups.filter((g)=>rangeMatches.has(g.id))); updateCounts(); invalidatePreview(); });
  $('preview').addEventListener('click', preview);
  $('rename').addEventListener('click', startRename);
  $('cancelRename').addEventListener('click', async () => {
    if (!activeJobId || !confirm('Cancel this operation? Changes already completed cannot be undone.')) return;
    try { await api(`/api/group-name-job/${encodeURIComponent(activeJobId)}/cancel`, { method:'POST', body:'{}' }); }
    catch (e) { setMessage(e.message, 'error'); }
  });

  loadGroups(false);
  refreshStatus();
  setInterval(refreshStatus, 10000);
})();
