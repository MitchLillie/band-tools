'use strict';

const WEEK_CACHE_TTL_MS = 5 * 60 * 1000;

// ---- Messaging ----

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp) return reject(new Error('No response from background'));
      if (!resp.ok) return reject(new Error(resp.error));
      resolve(resp.result);
    });
  });
}

// ---- Storage helpers ----

function loadSettings() {
  return new Promise(r => chrome.storage.sync.get({
    default_band: '', default_calendar: '', default_group: '',
    week_days: 7, sync_days: 120,
  }, r));
}

// ---- Tab switching ----

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// ---- Options link ----

document.getElementById('options-link').addEventListener('click', e => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ---- Utilities ----

function setHtml(el, html) { el.innerHTML = html; }
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function fmtDate(isoStr) {
  try {
    const d = new Date(isoStr);
    return `${d.getMonth()+1}/${d.getDate()}`;
  } catch (_) { return isoStr?.slice(0, 10) || ''; }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtCopy(ev) {
  try {
    const d = new Date(ev.start_at);
    return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()} — ${ev.name}`;
  } catch (_) { return `${ev.when} — ${ev.name}`; }
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function detectBandNo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const m = tab.url.match(/band\.us\/band\/(\d+)/);
      if (m) return m[1];
    }
  } catch (_) {}
  try {
    const res = await new Promise(r => chrome.storage.session.get('detected_band_no', r));
    if (res.detected_band_no) return String(res.detected_band_no);
  } catch (_) {}
  return null;
}

// ---- Init ----

let currentBandNo = null;
let currentMeUserNo = null;
let currentMeName = null;

async function init() {
  try {
    await send({ type: 'check_auth' });
    hide(document.getElementById('auth-error'));
  } catch (_) {
    show(document.getElementById('auth-error'));
    return;
  }

  const settings = await loadSettings();
  currentBandNo = Number(await detectBandNo() || settings.default_band || 0) || null;

  let localMe = await new Promise(r => chrome.storage.local.get(['me_user_no', 'me_name'], r));
  if (!localMe.me_user_no && currentBandNo) {
    try {
      const result = await send({ type: 'detect_me', band_no: currentBandNo });
      if (result?.user_no) localMe = { me_user_no: result.user_no, me_name: result.name };
    } catch (_) {}
  }
  currentMeUserNo = localMe.me_user_no || null;
  currentMeName   = localMe.me_name   || null;

  document.getElementById('band-info').textContent = 'Band Tools';
  document.getElementById('week-days').value = settings.week_days;
  document.getElementById('sync-days').value = settings.sync_days;

  if (!currentBandNo) {
    setHtml(document.getElementById('week-results'),
      '<p class="err">No band configured. <a href="#" id="go-settings">Open Settings</a> to set your band number.</p>');
    document.getElementById('go-settings')?.addEventListener('click', e => {
      e.preventDefault(); chrome.runtime.openOptionsPage();
    });
    return;
  }

  // Check admin and show Admin tab if applicable
  let isAdmin = false;
  try {
    isAdmin = await send({ type: 'check_admin', band_no: currentBandNo });
  } catch (_) {}

  if (isAdmin) {
    show(document.getElementById('tabs'));
    populateSyncDropdowns(currentBandNo, settings.default_calendar, settings.default_group);
  }

  await populateWeekCalendarDropdown(currentBandNo, settings.default_calendar);
  loadWeek();
}

init();

// ---- Calendar dropdown ----

async function populateWeekCalendarDropdown(band_no, defaultCal) {
  const sel = document.getElementById('week-calendar');
  try {
    const calData = await send({ type: 'get_calendars', band_no: Number(band_no) });
    const cals = calData.internal_calendars || calData.calendars || calData.items || [];
    sel.innerHTML = '<option value="">All calendars</option>' + cals.map(c => {
      const id = c.calendar_id ?? '';
      const name = c.name || (c.is_default ? 'Default' : `Calendar ${id}`);
      const selected = String(id) === String(defaultCal) ? ' selected' : '';
      return `<option value="${id}"${selected}>${escHtml(name)}</option>`;
    }).join('');
  } catch (_) {}
}

document.getElementById('week-calendar').addEventListener('change', () => loadWeek(true));

// ---- Event list ----

let weekItems = [];

async function loadWeek(forceRefresh = false) {
  const resultsEl = document.getElementById('week-results');
  const days = Number(document.getElementById('week-days').value) || 7;
  const calVal = document.getElementById('week-calendar').value;
  const calendar_id = calVal ? Number(calVal) : null;

  if (!currentBandNo) return;

  if (!forceRefresh) {
    try {
      const cached = await new Promise(r => chrome.storage.session.get('week_cache', r));
      if (cached.week_cache) {
        const { ts, items, band_no, calendar_id: cachedCal, days: cachedDays } = cached.week_cache;
        if (Date.now() - ts < WEEK_CACHE_TTL_MS &&
            band_no === currentBandNo && cachedCal === calendar_id && cachedDays === days) {
          weekItems = items;
          renderWeek(resultsEl, items);
          return;
        }
      }
    } catch (_) {}
  }

  setHtml(resultsEl, '<p class="msg">Loading…</p>');
  try {
    const items = await send({ type: 'band_week', band_no: currentBandNo, days, calendar_id, me_name: currentMeName });
    // Merge any cached RSVP statuses we learned from previous expands this session
    await mergeRsvpCache(items);
    weekItems = items;
    chrome.storage.session.set({ week_cache: { ts: Date.now(), items, band_no: currentBandNo, calendar_id, days } });
    renderWeek(resultsEl, items);
  } catch (err) {
    setHtml(resultsEl, `<p class="err">${escHtml(err.message)}</p>`);
  }
}

const RSVP_ACTIVE_CLASS = { 1: 'active-going', 2: 'active-not-going', 3: 'active-maybe' };

// ---- RSVP status session cache ----
// Keyed by schedule_id; persists across popup close/reopen within the same Chrome session.

async function saveRsvpStatus(schedule_id, status) {
  try {
    const { rsvp_status_cache: cur } = await new Promise(r =>
      chrome.storage.session.get('rsvp_status_cache', r));
    const next = { ...(cur || {}), [schedule_id]: status };
    chrome.storage.session.set({ rsvp_status_cache: next });
  } catch (_) {}
}

async function mergeRsvpCache(items) {
  try {
    const { rsvp_status_cache: cache } = await new Promise(r =>
      chrome.storage.session.get('rsvp_status_cache', r));
    if (!cache) return;
    for (const ev of items) {
      if (ev.my_rsvp == null && ev.schedule_id && cache[ev.schedule_id] != null)
        ev.my_rsvp = cache[ev.schedule_id];
    }
  } catch (_) {}
}

function renderWeek(el, items) {
  if (!items.length) {
    setHtml(el, '<p class="msg">No events in this period.</p>');
    return;
  }

  el.innerHTML = items.map((ev, i) => {
    const safeUrl = ev.url.startsWith('https://') ? ev.url : '#';
    const rsvpRow = ev.rsvp_enabled ? `
      <div class="event-rsvp">
        <button class="rsvp-btn ${ev.my_rsvp === 1 ? 'active-going' : ''}" data-idx="${i}" data-status="1">Going</button>
        <button class="rsvp-btn ${ev.my_rsvp === 2 ? 'active-not-going' : ''}" data-idx="${i}" data-status="2">Not Going</button>
        ${ev.maybe_enabled ? `<button class="rsvp-btn ${ev.my_rsvp === 3 ? 'active-maybe' : ''}" data-idx="${i}" data-status="3">Maybe</button>` : ''}
      </div>` : '';
    return `
      <div class="event-item">
        <div class="event-header">
          <span class="event-when">${escHtml(ev.when)}</span>
          <a href="${safeUrl}" target="_blank" rel="noopener" class="event-name">${escHtml(ev.name)}</a>
          <button class="btn-copy-event" data-idx="${i}" title="Copy event">⎘</button>
          <button class="btn-expand" data-idx="${i}" title="Show RSVP details">›</button>
        </div>
        ${rsvpRow}
        <div class="event-detail hidden" data-idx="${i}"></div>
      </div>`;
  }).join('');

  el.querySelectorAll('.btn-expand').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      const detailEl = el.querySelector(`.event-detail[data-idx="${idx}"]`);
      const expanded = btn.classList.contains('expanded');
      if (expanded) {
        btn.classList.remove('expanded');
        hide(detailEl);
      } else {
        btn.classList.add('expanded');
        loadEventDetail(idx, detailEl);
      }
    });
  });

  el.querySelectorAll('.btn-copy-event').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ev = weekItems[Number(btn.dataset.idx)];
      if (!ev) return;
      await navigator.clipboard.writeText(fmtCopy(ev));
      flashCopied(btn, '⎘');
    });
  });

  el.querySelectorAll('.rsvp-btn').forEach(btn => {
    btn.addEventListener('click', () => handleRsvpClick(btn, Number(btn.dataset.idx), Number(btn.dataset.status)));
  });
}

async function loadEventDetail(idx, detailEl) {
  const ev = weekItems[idx];
  if (!ev) return;

  // Only load once per open
  if (detailEl.dataset.loaded === 'true') {
    show(detailEl);
    return;
  }

  const bandNo = ev.band_no || currentBandNo;
  const scheduleId = ev.schedule_id;
  if (!scheduleId) {
    setHtml(detailEl, '<p class="msg detail-msg">Event ID unavailable.</p>');
    show(detailEl);
    return;
  }

  setHtml(detailEl, '<p class="msg detail-msg">Loading…</p>');
  show(detailEl);

  try {
    const data = await send({ type: 'rsvp_status', band_no: bandNo, schedule_id: scheduleId, me_name: currentMeName });
    renderEventDetail(detailEl, data);
    detailEl.dataset.loaded = 'true';
    // Backfill RSVP button highlight if we just learned the user's status
    if (data.my_rsvp != null && weekItems[idx]?.my_rsvp == null) {
      weekItems[idx] = { ...weekItems[idx], my_rsvp: data.my_rsvp };
      updateRsvpButtonState(idx, data.my_rsvp);
      saveRsvpStatus(ev.schedule_id, data.my_rsvp);
    }
  } catch (err) {
    setHtml(detailEl, `<p class="err detail-msg">${escHtml(err.message)}</p>`);
  }
}

function nameChips(names, chipClass = '') {
  return names.map(n => `<span class="name-chip ${chipClass}">${escHtml(n)}</span>`).join('');
}

function renderEventDetail(el, d) {
  const hasInviteList = d.total_invited > 0;
  const sections = [];

  if (d.going?.length)
    sections.push(`<div class="names-section">
      <div class="names-label going-label">Going (${d.going.length})</div>
      <div class="names-list">${nameChips(d.going, 'chip-going')}</div>
    </div>`);

  if (d.not_going?.length)
    sections.push(`<div class="names-section">
      <div class="names-label not-going-label">Not Going (${d.not_going.length})</div>
      <div class="names-list">${nameChips(d.not_going, 'chip-not-going')}</div>
    </div>`);

  if (d.maybe?.length)
    sections.push(`<div class="names-section">
      <div class="names-label maybe-label">Maybe (${d.maybe.length})</div>
      <div class="names-list">${nameChips(d.maybe, 'chip-maybe')}</div>
    </div>`);

  if (hasInviteList && d.not_responded?.length)
    sections.push(`<div class="names-section">
      <div class="names-label no-resp-label">No Response (${d.not_responded.length})</div>
      <div class="names-list">${nameChips(d.not_responded.map(u => u.name))}</div>
    </div>`);

  if (!sections.length)
    sections.push('<p class="detail-msg">No RSVP responses yet.</p>');

  setHtml(el, sections.join(''));
}

function updateRsvpButtonState(idx, status) {
  const resultsEl = document.getElementById('week-results');
  if (!resultsEl) return;
  resultsEl.querySelectorAll(`.rsvp-btn[data-idx="${idx}"]`).forEach(b =>
    b.classList.remove('active-going', 'active-not-going', 'active-maybe'));
  if (status && RSVP_ACTIVE_CLASS[status]) {
    resultsEl.querySelector(`.rsvp-btn[data-idx="${idx}"][data-status="${status}"]`)
      ?.classList.add(RSVP_ACTIVE_CLASS[status]);
  }
}

async function handleRsvpClick(btn, idx, newStatus) {
  const ev = weekItems[idx];
  if (!ev) return;

  const bandNo = ev.band_no || currentBandNo;
  const scheduleId = ev.schedule_id;
  if (!scheduleId) { alert('Cannot update RSVP: event ID unavailable.'); return; }

  const rsvpRow = btn.closest('.event-rsvp');
  const prevStatus = ev.my_rsvp;

  // Optimistic update
  rsvpRow.querySelectorAll('.rsvp-btn').forEach(b =>
    b.classList.remove('active-going', 'active-not-going', 'active-maybe'));
  btn.classList.add(RSVP_ACTIVE_CLASS[newStatus]);
  weekItems[idx] = { ...ev, my_rsvp: newStatus };

  try {
    await send({ type: 'update_rsvp', band_no: bandNo, schedule_id: scheduleId, rsvp_type: newStatus, me_user_no: currentMeUserNo });
    saveRsvpStatus(scheduleId, newStatus);
    // Invalidate cached detail so it reloads with updated counts
    const resultsEl = document.getElementById('week-results');
    const detailEl = resultsEl?.querySelector(`.event-detail[data-idx="${idx}"]`);
    if (detailEl) detailEl.dataset.loaded = '';
  } catch (err) {
    // Revert
    weekItems[idx] = ev;
    rsvpRow.querySelectorAll('.rsvp-btn').forEach(b =>
      b.classList.remove('active-going', 'active-not-going', 'active-maybe'));
    if (prevStatus && RSVP_ACTIVE_CLASS[prevStatus])
      rsvpRow.querySelector(`[data-status="${prevStatus}"]`)?.classList.add(RSVP_ACTIVE_CLASS[prevStatus]);
    alert(`RSVP update failed: ${err.message}`);
  }
}

// Re-load when days input changes (debounced)
let weekDebounce;
document.getElementById('week-days').addEventListener('input', () => {
  clearTimeout(weekDebounce);
  weekDebounce = setTimeout(() => loadWeek(true), 600);
});

async function flashCopied(btn, originalText) {
  btn.classList.add('copied');
  btn.textContent = '✓';
  setTimeout(() => { btn.classList.remove('copied'); btn.textContent = originalText; }, 1500);
}

// Copy all as plain text
document.getElementById('week-copy').addEventListener('click', async () => {
  if (!weekItems.length) return;
  const text = weekItems.map(fmtCopy).join('\n');
  await navigator.clipboard.writeText(text);
  flashCopied(document.getElementById('week-copy'), '⎘');
});

// ---- Sync Group (Admin tab) ----

let syncDryRunResult = null;

async function populateSyncDropdowns(band_no, defaultCal, defaultGroup) {
  const calSel = document.getElementById('sync-calendar');
  const grpSel = document.getElementById('sync-group');

  try {
    const [calData, grpData] = await Promise.all([
      send({ type: 'get_calendars', band_no: Number(band_no) }),
      send({ type: 'get_member_groups', band_no: Number(band_no) }),
    ]);

    const cals = calData.internal_calendars || calData.calendars || calData.items || [];
    calSel.innerHTML = cals.map(c => {
      const id = c.calendar_id ?? '';
      const name = c.name || (c.is_default ? 'Default' : `Calendar ${id}`);
      const sel = String(id) === String(defaultCal) ? ' selected' : '';
      return `<option value="${id}"${sel}>${escHtml(name)}</option>`;
    }).join('') || '<option value="">No calendars</option>';

    const groups = grpData.items || [];
    grpSel.innerHTML = groups.map(g => {
      const sel = String(g.member_group_id) === String(defaultGroup) ? ' selected' : '';
      return `<option value="${g.member_group_id}"${sel}>${escHtml(g.name)} (${g.member_count})</option>`;
    }).join('') || '<option value="">No groups</option>';
  } catch (err) {
    calSel.innerHTML = '<option value="">Error loading</option>';
    grpSel.innerHTML = '<option value="">Error loading</option>';
  }
}

document.getElementById('sync-dry').addEventListener('click', async () => {
  const calendar_id = Number(document.getElementById('sync-calendar').value);
  const group_id = Number(document.getElementById('sync-group').value);
  const days = Number(document.getElementById('sync-days').value) || 120;
  const resultsEl = document.getElementById('sync-results');
  const applyBtn = document.getElementById('sync-apply');

  if (!currentBandNo || !calendar_id || !group_id) {
    setHtml(resultsEl, '<p class="err">Select a calendar and group (configure band in Settings).</p>');
    return;
  }

  syncDryRunResult = null;
  hide(applyBtn);
  setHtml(resultsEl, '<p class="msg">Running dry run… (this may take a moment)</p>');

  try {
    const result = await send({ type: 'sync_group_dry', band_no: currentBandNo, calendar_id, group_id, days, me_user_no: currentMeUserNo });
    syncDryRunResult = { calendar_id, group_id, days };

    if (!result.updates_needed) {
      setHtml(resultsEl, `<p class="ok">All ${result.events_checked} events already have all group members. Nothing to do.</p>`);
      return;
    }

    const rows = result.updates.map(u => `
      <div class="sync-event">
        <strong>${escHtml(u.name)}</strong>
        <div class="meta">${fmtDate(u.start_at)} — adding ${u.missing_count}: ${escHtml(u.missing_names.slice(0, 5).join(', '))}${u.missing_count > 5 ? ` +${u.missing_count - 5} more` : ''}</div>
      </div>
    `).join('');

    setHtml(resultsEl, `
      <p style="margin-bottom:8px"><strong>${result.updates_needed} events</strong> need updates (checked ${result.events_checked}, group has ${result.group_size} members).</p>
      ${rows}
    `);
    show(applyBtn);
  } catch (err) {
    setHtml(resultsEl, `<p class="err">${escHtml(err.message)}</p>`);
  }
});

document.getElementById('sync-apply').addEventListener('click', async () => {
  if (!syncDryRunResult) return;
  if (!confirm('Apply changes? This will update all affected events on band.us.')) return;

  const { calendar_id, group_id, days } = syncDryRunResult;
  const resultsEl = document.getElementById('sync-results');
  const applyBtn = document.getElementById('sync-apply');

  hide(applyBtn);
  setHtml(resultsEl, '<p class="msg">Applying changes…</p>');
  try {
    const result = await send({ type: 'sync_group_apply', band_no: currentBandNo, calendar_id, group_id, days, me_user_no: currentMeUserNo, notify: true });
    setHtml(resultsEl, `<p class="ok">Done! Updated ${result.applied_count} event(s).</p>`);
    syncDryRunResult = null;
  } catch (err) {
    setHtml(resultsEl, `<p class="err">${escHtml(err.message)}</p>`);
    show(applyBtn);
  }
});
