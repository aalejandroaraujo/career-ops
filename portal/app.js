'use strict';
const $ = (s) => document.querySelector(s);
const rowsEl = $('#rows'), statsEl = $('#stats'), emptyEl = $('#empty');
let JOBS = [], STATES = [];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fitClass = (n) => n == null ? '' : n >= 4.2 ? 'hi' : n >= 3.4 ? 'mid' : 'lo';
const STATUS_ORDER = ['Interview', 'Offer', 'Responded', 'Applied', 'Evaluated', 'SKIP', 'Rejected', 'Discarded'];

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || ('HTTP ' + r.status));
  return r.json();
}

async function load() {
  const data = await api('/api/jobs');
  JOBS = data.jobs; STATES = data.states;
  const sf = $('#statusFilter');
  if (sf.options.length <= 1) STATES.forEach((s) => sf.add(new Option(s, s)));
  render();
}

function render() {
  const q = $('#search').value.trim().toLowerCase();
  const sfilter = $('#statusFilter').value;
  const sort = $('#sort').value;
  const list = JOBS.filter((j) =>
    (!q || (j.company + ' ' + j.role).toLowerCase().includes(q)) &&
    (!sfilter || j.status === sfilter));
  list.sort((a, b) =>
    sort === 'score' ? (b.scoreNum || 0) - (a.scoreNum || 0) :
    sort === 'company' ? a.company.localeCompare(b.company) :
    sort === 'status' ? STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) :
    b.num - a.num);

  rowsEl.innerHTML = list.map((j) => {
    const meta = [
      j.date ? `<span>📅 ${esc(j.date)}</span>` : '',
      j.pay ? `<span>💸 ${esc(j.pay)}</span>` : '',
      j.location ? `<span>📍 ${esc(j.location)}</span>` : '',
      `<span class="muted">#${j.num}</span>`,
    ].join('');
    const opts = STATES.map((s) => `<option ${s === j.status ? 'selected' : ''}>${s}</option>`).join('');
    return `<div class="card" data-num="${j.num}">
      <div class="top">
        <div class="co" data-view="${j.num}">${esc(j.company)}</div>
        <div class="fit ${fitClass(j.scoreNum)}">${esc(j.score || '—')}</div>
      </div>
      <div class="role">${esc(j.role)}</div>
      <div class="meta">${meta}</div>
      <div class="foot">
        <select class="status" data-s="${esc(j.status)}" data-num="${j.num}">${opts}</select>
        ${j.reportNum ? `<span class="link" data-view="${j.num}">Report</span>` : ''}
        ${j.hasCv ? `<a class="link" href="/api/jobs/${j.num}/cv" target="_blank" rel="noopener">CV</a>` : ''}
      </div>
    </div>`;
  }).join('');

  emptyEl.hidden = JOBS.length > 0;
  const counts = JOBS.reduce((m, j) => ((m[j.status] = (m[j.status] || 0) + 1), m), {});
  statsEl.textContent = `${JOBS.length} jobs · ` +
    STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(' · ');
}

rowsEl.addEventListener('change', async (e) => {
  const sel = e.target.closest('select.status'); if (!sel) return;
  const num = Number(sel.dataset.num), status = sel.value, prev = sel.dataset.s;
  sel.disabled = true;
  try {
    await api(`/api/jobs/${num}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) });
    const j = JOBS.find((x) => x.num === num); if (j) j.status = status;
    sel.dataset.s = status;
  } catch (err) { alert('Update failed: ' + err.message); sel.value = prev; }
  finally { sel.disabled = false; }
});

rowsEl.addEventListener('click', (e) => {
  const v = e.target.closest('[data-view]'); if (v) openDrawer(Number(v.dataset.view));
});

function md(text) {
  return esc(text)
    .replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+?)`/g, '<code>$1</code>')
    .replace(/^\s*[-*] (.*)$/gm, '• $1');
}

async function openDrawer(num) {
  const j = JOBS.find((x) => x.num === num); if (!j) return;
  const body = $('#drawerBody');
  body.innerHTML = `<h2>${esc(j.company)}</h2><div class="muted">${esc(j.role)}</div><p class="muted">Loading…</p>`;
  showDrawer(true);
  let rep = null;
  try { rep = await api(`/api/jobs/${num}/report`); } catch { /* no report */ }
  const s = (rep && rep.summary) || {};
  const dec = String(s.final_decision || '').toLowerCase();
  const decCls = dec.includes('apply') ? 'apply' : (dec.includes('skip') || dec.includes('no')) ? 'skip' : '';
  const list = (v) => Array.isArray(v) ? v.map((x) => `<div>• ${esc(x)}</div>`).join('') : esc(v || '');
  body.innerHTML = `
    <h2>${esc(j.company)}</h2><div class="muted">${esc(j.role)}</div>
    <div class="actions">
      <span class="badge fit ${fitClass(j.scoreNum)}">${esc(j.score || '—')}</span>
      ${j.reportNum ? `<span class="badge">report #${esc(j.reportNum)}</span>` : ''}
      ${j.hasCv ? `<a class="badge" href="/api/jobs/${num}/cv" target="_blank" rel="noopener">Download CV</a>` : ''}
    </div>
    <h3>Summary</h3>
    <dl class="kv">
      <dt>Decision</dt><dd>${s.final_decision ? `<span class="badge ${decCls}">${esc(s.final_decision)}</span>` : '<span class="muted">—</span>'}</dd>
      <dt>Archetype</dt><dd>${esc(s.archetype || '—')}</dd>
      <dt>Legitimacy</dt><dd>${esc(s.legitimacy_tier || '—')}</dd>
      <dt>Risk</dt><dd>${esc(s.risk_level || '—')}</dd>
      <dt>Confidence</dt><dd>${esc(s.confidence || '—')}</dd>
      <dt>Next action</dt><dd>${esc(s.next_action || '—')}</dd>
    </dl>
    ${s.top_strengths ? `<h3>Top strengths</h3><div>${list(s.top_strengths)}</div>` : ''}
    ${s.hard_stops && s.hard_stops.length ? `<h3>Hard stops</h3><div>${list(s.hard_stops)}</div>` : ''}
    ${rep ? `<h3>Full report</h3><div class="report">${md(rep.markdown)}</div>` : '<p class="muted">No report file found for this job.</p>'}`;
}

function showDrawer(on) { $('#drawer').hidden = !on; $('#scrim').hidden = !on; document.body.style.overflow = on ? 'hidden' : ''; }
$('#drawerClose').onclick = () => showDrawer(false);
$('#scrim').onclick = () => showDrawer(false);
$('#search').oninput = render;
$('#statusFilter').onchange = render;
$('#sort').onchange = render;
$('#refresh').onclick = () => load().catch((e) => alert(e.message));

load().catch((e) => { statsEl.textContent = 'Error: ' + e.message; });
