'use strict';

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp?.ok) return reject(new Error(resp?.error || 'No response'));
      resolve(resp.result);
    });
  });
}

chrome.storage.sync.get({
  default_band: '', default_calendar: '', default_group: '',
  week_days: 7, sync_days: 120,
}, settings => {
  document.getElementById('opt-band').value = settings.default_band || '';
  document.getElementById('opt-week-days').value = settings.week_days;
  document.getElementById('opt-sync-days').value = settings.sync_days;
  if (settings.default_band)
    loadDropdowns(settings.default_band, settings.default_calendar, settings.default_group);
});

document.getElementById('load-dropdowns').addEventListener('click', () => {
  const band_no = document.getElementById('opt-band').value;
  if (!band_no) { alert('Enter a band number first.'); return; }
  loadDropdowns(band_no, '', '');
});

async function loadDropdowns(band_no, defaultCal, defaultGroup) {
  const calSel = document.getElementById('opt-calendar');
  const grpSel = document.getElementById('opt-group');
  calSel.innerHTML = '<option>Loading…</option>';
  grpSel.innerHTML = '<option>Loading…</option>';
  try {
    const [calData, grpData] = await Promise.all([
      send({ type: 'get_calendars', band_no: Number(band_no) }),
      send({ type: 'get_member_groups', band_no: Number(band_no) }),
    ]);
    const cals = calData.internal_calendars || calData.calendars || calData.items || [];
    calSel.innerHTML = cals.map(c => {
      const id = c.calendar_id ?? '';
      const name = c.name || (c.is_default ? 'Default' : `Calendar ${id}`);
      return `<option value="${id}"${String(id) === String(defaultCal) ? ' selected' : ''}>${name}</option>`;
    }).join('') || '<option value="">No calendars found</option>';
    const groups = grpData.items || [];
    grpSel.innerHTML = groups.map(g =>
      `<option value="${g.member_group_id}"${String(g.member_group_id) === String(defaultGroup) ? ' selected' : ''}>${g.name} (${g.member_count})</option>`
    ).join('') || '<option value="">No groups found</option>';
  } catch (err) {
    calSel.innerHTML = `<option value="">Error: ${err.message}</option>`;
    grpSel.innerHTML = `<option value="">Error: ${err.message}</option>`;
  }
}

document.getElementById('save-btn').addEventListener('click', () => {
  chrome.storage.sync.set({
    default_band:     document.getElementById('opt-band').value,
    default_calendar: document.getElementById('opt-calendar').value,
    default_group:    document.getElementById('opt-group').value,
    week_days:  Number(document.getElementById('opt-week-days').value) || 7,
    sync_days:  Number(document.getElementById('opt-sync-days').value) || 120,
  }, () => {
    const status = document.getElementById('status');
    status.textContent = 'Saved!';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
});
