'use strict';

const WEEK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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

function saveSettings(obj) {
  return new Promise(r => chrome.storage.sync.set(obj, r));
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

async function init() {
  try {
    await send({ type: 'check_auth' });
    hide(document.getElementById('auth-error'));
  } catch (_) {
    show(document.getElementById('auth-error'));
  }

  const settings = await loadSettings();
  currentBandNo = Number(await detectBandNo() || settings.default_band || 0) || null;

  // Read auto-detected user_no from session, fall back to saved setting
  let localMe = await new Promise(r => chrome.storage.local.get('me_user_no', r));
  if (!localMe.me_user_no && currentBandNo) {
    // Not cached yet — detect now
    try {
      const result = await send({ type: 'detect_me', band_no: currentBandNo });
      if (result?.user_no) localMe = { me_user_no: result.user_no };
    } catch (_) {}
  }
  currentMeUserNo = localMe.me_user_no || null;

  const bandLabel = currentBandNo ? `Band ${currentBandNo}` : 'Band Tools';
  document.getElementById('band-info').textContent = bandLabel;

  document.getElementById('week-days').value = settings.week_days;
  document.getElementById('sync-days').value = settings.sync_days;

  if (currentBandNo) {
    await populateWeekCalendarDropdown(currentBandNo, settings.default_calendar);
    populateSyncDropdowns(currentBandNo, settings.default_calendar, settings.default_group);
    loadWeek();
  } else {
    setHtml(document.getElementById('week-results'),
      '<p class="err">No band configured. <a href="#" id="go-settings">Open Settings</a> to set your band number.</p>');
    document.getElementById('go-settings')?.addEventListener('click', e => {
      e.preventDefault(); chrome.runtime.openOptionsPage();
    });
  }

  // Auto-fill RSVP schedule_id from active tab URL
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('/schedule/')) {
      const m = tab.url.match(/\/schedule\/(.+)$/);
      if (m) document.getElementById('rsvp-event').value = decodeURIComponent(m[1]);
    }
  } catch (_) {}
}

init();

// ---- Band Week ----

let weekItems = [];

async function populateWeekCalendarDropdown(band_no, defaultCal) {
  const sel = document.getElementById('week-calendar');
  try {
    const calData = await send({ type: 'get_calendars', band_no: Number(band_no) });
    const cals = calData.internal_calendars || calData.calendars || calData.items || [];
    sel.innerHTML = '<option value="">All calendars</option>' + cals.map(c => {
      const id = c.calendar_id ?? '';
      const name = c.name || (c.is_default ? 'Default' : `Calendar ${id}`);
      const sel2 = String(id) === String(defaultCal) ? ' selected' : '';
      return `<option value="${id}"${sel2}>${escHtml(name)}</option>`;
    }).join('');
  } catch (_) {}
}

document.getElementById('week-calendar').addEventListener('change', () => loadWeek(true));

async function loadWeek(forceRefresh = false) {
  const resultsEl = document.getElementById('week-results');
  const days = Number(document.getElementById('week-days').value) || 7;
  const calVal = document.getElementById('week-calendar').value;
  const calendar_id = calVal ? Number(calVal) : null;

  if (!currentBandNo) return;

  // Check cache
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
    const items = await send({ type: 'band_week', band_no: currentBandNo, days, calendar_id });
    weekItems = items;
    chrome.storage.session.set({ week_cache: { ts: Date.now(), items, band_no: currentBandNo, calendar_id, days } });
    renderWeek(resultsEl, items);
  } catch (err) {
    setHtml(resultsEl, `<p class="err">${escHtml(err.message)}</p>`);
  }
}

function renderWeek(el, items) {
  if (!items.length) {
    setHtml(el, '<p class="msg">No events in this period.</p>');
    return;
  }
  setHtml(el, items.map(ev => {
    const safeUrl = ev.url.startsWith('https://') ? ev.url : '#';
    return `<div class="event-item">
      <div class="event-when">${ev.when}</div>
      <a href="${safeUrl}" target="_blank" rel="noopener">${escHtml(ev.name)}</a>
    </div>`;
  }).join(''));
}

// Re-load when days input changes (debounced)
let weekDebounce;
document.getElementById('week-days').addEventListener('input', () => {
  clearTimeout(weekDebounce);
  weekDebounce = setTimeout(() => loadWeek(true), 600);
});

// Copy as plain text (same format as CLI)
document.getElementById('week-copy').addEventListener('click', async () => {
  if (!weekItems.length) return;
  const text = weekItems.map(ev => `${ev.when} - ${ev.name} - ${ev.url}`).join('\n');
  await navigator.clipboard.writeText(text);
  const btn = document.getElementById('week-copy');
  btn.classList.add('copied');
  btn.textContent = '✓';
  setTimeout(() => { btn.classList.remove('copied'); btn.textContent = '⎘'; }, 1500);
});

// ---- RSVP Status ----

document.getElementById('rsvp-load').addEventListener('click', async () => {
  const raw = document.getElementById('rsvp-event').value.trim();
  const resultsEl = document.getElementById('rsvp-results');

  if (!currentBandNo) {
    setHtml(resultsEl, '<p class="err">No band configured in settings.</p>');
    return;
  }
  if (!raw) {
    setHtml(resultsEl, '<p class="err">Enter an event URL or schedule ID.</p>');
    return;
  }

  let schedule_id = raw;
  const urlMatch = raw.match(/\/schedule\/(.+)$/);
  if (urlMatch) schedule_id = decodeURIComponent(urlMatch[1]);

  // Extract band_no from URL if present (event may be on a different band)
  const bandMatch = raw.match(/\/band\/(\d+)/);
  const band_no = bandMatch ? Number(bandMatch[1]) : currentBandNo;

  setHtml(resultsEl, '<p class="msg">Loading…</p>');
  try {
    const data = await send({ type: 'rsvp_status', band_no, schedule_id });
    renderRsvp(resultsEl, data);
  } catch (err) {
    setHtml(resultsEl, `<p class="err">${escHtml(err.message)}</p>`);
  }
});

function renderRsvp(el, d) {
  const notNames = d.not_responded.map(u => `<span class="name-chip">${escHtml(u.name)}</span>`).join('');
  const respondedNames = d.responded.map(u => `<span class="name-chip responded">${escHtml(u.name)}</span>`).join('');
  setHtml(el, `
    <div class="event-item">
      <strong>${escHtml(d.event_name)}</strong>
      <div class="event-when">${fmtDate(d.start_at)}</div>
    </div>
    <div class="stat-row">
      <div class="stat"><div class="stat-num">${d.total_invited}</div><div class="stat-label">Invited</div></div>
      <div class="stat"><div class="stat-num" style="color:#1e7e34">${d.attendee_count}</div><div class="stat-label">Going</div></div>
      <div class="stat"><div class="stat-num" style="color:#d93025">${d.absentee_count}</div><div class="stat-label">Not Going</div></div>
      <div class="stat"><div class="stat-num" style="color:#f59c00">${d.maybe_count}</div><div class="stat-label">Maybe</div></div>
      <div class="stat"><div class="stat-num" style="color:#aaa">${d.not_responded.length}</div><div class="stat-label">No Response</div></div>
    </div>
    ${d.not_responded.length ? `
      <div><strong>No response (${d.not_responded.length}):</strong>
        <div class="names-list">${notNames || '—'}</div>
      </div>` : ''}
    ${d.responded.length ? `
      <div style="margin-top:8px"><strong>Responded (${d.responded.length}):</strong>
        <div class="names-list">${respondedNames}</div>
      </div>` : ''}
  `);
}

// ---- Sync Group ----

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
  const notify = true;
  const resultsEl = document.getElementById('sync-results');
  const applyBtn = document.getElementById('sync-apply');

  hide(applyBtn);
  setHtml(resultsEl, '<p class="msg">Applying changes…</p>');
  try {
    const result = await send({ type: 'sync_group_apply', band_no: currentBandNo, calendar_id, group_id, days, me_user_no: currentMeUserNo, notify });
    setHtml(resultsEl, `<p class="ok">Done! Updated ${result.applied_count} event(s).</p>`);
    syncDryRunResult = null;
  } catch (err) {
    setHtml(resultsEl, `<p class="err">${escHtml(err.message)}</p>`);
    show(applyBtn);
  }
});

// ---- Helpers ----

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
