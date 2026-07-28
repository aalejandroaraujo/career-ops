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
let filter = 'ongoing';   // 'ongoing' | 'all' | a canonical status
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
  load();
});

$('#logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  ROWS = [];
  showLogin();
};

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
  const meta = [
    r.date ? `<span>📅 ${esc(r.date)}</span>` : '',
    r.age_days != null ? `<span>⏳ ${r.age_days}d</span>` : '',
    r.pdf === '✅' ? '<span>📄 CV</span>' : '',
  ].join('');
  return `<div class="card" data-uid="${esc(r.app_uid)}">
    <div class="top">
      <div class="co" data-view="${esc(r.app_uid)}">${esc(r.company)}</div>
      <div class="fit ${fitClass(n)}">${esc(r.score || '—')}</div>
    </div>
    <div class="role">${esc(r.role)}</div>
    <div class="meta">${meta}</div>
    <div class="foot">
      <select class="status" data-s="${esc(r.status)}" data-uid="${esc(r.app_uid)}" ${r.app_uid ? '' : 'disabled'}>${opts}</select>
      <button class="link" data-view="${esc(r.app_uid)}">Details</button>
    </div>
  </div>`;
}

function render() {
  const list = visible();
  $('#rows').hidden = view !== 'cards';
  $('#board').hidden = view !== 'board';

  if (view === 'cards') {
    list.sort((a, b) => (scoreNum(b.score) || 0) - (scoreNum(a.score) || 0));
    $('#rows').innerHTML = list.map(cardHtml).join('');
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

  $('#empty').hidden = list.length > 0;
  $('#stats').textContent = `${list.length} shown · ${ROWS.length} total`;
}

// ── interactions ─────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) { filter = chip.dataset.filter; renderChips(); render(); return; }
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
$('#search').oninput = render;
$('#refresh').onclick = () => load();
$('#view').onclick = () => {
  view = view === 'cards' ? 'board' : 'cards';
  localStorage.setItem('co.view', view);
  $('#view').textContent = view === 'cards' ? '▦' : '▤';
  render();
};

// ── boot ─────────────────────────────────────────────────────────────────────
$('#view').textContent = view === 'cards' ? '▦' : '▤';
fetch('/api/session')
  .then((r) => r.json())
  .then((s) => { if (s.authenticated) { showApp(); load(); } else { showLogin(); } })
  .catch(() => showLogin());
