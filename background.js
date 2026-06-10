'use strict';

// All API calls happen here (background service worker) to bypass CORS.

const AKEY = 'bbc59b0b5f7a1c6efe950f6236ccda35';
const API_BASE = 'https://api-usw.band.us';

let warmed = false;

// ---- Auth / cookies ----

async function getSecretKey() {
  // band.us uses credentials:include to send session cookies automatically.
  // We only need secretKey to compute the per-request HMAC signature.
  // band_session was renamed SESSION at some point; check both.
  const [bsAll, sessionAll, skAll] = await Promise.all([
    chrome.cookies.getAll({ name: 'band_session' }),
    chrome.cookies.getAll({ name: 'SESSION' }),
    chrome.cookies.getAll({ name: 'secretKey' }),
  ]);
  const session = bsAll.find(c => c.domain.includes('band.us'))
               || sessionAll.find(c => c.domain.includes('band.us'));
  const sk = skAll.find(c => c.domain.includes('band.us'));
  if (!session) throw new Error('Not logged in — visit band.us first.');
  if (!sk) throw new Error('secretKey cookie missing — visit band.us first.');
  return sk.value.replace(/"/g, '');
}

// ---- HMAC signing ----

function extractPath(url) {
  return url.replace(/^.*?:\/\/[^/]+/, '').replace(/'/g, '%27');
}

async function computeMd(secret, url) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(extractPath(url)));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ---- Core call ----

async function call(method, path, params = {}, body = null) {
  const secretKey = await getSecretKey();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzOffsetMs = -new Date().getTimezoneOffset() * 60000;

  params.ts = Date.now();
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}?${qs}`;

  const headers = {
    'akey': AKEY,
    'language': 'en',
    'DEVICE-TIME-ZONE-ID': tz,
    'DEVICE-TIME-ZONE-MS-OFFSET': String(tzOffsetMs),
    'md': await computeMd(secretKey, url),
  };

  // credentials:'include' sends band.us cookies automatically.
  // 'Cookie' is a forbidden header — Chrome strips it even from extensions.
  const opts = { method, headers, credentials: 'include' };
  if (method === 'POST' && body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    opts.body = body;
  }

  const resp = await fetch(url, opts);
  if (resp.status === 401 || resp.status === 403)
    throw new Error(`Auth error (HTTP ${resp.status}) — re-visit band.us.`);
  if (!resp.ok)
    throw new Error(`HTTP ${resp.status} from ${path}`);

  const js = await resp.json();
  if (js.result_code !== 1) {
    const msg = JSON.stringify(js);
    if (/auth|login|session|token|unauth/i.test(msg))
      throw new Error(`API auth error — re-visit band.us.`);
    throw new Error(`API error: ${msg}`);
  }
  return js.result_data;
}

async function warmUp(band_no) {
  if (warmed) return;
  warmed = true;
  try {
    await call('GET', '/v2.0.0/touch_band_access', { band_no });
    await call('GET', '/v2.0.0/get_calendars', { band_no, calendar_types: 'internal' });
  } catch (_) {}
}

// ---- API ----

function getCalendars(band_no) {
  return call('GET', '/v2.0.0/get_calendars', { band_no, calendar_types: 'internal' });
}

function getMemberGroups(band_no) {
  return call('GET', '/v2.1.0/get_member_groups', { band_no });
}

function getGroupMembers(band_no, group_id) {
  return call('GET', '/v2.0.0/get_members_of_band_with_filter',
    { band_no, filter: 'member_group', param1: group_id });
}

function getSchedules(band_no, start_yyyymmdd, end_yyyymmdd, calendars) {
  return call('GET', '/v1.6.0/get_schedules', {
    band_no,
    start_at: start_yyyymmdd,
    future_end_at: end_yyyymmdd,
    calendars: JSON.stringify(calendars || [{ is_default: true }]),
  });
}

function getSchedule(band_no, schedule_id) {
  return call('GET', '/v1.6.0/get_schedule', { band_no, schedule_id, for_print: 'false', token: '' });
}

async function updateSchedule(band_no, schedule_id, schedule, notify = false) {
  await warmUp(band_no);
  const body = new URLSearchParams({
    band_no, schedule_id,
    schedule: JSON.stringify(schedule),
    notify_to_members: String(notify),
    recurring_edit_type: 'ALL',
  }).toString();
  return call('POST', '/v2.0.3/update_schedule', {}, body);
}

function getMyBandSchedules(band_no) {
  return call('GET', '/v2.0.0/get_my_band_schedules', { band_no });
}

// ---- Helpers ----

function yyyymmdd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
function today() { return yyyymmdd(new Date()); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return yyyymmdd(d); }

function fmtLocal(isoStr) {
  const d = new Date(isoStr);
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? 'am' : 'pm';
  const min = d.getMinutes();
  const time = min === 0 ? `${h}${ampm}` : `${h}:${String(min).padStart(2,'0')}${ampm}`;
  return `${day} ${d.getMonth()+1}/${d.getDate()} @ ${time}`;
}

function scheduleUrl(ev) {
  return `https://band.us/band/${ev.band_no}/schedule/${encodeURIComponent(ev.schedule_id)}`;
}

// Fields allowed in create/update payloads
const SCHEDULE_WRITABLE = new Set([
  'name','description','calendar','start_at','end_at','is_all_day','is_lunar',
  'is_secret','secret_sharers','schedule_time_zone_id','photos','files',
  'dropbox_files','external_files','alarms','rsvp','is_local_meetup','location',
]);
const RSVP_WRITABLE = new Set([
  'is_child_member_addible','custom_states','rsvp_visible_qualification',
  'recurring_rsvp_end_offset','is_maybe_enabled',
]);

function stripSource(src) {
  const out = {};
  for (const [k, v] of Object.entries(src))
    if (SCHEDULE_WRITABLE.has(k)) out[k] = v;
  for (const k of ['photos','files','dropbox_files','external_files'])
    out[k] = out[k] || [];
  if (out.calendar)
    out.calendar = { calendar_id: out.calendar.calendar_id, is_default: !!out.calendar.is_default };
  if (out.rsvp) {
    const r = {};
    for (const [k, v] of Object.entries(out.rsvp))
      if (RSVP_WRITABLE.has(k)) r[k] = v;
    r.recurring_rsvp_end_offset = r.recurring_rsvp_end_offset ?? null;
    out.rsvp = r;
  }
  if (out.secret_sharers)
    out.secret_sharers = out.secret_sharers.filter(s => s?.user_no).map(s => ({ user_no: s.user_no }));
  return out;
}

// ---- Features ----

async function bandWeek(band_no, days = 7, calendar_id = null, me_name = null) {
  const cals = calendar_id ? [{ is_default: false, calendar_id }] : [{ is_default: true }];
  const data = await getSchedules(band_no, today(), addDays(days), cals);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const STATE_MAP = { ATTENDANCE: 1, ABSENCE: 2, MAYBE: 3 };
  return (data.items || [])
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .filter(ev => { try { return new Date(ev.start_at) <= cutoff; } catch (_) { return false; } })
    .map(ev => {
      const r = ev.rsvp || null;
      const my_rsvp = r ? (STATE_MAP[r.viewer_rsvp_state] ?? null) : null;
      return {
        when:          fmtLocal(ev.start_at),
        name:          ev.name,
        url:           scheduleUrl(ev),
        start_at:      ev.start_at,
        schedule_id:   ev.schedule_id,
        band_no:       ev.band_no || band_no,
        rsvp_enabled:  r != null,
        maybe_enabled: r ? r.is_maybe_enabled !== false : false,
        my_rsvp,
      };
    });
}

async function rsvpStatus(band_no, schedule_id, me_name = null) {
  const data = await getSchedule(band_no, schedule_id);
  const sched = data.schedule || data;
  const rsvp = sched.rsvp || {};

  const going    = (rsvp.attendee_list         || []).map(u => u.name).filter(Boolean);
  const notGoing = (rsvp.absentee_list         || []).map(u => u.name).filter(Boolean);
  const maybe    = (rsvp.maybe_list            || []).map(u => u.name).filter(Boolean);
  const pending  = (rsvp.pending_attendee_list || []).map(u => u.name).filter(Boolean);

  const respondedNames = new Set([...going, ...notGoing, ...maybe, ...pending]);

  // secret_sharers is the full invite list for private events; may be absent for public ones
  const sharers = (sched.secret_sharers || []).filter(s => s.user_no);
  const notResponded = sharers.filter(s => s.name && !respondedNames.has(s.name));

  // Detect the current user's status by matching their stored name against the lists
  let my_rsvp = null;
  if (me_name) {
    if (going.includes(me_name))    my_rsvp = 1;
    else if (notGoing.includes(me_name)) my_rsvp = 2;
    else if (maybe.includes(me_name))    my_rsvp = 3;
  }

  return {
    event_name:    sched.name,
    start_at:      sched.start_at,
    total_invited: sharers.length,
    attendee_count:  rsvp.attendee_count || 0,
    absentee_count:  rsvp.absentee_count || 0,
    maybe_count:     rsvp.maybe_count    || 0,
    going,
    not_going: notGoing,
    maybe,
    not_responded: notResponded.map(s => ({ user_no: s.user_no, name: s.name })),
    my_rsvp,
  };
}

// Shared: build the group roster and event list needed by both dry-run and apply
async function syncGroupPlan(band_no, calendar_id, group_id, days, me_user_no) {
  const groupData = await getGroupMembers(band_no, group_id);
  const groupMembers = {};
  for (const m of (groupData.members || groupData.items || []))
    if (m.user_no && m.user_no !== me_user_no)
      groupMembers[m.user_no] = m.name || `User ${m.user_no}`;

  const gids = new Set(Object.keys(groupMembers).map(Number));
  if (!gids.size) throw new Error(`Group ${group_id} has no members (or wrong ID).`);

  const cals = [{ is_default: false, calendar_id }];
  const data = await getSchedules(band_no, today(), addDays(days), cals);

  // Dedupe recurring events by schedule_no (3rd segment of schedule_id)
  const seen = new Map();
  for (const ev of (data.items || [])) {
    const parts = (ev.schedule_id || '').split('/');
    if (parts.length >= 3) seen.set(parts[2], ev);
  }

  const updates = [];
  for (const [, preview] of seen) {
    const full = await getSchedule(band_no, preview.schedule_id);
    const sched = full.schedule || full;
    if (!sched.is_secret) continue;
    const sharers = new Set((sched.secret_sharers || []).map(s => s.user_no).filter(Boolean));
    const missing = [...gids].filter(u => !sharers.has(u));
    if (!missing.length) continue;
    updates.push({ sched, sharers, missing, groupMembers });
  }

  return { gids, groupMembers, seen, updates };
}

async function syncGroupDryRun(band_no, calendar_id, group_id, days = 120, me_user_no = null) {
  const { gids, seen, updates, groupMembers } = await syncGroupPlan(band_no, calendar_id, group_id, days, me_user_no);
  return {
    group_size:     gids.size,
    events_checked: seen.size,
    updates_needed: updates.length,
    updates: updates.map(({ sched, missing, groupMembers: gm }) => ({
      schedule_id:   sched.schedule_id,
      name:          sched.name,
      start_at:      sched.start_at,
      missing_count: missing.length,
      missing_names: missing.map(u => gm[u] || `User ${u}`),
    })),
  };
}

async function syncGroupApply(band_no, calendar_id, group_id, days = 120, me_user_no = null, notify = false) {
  const { updates } = await syncGroupPlan(band_no, calendar_id, group_id, days, me_user_no);
  const applied = [];
  for (const { sched, sharers, missing } of updates) {
    const stripped = stripSource(sched);
    stripped.secret_sharers = [...new Set([...sharers, ...missing])].sort().map(u => ({ user_no: u }));
    stripped.is_secret = true;
    await updateSchedule(band_no, sched.schedule_id, stripped, notify);
    applied.push({ schedule_id: sched.schedule_id, name: sched.name, added: missing.length });
  }
  return { applied_count: applied.length, applied };
}

async function checkIsAdmin(band_no) {
  try {
    await getMemberGroups(band_no);
    return true;
  } catch (_) {
    return false;
  }
}

const NUM_TO_STATE = { 1: 'ATTENDANCE', 2: 'ABSENCE', 3: 'MAYBE' };

// rsvp_type: 1=going, 2=not going, 3=maybe
async function updateMyRsvp(band_no, schedule_id, rsvp_type, me_user_no) {
  const rsvp_state = NUM_TO_STATE[rsvp_type];
  if (!rsvp_state) throw new Error(`Unknown rsvp_type: ${rsvp_type}`);
  if (!me_user_no) throw new Error('User number unknown — try reopening the extension.');
  const body = new URLSearchParams({
    band_no: String(band_no),
    schedule_id,
    target_users: JSON.stringify([{ user_no: me_user_no }]),
    rsvp_state,
  }).toString();
  return call('POST', '/v2.0.0/set_schedule_rsvp_states', {}, body);
}

async function detectMe(band_no) {
  try {
    const data = await getMyBandSchedules(band_no);
    const items = data.items || data.schedules || [];
    const user_no = items[0]?.owner?.user_no;
    const name    = items[0]?.owner?.name || '';
    if (user_no) {
      await chrome.storage.local.set({ me_user_no: user_no, me_name: name });
      return { user_no, name };
    }
  } catch (_) {}
  return null;
}

// ---- Message handler ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const dispatch = async () => {
    switch (msg.type) {
      case 'band_week':        return bandWeek(msg.band_no, msg.days, msg.calendar_id, msg.me_name);
      case 'rsvp_status':      return rsvpStatus(msg.band_no, msg.schedule_id, msg.me_name);
      case 'sync_group_dry':   return syncGroupDryRun(msg.band_no, msg.calendar_id, msg.group_id, msg.days, msg.me_user_no);
      case 'sync_group_apply': return syncGroupApply(msg.band_no, msg.calendar_id, msg.group_id, msg.days, msg.me_user_no, msg.notify);
      case 'get_calendars':    return getCalendars(msg.band_no);
      case 'get_member_groups':return getMemberGroups(msg.band_no);
      case 'check_auth':       return getSecretKey();
      case 'check_admin':      return checkIsAdmin(msg.band_no);
      case 'update_rsvp':      return updateMyRsvp(msg.band_no, msg.schedule_id, msg.rsvp_type, msg.me_user_no);
      case 'detect_me':        return detectMe(msg.band_no);
      case 'band_no_detected':
        chrome.storage.session.set({ detected_band_no: msg.value });
        return null;
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  };

  dispatch()
    .then(result => sendResponse({ ok: true, result }))
    .catch(err   => sendResponse({ ok: false, error: err.message }));
  return true;
});
