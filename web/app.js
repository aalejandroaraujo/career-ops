'use strict';
/**
 * career-ops web UI.
 *
 * Talks only to /api/tracker/* — the same API the Hermes MCP tools use, so the
 * two front doors cannot show different things. Rows are addressed by app_uid
 * (never by row number, which merge-tracker renumbers), and every status change
 * carries the row's etag as If-Match so an edit made while a batch re-evaluation
 * was running is rejected rather than silently clobbering it.
 *
 * Escaping/rollback patterns adapted from the portal prototype in PR #7.
 */

const $ = (s) => document.querySelector(s);
const STATUS_ORDER = ['Interview', 'Offer', 'Responded', 'Applied', 'Evaluated', 'SKIP', 'Rejected', 'Discarded'];
const ONGOING = ['Applied', 'Responded', 'Interview', 'Offer'];

let ROWS = [];
let STATES = [];
let filter = 'all';   // 'ongoing' | 'all' | a canonical status
let view = localStorage.getItem('co.view') || 'cards';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const scoreNum = (s) => { const m = String(s || '').match(/^(\d(?:\.\d)?)\/5/); return m ? Number(m[1]) : null; };
const fitClass = (n) => n == null ? '' : n >= 4.2 ? 'hi' : n >= 3.4 ? 'mid' : 'lo';

async function api(path, opts = {}) {
  const r = await fetch(`/api/tracker/${path}`, opts);
  if (r.status === 401) { showLogin(); throw new Error('signed out'); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(body.message || body.error || `HTTP ${r.status}`); e.body = body; e.status = r.status; throw e; }
  return body;
}

// ── auth ─────────────────────────────────────────────────────────────────────
function showLogin() { $('#login').hidden = false; $('#app').hidden = true; }
function showApp() { $('#login').hidden = true; $('#app').hidden = false; }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').hidden = true;
  const r = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: $('#password').value }),
  });
  if (!r.ok) { $('#loginErr').hidden = false; $('#password').select(); return; }
  $('#password').value = '';
  showApp();
  // Signing in lands on Applications (tracker), where all evaluations are visible.
  // "My day" is for daily decisions; the tracker is the primary view.
  setTab('tracker');
  load();
  loadPipeline();
  loadToday();
  loadConfig();
  startHealthPolling();
});

$('#logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  ROWS = [];
  PIPE = [];
  TODAY = null;
  $('#pipeCount').textContent = '';
  $('#todayCount').textContent = '';
  stopHealthPolling();
  showLogin();
};

// ── AI provider + model ──────────────────────────────────────────────────────
// Which CLI and model run evaluations and CVs. The server owns the choice (it
// lives in config/profile.yml), so the header shows only what /api/config last
// returned — never an optimistic local value. The old <select> never saved and
// reverted on reload, which is how "switch to Claude" silently did nothing.
/** Last payload from /api/config: {provider, model, locked, catalog}. */
let CONFIG = null;
/** Choice being edited in the open panel: {provider, model}. */
let draft = null;
const CUSTOM = '__custom';

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    if (r.status === 401) return;
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || body.error || `HTTP ${r.status}`);
    CONFIG = body;
    renderModelLabel();
  } catch {
    $('#modelLabel').textContent = 'unavailable';
    $('#modelBtn').title = 'Could not read the AI setting from the evaluation server';
  }
}

const providerLabel = (cfg, id) => cfg.catalog?.[id]?.label || id;
const modelLabel = (cfg, provider, id) =>
  cfg.catalog?.[provider]?.models?.find((m) => m.id === id)?.label || id;

function renderModelLabel() {
  if (!CONFIG) return;
  const p = providerLabel(CONFIG, CONFIG.provider).replace(/ Code$/, '');
  const m = CONFIG.model ? modelLabel(CONFIG, CONFIG.provider, CONFIG.model).replace(/ \(latest\)$/, '') : 'default';
  // Two spans so a phone-width header can drop the provider and keep the model
  // (or keep the provider when the model is just the CLI default).
  $('#modelLabel').innerHTML = `<span class="ml-p">${esc(p)}</span><span class="ml-m">${esc(m)}</span>`;
  $('#modelBtn').classList.toggle('has-model', Boolean(CONFIG.model));
  $('#modelBtn').title = `Evaluations and CVs run on ${providerLabel(CONFIG, CONFIG.provider)}, model: ${CONFIG.model || 'CLI default'}`;
}

function setModelMsg(text, cls = '') {
  const el = $('#mpMsg');
  el.className = `act-msg ${cls}`;
  el.textContent = text;
}

function renderModelPanel() {
  const locked = CONFIG.locked || {};
  $('#mpProviders').innerHTML = Object.entries(CONFIG.catalog || {}).map(([id, p]) => `
    <label class="mp-opt${id === draft.provider ? ' on' : ''}">
      <input type="radio" name="mpProvider" value="${esc(id)}"${id === draft.provider ? ' checked' : ''}${locked.provider ? ' disabled' : ''} />
      ${esc(p.label)}
    </label>`).join('');

  const models = CONFIG.catalog?.[draft.provider]?.models || [];
  const custom = !models.some((m) => m.id === draft.model);
  const dis = locked.model ? ' disabled' : '';
  $('#mpModels').innerHTML = models.map((m) => `
    <label class="mp-row${!custom && m.id === draft.model ? ' on' : ''}">
      <input type="radio" name="mpModel" value="${esc(m.id)}"${!custom && m.id === draft.model ? ' checked' : ''}${dis} />
      <span><b>${esc(m.label)}</b>${m.hint ? `<small>${esc(m.hint)}</small>` : ''}</span>
    </label>`).join('') + `
    <label class="mp-row${custom ? ' on' : ''}">
      <input type="radio" name="mpModel" value="${CUSTOM}"${custom ? ' checked' : ''}${dis} />
      <span><b>Custom…</b>
        <input id="mpCustom" type="text" placeholder="model id, e.g. claude-sonnet-5" value="${custom ? esc(draft.model) : ''}"
          autocomplete="off" autocapitalize="off" spellcheck="false"${custom ? '' : ' tabindex="-1"'}${dis} />
      </span>
    </label>`;

  const lockEl = $('#mpLock');
  lockEl.hidden = !(locked.provider || locked.model);
  lockEl.textContent = [
    locked.provider ? `Provider is fixed by CAREEROPS_PROVIDER in the container environment.` : '',
    locked.model ? `Model is fixed by CAREEROPS_MODEL in the container environment.` : '',
  ].filter(Boolean).join(' ') + ' Remove it from .env and recreate the containers to choose here.';
  updateModelSave();
}

/** The model the panel currently points at, or null for an empty custom field. */
function chosenModel() {
  const picked = document.querySelector('input[name="mpModel"]:checked')?.value ?? '';
  if (picked !== CUSTOM) return picked;
  return $('#mpCustom').value.trim() || null;
}

function updateModelSave() {
  const model = chosenModel();
  const unchanged = draft.provider === CONFIG.provider && model === CONFIG.model;
  $('#mpSave').disabled = model === null || unchanged;
}

function openModelPanel() {
  if (!CONFIG) { loadConfig(); return; }
  draft = { provider: CONFIG.provider, model: CONFIG.model || '' };
  setModelMsg('');
  renderModelPanel();
  $('#modelPanel').hidden = false;
  $('#modelBtn').setAttribute('aria-expanded', 'true');
  document.querySelector('#modelPanel input:checked:not(:disabled)')?.focus();
}

function closeModelPanel() {
  if ($('#modelPanel').hidden) return;
  $('#modelPanel').hidden = true;
  $('#modelBtn').setAttribute('aria-expanded', 'false');
}

$('#modelBtn').addEventListener('click', () => {
  if ($('#modelPanel').hidden) openModelPanel(); else closeModelPanel();
});
$('#mpCancel').addEventListener('click', () => { closeModelPanel(); $('#modelBtn').focus(); });

$('#modelPanel').addEventListener('change', (e) => {
  const t = /** @type {HTMLInputElement} */ (e.target);
  if (t.name === 'mpProvider') {
    // Model ids do not carry across providers; going back restores the saved one.
    draft = { provider: t.value, model: t.value === CONFIG.provider ? (CONFIG.model || '') : '' };
    setModelMsg('');
    renderModelPanel();
    return;
  }
  if (t.name === 'mpModel') {
    // No re-render here: an empty Custom field reads as "CLI default" and would
    // flip the selection back before the user has typed anything.
    document.querySelectorAll('#mpModels .mp-row').forEach((r) => r.classList.toggle('on', r.contains(t)));
    const box = $('#mpCustom');
    box.tabIndex = t.value === CUSTOM ? 0 : -1;
    if (t.value === CUSTOM) box.focus();
    draft.model = chosenModel() ?? '';
    updateModelSave();
  }
});

$('#modelPanel').addEventListener('input', (e) => {
  if (/** @type {HTMLElement} */ (e.target).id !== 'mpCustom') return;
  const radio = document.querySelector(`input[name="mpModel"][value="${CUSTOM}"]`);
  if (radio && !radio.checked) {
    radio.checked = true;
    document.querySelectorAll('#mpModels .mp-row').forEach((r) => r.classList.toggle('on', r.contains(radio)));
  }
  draft.model = $('#mpCustom').value.trim();
  updateModelSave();
});

$('#mpSave').addEventListener('click', async () => {
  const model = chosenModel();
  if (model === null) { setModelMsg('Type a model id first', 'bad'); return; }
  const btn = $('#mpSave');
  btn.disabled = true;
  setModelMsg('Saving…');
  try {
    const r = await fetch('/api/config/provider', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: draft.provider, model }),
    });
    if (r.status === 401) { showLogin(); return; }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      setModelMsg(body.message || body.error || `Save failed (HTTP ${r.status})`, 'bad');
      updateModelSave();
      return;
    }
    CONFIG = body;
    draft = { provider: CONFIG.provider, model: CONFIG.model || '' };
    renderModelLabel();
    renderModelPanel();
    const note = body.message && body.message !== 'saved' ? body.message : '';
    setModelMsg(note ? `Saved — ${note}` : 'Saved', 'ok');
    // A plain save closes itself; one with a caveat stays open to be read.
    if (!note) setTimeout(closeModelPanel, 900);
  } catch (err) {
    setModelMsg(`Save failed: ${err.message}`, 'bad');
    updateModelSave();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modelPanel').hidden) { closeModelPanel(); $('#modelBtn').focus(); }
});
document.addEventListener('click', (e) => {
  if (!$('#modelPanel').hidden && !$('#modelPicker').contains(/** @type {Node} */ (e.target))) closeModelPanel();
});

// ── data ─────────────────────────────────────────────────────────────────────
async function load() {
  try {
    const [data, states] = await Promise.all([api('applications'), api('states')]);
    ROWS = data.rows;
    STATES = states.states;
    if (!data.migrated) {
      $('#stats').innerHTML = '<span class="err">This tracker has no UID column — run <code>npm run tracker:migrate</code>. Editing is disabled.</span>';
    }
    renderChips();
    render();
  } catch (e) {
    if (e.message !== 'signed out') $('#stats').innerHTML = `<span class="err">${esc(e.message)}</span>`;
  }
}

function visible() {
  const q = $('#search').value.trim().toLowerCase();
  return ROWS.filter((r) => {
    if (filter === 'ongoing' && !ONGOING.includes(r.status)) return false;
    if (filter !== 'ongoing' && filter !== 'all' && r.status !== filter) return false;
    if (q && !`${r.company} ${r.role} ${r.notes}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function renderChips() {
  const counts = ROWS.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  const ongoingCount = ROWS.filter((r) => ONGOING.includes(r.status)).length;
  const chips = [
    ['ongoing', `Ongoing ${ongoingCount}`],
    ['all', `All ${ROWS.length}`],
    ...STATUS_ORDER.filter((s) => counts[s]).map((s) => [s, `${s} ${counts[s]}`]),
  ];
  $('#chips').innerHTML = chips.map(([key, label]) =>
    `<button class="chip" data-filter="${esc(key)}" aria-pressed="${filter === key}">${esc(label)}</button>`).join('');
}

function cardHtml(r) {
  const n = scoreNum(r.score);
  const opts = STATES.map((s) => `<option ${s === r.status ? 'selected' : ''}>${esc(s)}</option>`).join('');
  // Check if entry is recent (last 7 days) for visual indicator
  const isRecent = r.date && (new Date() - new Date(r.date)) < 7 * 24 * 60 * 60 * 1000;
  const recentBadge = isRecent ? '<span class="new-badge">NEW</span>' : '';
  const meta = [
    r.date ? `<span>📅 ${esc(r.date)}</span>` : '',
    r.age_days != null ? `<span>⏳ ${r.age_days}d</span>` : '',
    r.pdf === '✅' ? '<span>📄 CV</span>' : '',
  ].join('');
  // The company name goes to the JOB, not to our own metadata — that is the
  // link you actually want when scanning a list. Details stay one tap away on
  // the explicit button below.
  const co = r.jd_url
    ? `<a class="co" href="${esc(r.jd_url)}" target="_blank" rel="noopener noreferrer">${esc(r.company)} ↗</a>`
    : `<span class="co nolink" title="${esc(r.jd_note || 'no JD link in the report')}">${esc(r.company)}</span>`;
  return `<div class="card${isRecent ? ' recent' : ''}" data-uid="${esc(r.app_uid)}">
    <div class="top">
      ${co}
      <div class="fit ${fitClass(n)}">${esc(r.score || '—')}${recentBadge}</div>
    </div>
    <div class="role">${esc(r.role)}</div>
    <div class="meta">${meta}</div>
    <div class="foot">
      <select class="status" data-s="${esc(r.status)}" data-uid="${esc(r.app_uid)}" ${r.app_uid ? '' : 'disabled'}>${opts}</select>
      <button class="link" data-view="${esc(r.app_uid)}">Details</button>
    </div>
  </div>`;
}

/**
 * The empty line, told the truth.
 *
 * "Nothing here. Send a job URL…" is a lie when 107 rows exist and a leftover
 * search is hiding all of them — which is exactly what a stale search term in a
 * box that My day and Queue hide looks like. Whoever renders a tab owns this
 * line, and says what is actually filtering.
 */
function showEmpty(msg, clearable = false) {
  const el = $('#empty');
  el.innerHTML = `${esc(msg)}${clearable
    ? ' <button class="act view" data-act="clearsearch">Clear search</button>' : ''}`;
  el.hidden = false;
}

function render() {
  const list = visible();
  // load() runs on every tab, and it finishes after setTab() has laid the tab
  // out — so this has to respect the active tab or the tracker's 186 cards
  // reappear underneath My day a moment after it renders.
  const onTracker = TAB === 'tracker';
  $('#rows').hidden = !onTracker || view !== 'cards';
  $('#board').hidden = !onTracker || view !== 'board';

  // Get today's evaluations for the "Today" section
  const todayStr = new Date().toISOString().split('T')[0];
  const todayEvals = ROWS.filter(r => r.date === todayStr).sort((a, b) => {
    // Sort by time if available, otherwise by report number (higher = newer)
    const numA = parseInt(a.report?.match(/\[(\d+)\]/)?.[1] || '0');
    const numB = parseInt(b.report?.match(/\[(\d+)\]/)?.[1] || '0');
    return numB - numA;
  });

  if (view === 'cards') {
    list.sort((a, b) => (scoreNum(b.score) || 0) - (scoreNum(a.score) || 0));
    // Prepend today's evaluations section if there are any
    const todaySection = todayEvals.length && onTracker ? `
      <div class="today-evals-section">
        <h3 class="today-evals-header">📋 Evaluated today <span class="count">${todayEvals.length}</span></h3>
        <div class="today-evals-grid">${todayEvals.map(cardHtml).join('')}</div>
      </div>
    ` : '';
    $('#rows').innerHTML = todaySection + list.filter(r => r.date !== todayStr).map(cardHtml).join('');
  } else {
    // Kanban: one column per canonical status, ordered by pipeline stage.
    const cols = (filter === 'ongoing' ? ONGOING.slice().reverse() : STATUS_ORDER)
      .map((s) => {
        const items = list.filter((r) => r.status === s);
        return `<section class="col">
          <h2>${esc(s)} <span class="count">${items.length}</span></h2>
          <div class="stack">${items.map(cardHtml).join('') || '<div class="none">—</div>'}</div>
        </section>`;
      }).join('');
    $('#board').innerHTML = cols;
  }

  // Only the visible tab may touch the shared empty line and stats — load()
  // runs on every tab, and blanking another tab's message from here is what
  // turned a filtered Scouted list into a blank panel.
  if (onTracker) {
    const q = $('#search').value.trim();
    if (list.length) $('#empty').hidden = true;
    else if (ROWS.length) {
      showEmpty(q
        ? `No application matches "${q}"${filter !== 'all' ? ` in ${filter}` : ''} — ${ROWS.length} tracked.`
        : `No application in ${filter} — ${ROWS.length} tracked.`, Boolean(q));
    } else showEmpty('Nothing here. Send a job URL or a JD to Hermes to get started.');
    $('#stats').textContent = `${list.length} shown · ${ROWS.length} total${todayEvals.length ? ` · ${todayEvals.length} today` : ''}`;
  }
}

// ── interactions ─────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const pipeChip = e.target.closest('[data-pipefilter]');
  if (pipeChip) {
    pipeFilter = pipeChip.dataset.pipefilter;
    localStorage.setItem('co.pipeFilter', pipeFilter);
    renderPipeline();
    return;
  }
  const chip = e.target.closest('.chip');
  if (chip && chip.dataset.filter) { filter = chip.dataset.filter; renderChips(); render(); return; }
  const v = e.target.closest('[data-view]');
  if (v) openDrawer(v.dataset.view);
});

document.addEventListener('change', async (e) => {
  const sel = e.target.closest('select.status');
  if (!sel) return;
  const uid = sel.dataset.uid;
  const next = sel.value;
  const prev = sel.dataset.s;
  const row = ROWS.find((r) => r.app_uid === uid);
  sel.disabled = true;
  try {
    // If-Match makes a stale edit fail loudly instead of overwriting whatever
    // a batch re-evaluation wrote while this page was open.
    const res = await api(`applications/${encodeURIComponent(uid)}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': row?.etag || '' },
      body: JSON.stringify({ to: next }),
    });
    Object.assign(row, res.row);
    sel.dataset.s = res.row.status;
    renderChips();
    // Setting a status is how a Today decision gets cleared; re-pull so the
    // item leaves the list instead of lingering as already-done work.
    if (TAB === 'today') loadToday();
  } catch (err) {
    sel.value = prev;
    if (err.status === 409) {
      alert(`This application changed while the page was open — it is now "${err.body?.current?.status}".\n\nReloading so you can re-apply your change.`);
      await load();
    } else {
      alert(`Update failed: ${err.message}`);
    }
  } finally {
    sel.disabled = false;
  }
});

// ── detail drawer ────────────────────────────────────────────────────────────
function showDrawer(on) {
  $('#drawer').hidden = !on;
  $('#scrim').hidden = !on;
  document.body.style.overflow = on ? 'hidden' : '';
}

function eventHtml(ev) {
  const when = String(ev.ts || '').slice(0, 10);
  const who = ev.actor ? `<span class="who"> · ${esc(ev.actor)}</span>` : '';
  if (ev.kind === 'status') {
    const from = ev.from ? `${esc(ev.from)} → ` : '';
    return `<div class="ev status"><div class="when">${esc(when)}</div>
      <div class="what">${from}<b>${esc(ev.to)}</b>${ev.note ? `<br>${esc(ev.note)}` : ''}${who}</div></div>`;
  }
  if (ev.kind === 'note') {
    return `<div class="ev"><div class="when">${esc(when)}</div><div class="what">${esc(ev.text)}${who}</div></div>`;
  }
  if (ev.kind === 'created') {
    return `<div class="ev"><div class="when">${esc(when)}</div><div class="what muted">added to tracker${who}</div></div>`;
  }
  return `<div class="ev"><div class="when">${esc(when)}</div><div class="what muted">${esc(ev.kind)}${who}</div></div>`;
}

async function openDrawer(uid) {
  const body = $('#drawerBody');
  const row = ROWS.find((r) => r.app_uid === uid);
  body.innerHTML = `<h2>${esc(row?.company || '')}</h2><div class="muted">${esc(row?.role || '')}</div><p class="muted">Loading…</p>`;
  showDrawer(true);
  let d;
  try { d = await api(`applications/${encodeURIComponent(uid)}`); }
  catch (e) { body.innerHTML = `<h2>Error</h2><p class="err">${esc(e.message)}</p>`; return; }

  const n = scoreNum(d.score);
  const events = (d.events || []).slice().reverse(); // newest first
  body.innerHTML = `
    <h2>${esc(d.company)}</h2>
    <div class="muted">${esc(d.role)}</div>
    <div class="actions">
      <span class="badge fit ${fitClass(n)}">${esc(d.score || '—')}</span>
      <span class="badge">${esc(d.status)}</span>
      ${d.age_days != null ? `<span class="badge">${d.age_days}d old</span>` : ''}
    </div>
    <h3>Details</h3>
    <dl class="kv">
      <dt>Applied</dt><dd>${esc(d.date || '—')}</dd>
      <dt>CV</dt><dd>${d.pdf === '✅' ? 'generated' : '—'}</dd>
      <dt>Report</dt><dd>${esc(String(d.report || '—').replace(/\[|\]\(.*\)/g, '')) || '—'}</dd>
      <dt>Tracker id</dt><dd><code>${esc(d.app_uid)}</code></dd>
    </dl>
    ${d.notes ? `<h3>Evaluation note</h3><div>${esc(d.notes)}</div>` : ''}
    <h3>History</h3>
    <div class="timeline">${events.map(eventHtml).join('') || '<div class="muted">No history yet.</div>'}</div>
    <div class="note-add">
      <textarea id="noteText" placeholder="Add a note…" rows="2"></textarea>
      <button id="noteAdd">Add</button>
    </div>`;

  $('#noteAdd').onclick = async () => {
    const text = $('#noteText').value.trim();
    if (!text) return;
    $('#noteAdd').disabled = true;
    try {
      await api(`applications/${encodeURIComponent(uid)}/notes`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      await openDrawer(uid); // re-render with the new event
    } catch (e) {
      alert(`Could not add note: ${e.message}`);
      $('#noteAdd').disabled = false;
    }
  };
}

$('#drawerClose').onclick = () => showDrawer(false);
$('#scrim').onclick = () => showDrawer(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') showDrawer(false); });
$('#search').oninput = () => (TAB === 'pipeline' ? renderPipeline() : render());
$('#refresh').onclick = () => { load(); loadPipeline(); loadHealth(); loadToday(); };
$('#view').onclick = () => {
  view = view === 'cards' ? 'board' : 'cards';
  localStorage.setItem('co.view', view);
  $('#view').textContent = view === 'cards' ? '▦' : '▤';
  render();
};

// ── Scouted pipeline ─────────────────────────────────────────────────────────
// Read-only view of data/pipeline.md: roles the scanner found that have not
// been evaluated yet. Kept deliberately dumb — the decision to evaluate one
// still happens in Claude Code, this just makes the queue visible.

let PIPE = [];
let TAB = 'tracker';

async function loadPipeline() {
  try {
    const r = await fetch('/api/pipeline');
    if (r.status === 401) { showLogin(); return; }
    PIPE = (await r.json()).rows || [];
    $('#pipeCount').textContent = PIPE.length ? String(PIPE.length) : '';
    if (TAB === 'pipeline') renderPipeline();
  } catch { /* leave the badge empty; the tracker tab still works */ }
}

// Rows already in the inbox from before the scanner learned to require remote
// outside Switzerland. Hidden, never deleted — the filter is a view, not a purge.
const REMOTE_RE = /remote|anywhere|distributed|work from home|home office/i;
const isActionable = (r) => r.swiss || REMOTE_RE.test(r.location || '') || REMOTE_RE.test(r.role || '');
let pipeFilter = localStorage.getItem('co.pipeFilter') || 'actionable';

function renderPipeline() {
  const q = $('#search').value.trim().toLowerCase();
  let rows = PIPE.filter((r) =>
    !q || `${r.company} ${r.role} ${r.location}`.toLowerCase().includes(q));

  const all = rows.length;
  const swissN = rows.filter((r) => r.swiss).length;
  const actionableN = rows.filter(isActionable).length;
  if (pipeFilter === 'swiss') rows = rows.filter((r) => r.swiss);
  else if (pipeFilter === 'actionable') rows = rows.filter(isActionable);

  const ages = [5, 15, 30].map((d) => {
    const c = PIPE.filter((r) => r.age_days != null && r.age_days >= d).length;
    return c ? `<button class="act drop" data-act="dismissolder" data-days="${d}">Dismiss ${d}d+ (${c})</button>` : '';
  }).join('');
  $('#stats').innerHTML = `
    <div class="pipe-actions toolbar">
      <button class="act go" data-act="scan">Scan for new roles</button>
      ${ages}
      <span class="act-msg"></span>
    </div>
    <span class="pipechips">
      ${[['actionable', `🇨🇭 or remote ${actionableN}`], ['swiss', `Switzerland ${swissN}`], ['all', `All ${all}`]]
    .map(([k, label]) => `<button class="chip" data-pipefilter="${k}" aria-pressed="${pipeFilter === k}">${esc(label)}</button>`).join('')}
    </span>`;

  $('#pipeline').innerHTML = rows.map((r) => `
    <article class="card pipe-row ${ageClass(r.age_days)}" data-url="${esc(r.url)}">
      <div class="top">
        <div class="role"><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.role || 'Untitled role')}</a></div>
        ${ageBadge(r.age_days)}
      </div>
      <div class="meta">
        <span>${esc(r.company || '—')}</span>
        <span>${r.swiss ? '🇨🇭 ' : ''}${esc(r.location || '—')}</span>
        ${r.first_seen ? `<span class="scouted">scouted ${esc(r.first_seen)}</span>` : '<span class="unknown">scout date unknown</span>'}
        ${r.portal ? `<span>via ${esc(r.portal)}</span>` : ''}
      </div>
      <div class="preview" data-url="${esc(r.url)}" hidden></div>
      <div class="pipe-actions">
        <button class="act peek" data-act="preview" data-url="${esc(r.url)}">Preview</button>
        <button class="act go" data-act="evaluate" data-url="${esc(r.url)}">Evaluate</button>
        <button class="act drop" data-act="dismiss" data-url="${esc(r.url)}">Dismiss</button>
        <span class="act-msg"></span>
      </div>
    </article>`).join('');

  if (rows.length) $('#empty').hidden = true;
  else if (PIPE.length) {
    const q = $('#search').value.trim();
    const named = { actionable: '🇨🇭 or remote', swiss: 'Switzerland', all: 'All' }[pipeFilter] || pipeFilter;
    showEmpty(q
      ? `No scouted role matches “${q}” under ${named} — ${PIPE.length} in the inbox.`
      : `No scouted role is ${named} — ${PIPE.length} in the inbox. Tap “All ${PIPE.length}” to see them.`,
    Boolean(q));
  } else showEmpty('Nothing here. Send a job URL or a JD to Hermes to get started.');
  $('#pipeline').hidden = false;
}

/** Freshness is the first thing to know about a scouted row, so it is a badge. */
function ageBadge(days) {
  if (days == null) return '<span class="agebadge old">undated</span>';
  if (days <= 1) return '<span class="agebadge new">NEW</span>';
  if (days <= 3) return `<span class="agebadge new">${days}d</span>`;
  if (days <= 14) return `<span class="agebadge warm">${days}d</span>`;
  return `<span class="agebadge old">${days}d</span>`;
}
const ageClass = (d) => (d == null ? 'undated' : d <= 3 ? 'fresh' : d <= 14 ? 'warm' : 'cold');

// ── JD preview ───────────────────────────────────────────────────────────────
// Deciding Evaluate vs Dismiss from a job title is guessing. The server fetches
// the posting once (ATS API, else a headless render) and caches it, so the
// second look is instant. A cached preview loads on hover; an uncached one waits
// for a deliberate click, because a mouse sweep must not fire 20 page fetches.

const previewCache = new Map();

async function loadPreview(url, panel, { userAsked = false } = {}) {
  if (panel.dataset.state === 'loading' || panel.dataset.state === 'done') return;
  if (previewCache.has(url)) {
    panel.dataset.state = 'done';
    panel.textContent = previewCache.get(url);
    panel.hidden = false;
    return;
  }
  if (!userAsked) return; // hover never triggers a network fetch
  panel.dataset.state = 'loading';
  panel.hidden = false;
  panel.textContent = 'Fetching the posting…';
  try {
    const r = await fetch('/api/pipeline/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (r.status === 401) { showLogin(); return; }
    const b = await r.json().catch(() => ({}));
    const text = b.text || b.error || 'No preview available — open the posting instead.';
    previewCache.set(url, text);
    panel.dataset.state = 'done';
    panel.textContent = text;
  } catch (e) {
    panel.dataset.state = '';
    panel.textContent = `Preview failed: ${e.message}`;
  }
}

// Hover only reveals what is already cached; it never starts a fetch.
document.addEventListener('mouseover', (e) => {
  const card = e.target.closest?.('.pipe-row');
  if (!card) return;
  const panel = card.querySelector('.preview');
  if (panel && panel.hidden && previewCache.has(card.dataset.url)) {
    loadPreview(card.dataset.url, panel);
  }
});

// ── acting on a scouted row ──────────────────────────────────────────────────
// Evaluate enqueues a real evaluation (minutes of worker time); Dismiss marks
// the row processed so daily-scout stops re-queuing it. Dismiss is two-tap
// rather than a modal: it is reversible (the row is marked, never deleted) but
// a stray thumb on a phone should still not fire it.

async function pipelineAction(kind, url, btn) {
  const card = btn.closest('.pipe-row');
  const msg = card.querySelector('.act-msg');
  const buttons = [...card.querySelectorAll('button.act')];
  buttons.forEach((b) => { b.disabled = true; });
  msg.className = 'act-msg';
  msg.textContent = kind === 'evaluate' ? 'Queueing…' : 'Dismissing…';

  try {
    const r = await fetch(`/api/pipeline/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (r.status === 401) { showLogin(); return; }
    const body = await r.json().catch(() => ({}));

    if (!r.ok) {
      msg.className = 'act-msg bad';
      msg.textContent = body.message || body.error || `HTTP ${r.status}`;
      buttons.forEach((b) => { b.disabled = false; });
      return;
    }

    if (kind === 'dismiss') {
      card.classList.add('gone');
      // Drop it locally too, so the count and the list agree without a reload.
      PIPE = PIPE.filter((p) => p.url !== url);
      $('#pipeCount').textContent = PIPE.length ? String(PIPE.length) : '';
      setTimeout(() => { card.remove(); }, 250);
      return;
    }

    // Evaluate. A duplicate is a 200 with accepted:false — that is information,
    // not a failure: it means the work was already done.
    if (body.duplicate) {
      msg.className = 'act-msg dup';
      msg.textContent = body.report_num
        ? `Already evaluated — report ${body.report_num}${body.score ? ` (${body.score}/5)` : ''}`
        : (body.message || 'Already known');
    } else {
      msg.className = 'act-msg ok';
      msg.textContent = `Queued as #${body.id} — evaluating, a few minutes`;
      card.classList.add('queued');
    }
    // Either way the queue changed; the Queue tab should reflect it now.
    loadHealth();
  } catch (e) {
    msg.className = 'act-msg bad';
    msg.textContent = e.message;
    buttons.forEach((b) => { b.disabled = false; });
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button.act');
  if (!btn) return;
  const { act, url } = btn.dataset;

  if (act === 'clearsearch') {
    $('#search').value = '';
    if (TAB === 'pipeline') renderPipeline(); else render();
    return;
  }
  if (act === 'report') { openReport(btn.dataset.num); return; }
  if (act === 'draft') { openDraft(btn.dataset.app); return; }
  if (act.startsWith('q-')) { queueAction(act.slice(2), btn); return; }
  if (act === 'scan') { runScan(btn); return; }
  if (act === 'dismissolder') { bulkDismiss(btn); return; }

  if (act === 'verdict' || act === 'logfollowup') { todayAction(btn); return; }

  if (act === 'preview') {
    const panel = btn.closest('.pipe-row').querySelector('.preview');
    if (!panel.hidden && panel.dataset.state === 'done') { panel.hidden = true; return; }
    loadPreview(url, panel, { userAsked: true });
    return;
  }

  if (act === 'dismiss' && btn.dataset.armed !== '1') {
    btn.dataset.armed = '1';
    btn.textContent = 'Sure?';
    // Disarm on its own, so a forgotten half-tap does not lie in wait.
    setTimeout(() => {
      if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = 'Dismiss'; }
    }, 4000);
    return;
  }
  pipelineAction(act, url, btn);
});

// ── queue health ─────────────────────────────────────────────────────────────
// Answers "can the evaluation queue actually do work right now?", which neither
// of the other tabs can: both show finished work, so an outage renders as an
// empty list. On 2026-09-01 a job sat queued for 45 min against a logged-out
// container and then got deleted by the next scout run, with no surface
// anywhere showing why. This is that surface.

let HEALTH = null;
const BASE_TITLE = document.title;

async function loadHealth() {
  try {
    const r = await fetch('/api/health');
    if (r.status === 401) { showLogin(); return; }
    const body = await r.json();
    // A 5xx, a 404 from an ingest server that predates this route, or any body
    // without a `problems` array is NOT a healthy queue — it is an unanswered
    // question. Rendering it as "all clear" would rebuild the exact blind spot
    // this tab exists to remove.
    if (!r.ok || !Array.isArray(body.problems)) {
      throw new Error(body.message || body.error || `HTTP ${r.status}`);
    }
    HEALTH = body;
  } catch {
    // A health check that cannot run is itself a red flag — say so rather than
    // leaving the last good state on screen looking current.
    HEALTH = { ok: false, unreachable: true, problems: [{
      code: 'health_unreachable', severity: 'error',
      title: 'Cannot reach the evaluation container',
      detail: 'The web UI could not query career-ops. It may be down or restarting.',
      fix: 'docker compose ps',
    }], queue: {}, auth: {}, runner: {}, pause: {} };
  }
  renderBanner();
  if (TAB === 'health') renderHealth();
}

function errors() {
  return (HEALTH?.problems || []).filter((p) => p.severity === 'error');
}

function renderBanner() {
  const errs = errors();
  const warns = (HEALTH?.problems || []).filter((p) => p.severity === 'warn');
  const dot = $('#healthDot');
  dot.hidden = !HEALTH || (!errs.length && !warns.length);
  dot.className = `dot ${errs.length ? 'bad' : 'warn'}`;

  // Title badge: the tab is usually in the background, and this is the only
  // stall signal that survives that. No Notification API here — the UI is
  // served over plain HTTP on the LAN, which is not a secure context, so
  // Notification/ServiceWorker are unavailable by construction (see loadHealth
  // callers and the webhook on the server for the out-of-browser path).
  document.title = errs.length ? `⚠ (${errs.length}) ${BASE_TITLE}` : BASE_TITLE;

  const b = $('#banner');
  if (!errs.length) { b.hidden = true; return; }
  const p = errs[0];
  const more = errs.length > 1 ? ` <span class="more">+${errs.length - 1} more</span>` : '';
  b.innerHTML = `<b>${esc(p.title)}</b>${more}<div class="d">${esc(p.detail || '')}</div>
    ${p.fix ? `<code>${esc(p.fix)}</code>` : ''}
    <button class="link" id="bannerGo">Open queue</button>`;
  b.hidden = false;
  $('#bannerGo').onclick = () => setTab('health');
}

function checkRow(okState, label, value) {
  const mark = okState === true ? '✅' : okState === false ? '🚨' : '⚠️';
  return `<div class="check ${okState === true ? 'ok' : okState === false ? 'bad' : 'warn'}">
    <span class="m">${mark}</span><span class="l">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
}

/**
 * How far a running worker has got. `claude -p` buffers everything it prints,
 * so the worker log is empty until the job ends and the only honest progress
 * signal is the files it has finished writing — which is what the server sends.
 */
function progressHtml(p, typicalMinutes, ageMinutes) {
  const segs = (p.steps || []).map((st) =>
    `<span class="seg ${st.done ? 'on' : ''}" title="${esc(st.label)}"></span>`).join('');
  // Elapsed against this machine's own median, not a guess. Only called out
  // once it is actually over, so a normal run stays quiet.
  const over = typicalMinutes && ageMinutes != null && ageMinutes > typicalMinutes * 1.5;
  const pace = typicalMinutes
    ? `${over ? 'over' : 'typically'} ~${humanAge(Math.round(typicalMinutes))}` : '';
  const since = p.at ? humanAge(Math.max(0, Math.round((Date.now() - Date.parse(p.at)) / 60000))) : '';
  return `<div class="qprog">
    <div class="segs">${segs}</div>
    <span class="qstage ${over ? 'slow' : ''}">step ${p.done}/${p.total} · ${esc(p.label)}${
  since ? ` · ${esc(since)} ago` : ''}${pace ? ` · ${esc(pace)}` : ''}</span>
  </div>`;
}

function renderHealth() {
  const h = HEALTH;
  const el = $('#health');
  if (!h) { el.innerHTML = '<p class="muted">Checking…</p>'; el.hidden = false; return; }

  const q = h.queue || {};
  const auth = h.auth || {};
  const orphans = q.orphans || [];
  const waiting = q.waiting || [];

  const authState = auth.logged_in === true ? true : auth.logged_in === false ? false : null;
  const checks = [
    checkRow(authState, 'Container login',
      auth.logged_in === true ? `signed in${auth.email ? ` — ${auth.email}` : ''}`
        : auth.logged_in === false ? 'LOGGED OUT — nothing will evaluate'
          : (auth.error || 'unknown')),
    checkRow(!h.pause?.paused, 'Batch runner',
      h.pause?.paused ? `paused — ${h.pause.message}` : (h.runner?.running ? `running (pid ${h.runner.pid})` : 'idle')),
    checkRow(!orphans.some((o) => o.age_minutes >= (q.stale_after_minutes ?? 15)), 'Queued jobs',
      orphans.length ? `${orphans.length} with no state row` : 'none stranded'),
    checkRow(!(q.stuck || []).length, 'Workers',
      (q.stuck || []).length ? `${q.stuck.length} processing over the limit` : 'none stuck'),
  ].join('');

  const rows = [...orphans, ...waiting];
  const list = rows.length ? rows.map((r) => {
    const prog = r.progress ? progressHtml(r.progress, q.typical_minutes, r.age_minutes) : '';
    const stale = r.age_minutes != null && r.age_minutes >= (q.stale_after_minutes ?? 15);
    const age = r.age_minutes == null ? '' :
      `${r.age_is_lower_bound ? '≥' : ''}${humanAge(r.age_minutes)}`;
    return `<article class="card qrow ${stale ? 'stale' : ''}">
      <div class="top"><b>#${esc(r.id)}</b>
        <span class="badge">${esc(r.status || 'queued')}</span>
        ${age ? `<span class="badge ${stale ? 'bad' : ''}">${esc(age)}</span>` : ''}</div>
      <div class="role"><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a></div>
      <div class="meta">${esc(r.source || '')}${r.notes ? ` · ${esc(r.notes)}` : ''}</div>
      ${prog}
      ${r.error ? `<div class="qerr">${esc(r.error)}</div>` : ''}
      <div class="pipe-actions">
        <button class="act view" data-act="q-log" data-id="${esc(r.id)}">Worker log</button>
        ${r.status === 'processing' ? `<button class="act drop" data-act="q-reset" data-id="${esc(r.id)}">Release</button>` : ''}
        ${(r.status === 'paused_rate_limit' || r.status === 'failed') ? `<button class="act go" data-act="q-retry" data-id="${esc(r.id)}">Retry</button>` : ''}
        <span class="act-msg"></span>
      </div>
    </article>`;
  }).join('') : '<p class="muted">Queue is empty — everything submitted has been evaluated.</p>';

  // A problem with no button is just a nicer place to feel stuck. Each code
  // that CAN be repaired from here gets the button; the rest keep the command,
  // selectable in one tap so it can be pasted into a terminal.
  const FIXES = {
    runner_lock_stale: [{ act: 'clearlock', label: 'Clear stale lock' }],
    runner_paused: [{ act: 'unpause', label: 'Clear pause & retry' }],
    queue_orphans: [{ act: 'drain', label: 'Start the runner' }],
    queue_failing: [{ act: 'drain', label: 'Retry now' }],
    worker_stuck: (q) => (q.stuck || []).flatMap((sk) => ([
      { act: 'log', label: `Worker log #${sk.id}`, id: sk.id },
      { act: 'reset', label: `Release job #${sk.id}`, id: sk.id },
    ])),
  };
  const probs = (h.problems || []).map((p) => {
    const spec = FIXES[p.code];
    const btns = (typeof spec === 'function' ? spec(q) : spec) || [];
    return `<div class="prob ${esc(p.severity)}">
      <b>${esc(p.title)}</b>
      <div class="d">${esc(p.detail || '')}</div>
      ${btns.length
    ? `<div class="pipe-actions">${btns.map((b) =>
      `<button class="act ${b.act === 'log' ? 'view' : 'go'}" data-act="q-${b.act}" ${b.id ? `data-id="${esc(b.id)}"` : ''}>${esc(b.label)}</button>`).join('')}
        <span class="act-msg"></span></div>`
    : ''}
      ${p.fix ? `<code title="tap to select">${esc(p.fix)}</code>` : ''}
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="pipe-actions toolbar">
      <button class="act go" data-act="q-drain">Run the queue now</button>
      <span class="act-msg"></span>
    </div>
    <div class="checks">${checks}</div>
    ${probs ? `<h3>Problems</h3>${probs}` : ''}
    <h3>Queue <span class="count">${rows.length}</span></h3>
    ${list}
    <p class="muted checked">Checked ${esc(String(h.checked_at || '').replace('T', ' ').slice(0, 19))} UTC · auto-refreshes every 60s</p>`;
  el.hidden = false;
  $('#stats').textContent = h.ok ? 'Evaluation queue healthy' : `${errors().length} problem(s) blocking evaluation`;
}

function humanAge(mins) {
  if (mins == null) return '';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${hrs}h ${m}m` : `${hrs}h`;
}

// ── Today ────────────────────────────────────────────────────────────────────
// The tracker answers "what have I looked at". This answers "what is waiting on
// me", which is the question 191 scouted rows, 55 undecided evaluations and 3
// applications say nobody was answering. Every item here is an action, ordered
// by what it costs to keep ignoring it.

let TODAY = null;

async function loadToday() {
  try {
    const r = await fetch('/api/today');
    if (r.status === 401) { showLogin(); return; }
    TODAY = await r.json();
  } catch { TODAY = null; }
  // Today's undecided rows count too, even below the apply threshold. Only the
  // low-scoring ones are added: decisions.apply_worthy already counts the rest,
  // and double-counting them would inflate the badge after every batch run.
  const belowBar = (TODAY?.evaluated_today?.rows || []).filter(
    (r) => (!r.status || r.status === 'Evaluated')
      && (r.score_num ?? 0) < (TODAY.thresholds?.apply ?? 4)).length;
  const n = TODAY
    ? (TODAY.followups?.entries?.length || 0) + (TODAY.decisions?.apply_worthy || 0) + belowBar
    : 0;
  $('#todayCount').textContent = n ? String(n) : '';
  if (TAB === 'today') renderToday();
}

const URGENCY = { overdue: '🔴', urgent: '🟠', cold: '🔵' };

/** Links every actionable row needs: the posting itself and the evaluation. */
function linkRow(jdUrl, reportNum, jdNote) {
  return `<div class="links">
    ${jdUrl ? `<a class="jd" href="${esc(jdUrl)}" target="_blank" rel="noopener noreferrer">Open JD ↗</a>`
    : `<span class="muted nojd">${esc(jdNote || 'no JD link')}</span>`}
    ${reportNum ? `<button class="act view" data-act="report" data-num="${esc(reportNum)}">Read report</button>` : ''}
  </div>`;
}

function followupHtml(e) {
  const who = (e.contacts || []).map((c) => (typeof c === 'string' ? c : c.name || '')).filter(Boolean);
  const late = e.daysUntilNext != null && e.daysUntilNext < 0 ? `${Math.abs(e.daysUntilNext)}d late` : 'due now';
  return `<article class="card act-row" data-app="${esc(e.num ?? '')}">
    <div class="top">
      ${e.jd_url
    ? `<a class="co" href="${esc(e.jd_url)}" target="_blank" rel="noopener noreferrer">${URGENCY[e.urgency] || ''} ${esc(e.company)} ↗</a>`
    : `<span class="co nolink" title="${esc(e.jd_note || '')}">${URGENCY[e.urgency] || ''} ${esc(e.company)}</span>`}
      <div class="fit ${fitClass(scoreNum(e.score))}">${esc(e.score || '—')}</div>
    </div>
    <div class="role">${esc(e.role)}</div>
    <div class="meta">
      <span>${esc(e.status)} ${e.daysSinceApplication != null ? `· applied ${e.daysSinceApplication}d ago` : ''}</span>
      <span class="late">${esc(late)}</span>
      ${e.followupCount ? `<span>${e.followupCount} follow-up(s) sent</span>` : '<span class="late">never followed up</span>'}
    </div>
    ${who.length ? `<div class="meta"><span>👤 ${esc(who.join(', '))}</span></div>` : ''}
    ${linkRow(e.jd_url, e.report_num, e.jd_note)}
    <div class="pipe-actions">
      <button class="act go" data-act="draft" data-app="${esc(e.num ?? '')}">Draft follow-up</button>
      <button class="act view" data-act="logfollowup" data-app="${esc(e.num ?? '')}"
        data-company="${esc(e.company)}" data-role="${esc(e.role)}"
        data-contact="${esc(who.join(', '))}">I followed up</button>
      <span class="act-msg"></span>
    </div>
  </article>`;
}

/** One tap per verdict. A dropdown is a two-step on a phone, which is why 55
 *  evaluations sat undecided — the action was never one gesture. */
const VERDICTS = [['Applied', 'go'], ['SKIP', 'drop'], ['Discarded', 'drop']];

function decisionHtml(r, { fresh = false } = {}) {
  const stale = !fresh && (r.age_days ?? 0) >= (TODAY.thresholds?.stale_days ?? 7);
  const row = ROWS.find((x) => x.app_uid === r.app_uid);
  // A row can reach the fresh list already decided (evaluated and applied to in
  // the same day). Showing three verdict buttons on it would invite undoing a
  // decision by accident, so it shows the verdict it has instead.
  const undecided = !r.status || r.status === 'Evaluated';
  return `<article class="card act-row decision ${stale ? 'stale' : ''} ${fresh ? 'fresh' : ''}" data-uid="${esc(r.app_uid)}">
    <div class="top">
      ${r.jd_url
    ? `<a class="co" href="${esc(r.jd_url)}" target="_blank" rel="noopener noreferrer">${esc(r.company)} ↗</a>`
    : `<span class="co nolink" title="${esc(r.jd_note || '')}">${esc(r.company)}</span>`}
      <div class="fit ${fitClass(r.score_num)}">${esc(r.score || '—')}</div>
    </div>
    <div class="role">${esc(r.role)}</div>
    <div class="meta">
      ${fresh ? '<span class="agebadge new">TODAY</span>' : ageBadge(r.age_days)}
      ${r.decision ? `<span class="verdict">${esc(r.decision)}</span>` : ''}
      <span>evaluated ${esc(r.date || '—')}</span>
    </div>
    <div class="why">${esc(r.headline)}</div>
    ${linkRow(r.jd_url, r.report_num, r.jd_note)}
    <div class="pipe-actions">
      ${undecided
    ? VERDICTS.map(([v, cls]) =>
      `<button class="act ${cls}" data-act="verdict" data-to="${v}" data-uid="${esc(r.app_uid)}"
        data-etag="${esc(row?.etag || '')}">${v === 'Applied' ? 'Applied ✓' : v}</button>`).join('')
    : `<span class="settled">${esc(r.status)}</span>`}
      <span class="act-msg"></span>
    </div>
  </article>`;
}

function renderToday() {
  const el = $('#today');
  if (!TODAY) { el.innerHTML = '<p class="muted">Could not load. Try refresh.</p>'; el.hidden = false; return; }

  const f = TODAY.followups || {};
  const d = TODAY.decisions || {};
  const inbox = TODAY.inbox || {};
  const fups = f.entries || [];
  const stale = TODAY.thresholds?.stale_days ?? 7;

  // Worth a verdict at all: the evaluator recommended applying. Below that, an
  // undecided row is not costing an opportunity.
  // Everything scored today, whatever it scored: the run's own output, which is
  // what you open the tab for right after a batch. Deliberately not filtered by
  // the apply threshold — a low score is still a result you have not read.
  const t = TODAY.evaluated_today || {};
  const freshRows = t.rows || [];
  const freshIds = new Set(freshRows.map((r) => r.app_uid));

  const worthy = (d.rows || [])
    .filter((r) => !freshIds.has(r.app_uid))
    .filter((r) => (r.score_num ?? 0) >= (TODAY.thresholds?.apply ?? 4));
  // Freshness beats score here. A 4.1 found yesterday converts better than a 4.3
  // that has been open three weeks, and burying the new ones under the old ones
  // is what makes the list feel pointless.
  const byAge = (a, b) => (a.age_days ?? 999) - (b.age_days ?? 999);
  const hot = worthy.filter((r) => (r.age_days ?? 999) < stale).sort(byAge);
  const aging = worthy.filter((r) => (r.age_days ?? 999) >= stale).sort(byAge);

  el.innerHTML = `
    ${freshRows.length ? `
      <h3>Evaluated today <span class="count">${freshRows.length}</span></h3>
      <p class="muted sub">Back from the pipeline on ${esc(t.date || '')} — every score, not just the high ones. ${t.undecided ?? 0} still need a verdict.</p>
      ${freshRows.map((r) => decisionHtml(r, { fresh: true })).join('')}` : ''}

    ${fups.length ? `
      <h3>Follow-ups owed <span class="count">${fups.length}</span></h3>
      <p class="muted sub">Sent, and going cold. Chase it, then tap "I followed up" so the clock resets.</p>
      ${fups.map(followupHtml).join('')}` : ''}

    ${hot.length ? `
      <h3>Hot — decide now <span class="count">${hot.length}</span></h3>
      <p class="muted sub">Scored ${TODAY.thresholds?.apply ?? 4}+, evaluated in the last ${stale} days. Freshest first — these are the ones with traction.</p>
      ${hot.map(decisionHtml).join('')}` : ''}

    ${aging.length ? `
      <details class="aging" ${hot.length || fups.length ? '' : 'open'}>
        <summary>Older, still undecided <span class="count">${aging.length}</span></summary>
        <p class="muted sub">Open ${stale}+ days. Traction drops fast after week two — most of these are worth one tap on SKIP to clear the list.</p>
        ${aging.map(decisionHtml).join('')}
      </details>` : ''}

    ${!fups.length && !worthy.length && !freshRows.length
    ? '<p class="empty">Nothing is waiting on you. Follow-ups are current and every high-scoring evaluation has a verdict.</p>' : ''}

    <h3>Backlog</h3>
    <div class="checks">
      <div class="check ${inbox.fresh ? 'warn' : ''}"><span class="m">📥</span><span class="l">Scouted, new in 48h</span><span class="v">${inbox.fresh ?? 0} of ${inbox.pending ?? 0} (${inbox.swiss ?? 0} 🇨🇭)</span></div>
      <div class="check"><span class="m">📋</span><span class="l">Evaluated, no verdict</span><span class="v">${d.total ?? 0}${t.total ? ` (${t.total} today)` : ''}</span></div>
      <div class="check"><span class="m">⏳</span><span class="l">Follow-ups not yet due</span><span class="v">${f.waiting ?? 0}</span></div>
    </div>`;
  el.hidden = false;
  const todo = fups.length + hot.length + (t.undecided ?? 0);
  $('#stats').textContent = todo ? `${todo} thing(s) to do` : 'Nothing to do right now';
}

// ── Today actions ────────────────────────────────────────────────────────────
async function todayAction(btn) {
  const card = btn.closest('.act-row');
  const msg = card.querySelector('.act-msg');
  const buttons = [...card.querySelectorAll('button.act')];
  buttons.forEach((b) => { b.disabled = true; });
  msg.className = 'act-msg';
  msg.textContent = 'Saving…';

  try {
    if (btn.dataset.act === 'verdict') {
      // Same endpoint, etag and 409 semantics as the tracker's own dropdown —
      // a second write path would be a second way to clobber a re-evaluation.
      await api(`applications/${encodeURIComponent(btn.dataset.uid)}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': btn.dataset.etag || '' },
        body: JSON.stringify({ to: btn.dataset.to }),
      });
      msg.className = 'act-msg ok';
      msg.textContent = `Set to ${btn.dataset.to}`;
    } else {
      const r = await fetch('/api/followups/log', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app_num: btn.dataset.app, company: btn.dataset.company,
          role: btn.dataset.role, contact: btn.dataset.contact,
          channel: 'email', notes: 'logged from dashboard',
        }),
      });
      if (r.status === 401) { showLogin(); return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || `HTTP ${r.status}`);
      msg.className = 'act-msg ok';
      msg.textContent = 'Logged — the cadence clock is reset';
    }
    card.classList.add('gone');
    setTimeout(() => { load(); loadToday(); }, 500);
  } catch (err) {
    msg.className = 'act-msg bad';
    msg.textContent = err.status === 409
      ? 'Changed elsewhere while open — reloading' : `Failed: ${err.message}`;
    buttons.forEach((b) => { b.disabled = false; });
    if (err.status === 409) { await load(); loadToday(); }
  }
}


// ── follow-up draft ──────────────────────────────────────────────────────────
// "You owe a follow-up" is only half an action item. This is the other half:
// the message, already filled in, plus the evaluator's own note so you can see
// who to send it to. Deliberately a factual skeleton — it states only what the
// tracker knows (role, date applied) and never asserts anything about you that
// is not already in your own files.

function openDraft(appNum) {
  const e = (TODAY?.followups?.entries || []).find((x) => String(x.num) === String(appNum));
  const body = $('#drawerBody');
  if (!e) { body.innerHTML = '<h2>Follow-up</h2><p class="err">Row not found — try refreshing.</p>'; showDrawer(true); return; }

  const days = e.daysSinceApplication;
  const draft = [
    `Subject: Following up — ${e.role}`,
    '',
    'Hello,',
    '',
    `I applied for the ${e.role} role${days != null ? ` ${days} days ago` : ''} and wanted to check in on where things stand.`,
    '',
    'I remain very interested, and I am happy to share anything that would help — references, a short walkthrough of relevant work, or availability for a call this week.',
    '',
    'Thank you for your time.',
    '',
    'Alejandro',
  ].join('\n');

  body.innerHTML = `
    <h2>Follow-up — ${esc(e.company)}</h2>
    <div class="muted">${esc(e.role)}</div>
    <div class="actions">
      <span class="badge fit ${fitClass(scoreNum(e.score))}">${esc(e.score || '—')}</span>
      <span class="badge">${esc(e.status)}</span>
      ${days != null ? `<span class="badge">applied ${days}d ago</span>` : ''}
      ${e.followupCount ? `<span class="badge">${e.followupCount} sent</span>` : '<span class="badge">none sent</span>'}
    </div>
    <h3>Draft — edit before sending</h3>
    <textarea id="draftText" rows="13" class="draft">${esc(draft)}</textarea>
    <div class="pipe-actions">
      <button class="act go" id="copyDraft">Copy</button>
      ${e.jd_url ? `<a class="act view" href="${esc(e.jd_url)}" target="_blank" rel="noopener noreferrer">Open JD ↗</a>` : ''}
      ${e.report_num ? `<button class="act view" data-act="report" data-num="${esc(e.report_num)}">Read report</button>` : ''}
      <span class="act-msg" id="draftMsg"></span>
    </div>
    <h3>Who to contact / what was agreed</h3>
    <div class="why">${esc(e.notes || 'Nothing recorded. Open the report for the recruiter name and any agreed next step.')}</div>`;
  showDrawer(true);

  $('#copyDraft').onclick = async () => {
    const ta = $('#draftText');
    const msg = $('#draftMsg');
    try {
      // navigator.clipboard needs a secure context, and this is plain HTTP on
      // the LAN — so select the text and let the OS copy gesture do it.
      await navigator.clipboard.writeText(ta.value);
      msg.className = 'act-msg ok';
      msg.textContent = 'Copied.';
    } catch {
      ta.focus();
      ta.select();
      msg.className = 'act-msg';
      msg.textContent = 'Selected — press Ctrl/Cmd+C (clipboard access needs HTTPS).';
    }
  };
}

// ── queue repair, scanning and bulk triage ───────────────────────────────────

async function queueAction(kind, btn) {
  if (kind === 'log') { openWorkerLog(btn.dataset.id); return; }

  const msg = btn.closest('.pipe-actions')?.querySelector('.act-msg');
  const say = (t, cls = '') => { if (msg) { msg.className = `act-msg ${cls}`; msg.textContent = t; } };
  const ENDPOINTS = {
    clearlock: ['/api/queue/clear-lock', {}],
    unpause: ['/api/queue/unpause', {}],
    drain: ['/api/queue/drain', {}],
    reset: ['/api/queue/reset', { id: btn.dataset.id }],
    'reset-force': ['/api/queue/reset', { id: btn.dataset.id, force: true }],
    retry: ['/api/queue/retry', { id: btn.dataset.id }],
  };
  const [url, body] = ENDPOINTS[kind] || [];
  if (!url) return;

  btn.disabled = true;
  say('Working…');
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 401) { showLogin(); return; }
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      // 409 is the interesting one: the server refused because the condition
      // being repaired is not actually true (a live runner, say).
      say(b.message || b.error || `HTTP ${r.status}`, 'bad');
      btn.disabled = false;
      // The server could not prove the runner is dead. Offer the override
      // explicitly rather than silently forcing — releasing a live job costs a
      // duplicate evaluation.
      if (b.error === 'liveness_unknown' && kind === 'reset' && !btn.dataset.forced) {
        btn.dataset.forced = '1';
        btn.textContent = 'Release anyway';
        btn.dataset.act = 'q-reset-force';
      }
      return;
    }
    say(b.message || 'Done', 'ok');
    setTimeout(loadHealth, 800);
  } catch (e) {
    say(e.message, 'bad');
    btn.disabled = false;
  }
}

async function openWorkerLog(id) {
  const body = $('#drawerBody');
  body.innerHTML = `<h2>Worker log — job ${esc(id)}</h2><p class="muted">Loading…</p>`;
  showDrawer(true);
  try {
    const r = await fetch(`/api/queue/log/${encodeURIComponent(id)}`);
    if (r.status === 401) { showLogin(); return; }
    const b = await r.json();
    if (!r.ok) throw new Error(b.message || b.error || `HTTP ${r.status}`);
    body.innerHTML = `<h2>Worker log — job ${esc(id)}</h2>
      ${(b.logs || []).length
    ? b.logs.map((l) => `<h3>${esc(l.file)}</h3>
          <div class="muted">${esc(String(l.mtime).replace('T', ' ').slice(0, 19))} UTC</div>
          <pre class="worklog">${esc(l.text)}</pre>`).join('')
    : '<p class="muted">No log files for this job yet.</p>'}`;
  } catch (e) {
    body.innerHTML = `<h2>Worker log — job ${esc(id)}</h2><p class="err">${esc(e.message)}</p>`;
  }
}

async function runScan(btn) {
  const msg = btn.closest('.pipe-actions')?.querySelector('.act-msg');
  const say = (t, cls = '') => { if (msg) { msg.className = `act-msg ${cls}`; msg.textContent = t; } };
  btn.disabled = true;
  say('Scanning every source… this takes a few minutes.');
  try {
    const r = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (r.status === 401) { showLogin(); return; }
    const b = await r.json().catch(() => ({}));
    if (!r.ok) { say(b.message || b.error || `HTTP ${r.status}`, 'bad'); btn.disabled = false; return; }
    if (!b.started) say('A scan is already running — watching it.', 'dup');
    pollScan(say, btn);
  } catch (e) { say(e.message, 'bad'); btn.disabled = false; }
}

function pollScan(say, btn) {
  const tick = async () => {
    try {
      const s = await (await fetch('/api/scan')).json();
      if (s.running) { say('Scanning…'); setTimeout(tick, 5000); return; }
      say(s.exit === 0
        ? `Scan done — ${s.added || 0} new role(s) in the inbox.`
        : `Scan exited ${s.exit}. Open the log for details.`, s.exit === 0 ? 'ok' : 'bad');
      btn.disabled = false;
      loadPipeline();
      loadToday();
    } catch { setTimeout(tick, 8000); }
  };
  setTimeout(tick, 4000);
}

async function bulkDismiss(btn) {
  const days = Number(btn.dataset.days);
  const n = PIPE.filter((r) => r.age_days != null && r.age_days >= days).length;
  if (!n) { alert(`Nothing in the inbox is ${days}+ days old.`); return; }
  // Reversible, but 100+ rows at once deserves a real confirmation, not a
  // two-tap arm like the single-row dismiss.
  if (!confirm(`Dismiss ${n} scouted role(s) older than ${days} days?\n\nThey are marked "DISMISSED" in pipeline.md, not deleted, so this can be undone.`)) return;

  const msg = btn.closest('.pipe-actions')?.querySelector('.act-msg');
  const say = (t, cls = '') => { if (msg) { msg.className = `act-msg ${cls}`; msg.textContent = t; } };
  [...btn.closest('.pipe-actions').querySelectorAll('button')].forEach((b) => { b.disabled = true; });
  say(`Dismissing ${n}…`);
  try {
    const r = await fetch('/api/pipeline/dismiss-older', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days }),
    });
    if (r.status === 401) { showLogin(); return; }
    const b = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(b.message || b.error || `HTTP ${r.status}`);
    say(`Dismissed ${b.dismissed}.`, 'ok');
    await loadPipeline();
    renderPipeline();
  } catch (e) {
    say(e.message, 'bad');
    [...btn.closest('.pipe-actions').querySelectorAll('button')].forEach((b) => { b.disabled = false; });
  }
}

// ── report viewer ────────────────────────────────────────────────────────────
// A 35KB markdown file on disk is unreadable on a phone, which is the real
// reason evaluations went undecided: the verdict was somewhere unreachable.

/** Minimal, escape-first markdown. Never inserts unescaped input. */
function mdToHtml(md) {
  const lines = esc(md).split('\n');
  const out = [];
  let inCode = false;
  let inList = false;
  for (const raw of lines) {
    if (/^```/.test(raw)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(raw); continue; }
    const line = raw
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${li[1]}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    if (h) { out.push(`<h${h[1].length + 2}>${h[2]}</h${h[1].length + 2}>`); continue; }
    if (!line.trim()) continue;
    out.push(`<p>${line}</p>`);
  }
  if (inList) out.push('</ul>');
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

async function openReport(num) {
  const body = $('#drawerBody');
  body.innerHTML = `<h2>Report ${esc(num)}</h2><p class="muted">Loading…</p>`;
  showDrawer(true);
  try {
    const r = await fetch(`/api/report/${encodeURIComponent(num)}`);
    if (r.status === 401) { showLogin(); return; }
    const b = await r.json();
    if (!r.ok) throw new Error(b.message || b.error || `HTTP ${r.status}`);
    body.innerHTML = `<div class="report">${mdToHtml(b.markdown)}</div>`;
  } catch (e) {
    body.innerHTML = `<h2>Report ${esc(num)}</h2><p class="err">${esc(e.message)}</p>`;
  }
}

function setTab(tab) {
  TAB = tab;
  for (const [id, name] of [['#tabToday', 'today'], ['#tabTracker', 'tracker'],
    ['#tabPipeline', 'pipeline'], ['#tabHealth', 'health']]) {
    $(id).classList.toggle('on', tab === name);
  }
  const trackerView = tab === 'tracker';
  $('#chips').hidden = !trackerView;
  $('#view').hidden = !trackerView;
  // A hidden filter is a broken filter: the box is not shown on My day or the
  // Queue, so a term left in it would keep filtering Scouted and Applications
  // with nothing on screen to explain why (2026-09-03: "Scouted shows 106 but
  // it's empty"). Drop it on the way out rather than hiding a live control.
  const searchable = tab !== 'health' && tab !== 'today';
  if (!searchable && $('#search').value) $('#search').value = '';
  $('#search').parentElement.hidden = !searchable;
  $('#rows').hidden = !trackerView;
  $('#board').hidden = !trackerView;
  $('#pipeline').hidden = tab !== 'pipeline';
  $('#health').hidden = tab !== 'health';
  $('#today').hidden = tab !== 'today';
  $('#empty').hidden = true;
  if (tab === 'tracker') render();
  else if (tab === 'pipeline') renderPipeline();
  else if (tab === 'today') { renderToday(); loadToday(); }
  else { renderHealth(); loadHealth(); }
}

$('#tabToday').onclick = () => setTab('today');
$('#tabTracker').onclick = () => setTab('tracker');
$('#tabPipeline').onclick = () => setTab('pipeline');
$('#tabHealth').onclick = () => setTab('health');

// ── boot ─────────────────────────────────────────────────────────────────────
$('#view').textContent = view === 'cards' ? '▦' : '▤';

// Health polls on its own timer regardless of which tab is open — the banner
// and the title badge are the point, and both have to work while you are
// reading the tracker. 60s: a stall is measured in tens of minutes, and each
// poll costs one cached `claude auth status` at most.
let healthTimer = null;
function startHealthPolling() {
  if (healthTimer) return;
  loadHealth();
  healthTimer = setInterval(loadHealth, 60_000);
}
function stopHealthPolling() {
  clearInterval(healthTimer);
  healthTimer = null;
  HEALTH = null;
  document.title = BASE_TITLE;
  $('#banner').hidden = true;
  $('#healthDot').hidden = true;
}
// Coming back to a tab left open overnight should re-check immediately rather
// than showing whatever was true when you walked away.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && healthTimer) loadHealth();
});

fetch('/api/session')
  .then((r) => r.json())
  .then((s) => {
    if (s.authenticated) { showApp(); setTab('tracker'); load(); loadPipeline(); loadToday(); loadConfig(); startHealthPolling(); }
    else { showLogin(); }
  })
  .catch(() => showLogin());
