import { BandClient, stripForCreate } from "bandstand/browser";

async function readSecretKey() {
  const [bsAll, sessionAll, skAll] = await Promise.all([
    chrome.cookies.getAll({ name: "band_session" }),
    chrome.cookies.getAll({ name: "SESSION" }),
    chrome.cookies.getAll({ name: "secretKey" }),
  ]);
  const session =
    bsAll.find((c) => c.domain.includes("band.us")) ||
    sessionAll.find((c) => c.domain.includes("band.us"));
  const sk = skAll.find((c) => c.domain.includes("band.us"));
  if (!session) throw new Error("Not logged in — visit band.us first.");
  if (!sk) throw new Error("secretKey cookie missing — visit band.us first.");
  return sk.value.replace(/"/g, "");
}

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const secretKey = await readSecretKey();
      return BandClient.create({ cookies: { secretKey }, sendCookieHeader: false, credentials: "include" });
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

async function getCalendars(band_no) {
  return (await getClient()).getCalendars(band_no);
}
async function getMemberGroups(band_no) {
  return (await getClient()).getMemberGroups(band_no);
}
async function getGroupMembers(band_no, group_id) {
  return (await getClient()).getGroupMembers(band_no, group_id);
}
async function getSchedules(band_no, start, end, calendars) {
  return (await getClient()).getSchedules(band_no, start, end, {
    calendars: calendars || [{ is_default: true }],
  });
}
async function getSchedule(band_no, schedule_id) {
  return (await getClient()).getSchedule(band_no, schedule_id);
}
async function updateSchedule(band_no, schedule_id, schedule, notify = false) {
  return (await getClient()).updateSchedule(band_no, schedule_id, schedule, { notify });
}
async function getMyBandSchedules(band_no) {
  return (await getClient()).getMyBandSchedules(band_no);
}

function yyyymmdd(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
function today() {
  return yyyymmdd(new Date());
}
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return yyyymmdd(d);
}

function fmtLocal(isoStr) {
  const d = new Date(isoStr);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const h = d.getHours() % 12 || 12;
  const ampm = d.getHours() < 12 ? "am" : "pm";
  const min = d.getMinutes();
  const time = min === 0 ? `${h}${ampm}` : `${h}:${String(min).padStart(2, "0")}${ampm}`;
  return `${day} ${d.getMonth() + 1}/${d.getDate()} @ ${time}`;
}

function scheduleUrl(ev) {
  return `https://band.us/band/${ev.band_no}/schedule/${encodeURIComponent(ev.schedule_id)}`;
}

async function bandWeek(band_no, days = 7, calendar_id = null) {
  const cals = calendar_id ? [{ is_default: false, calendar_id }] : [{ is_default: true }];
  const data = await getSchedules(band_no, today(), addDays(days), cals);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);
  const STATE_MAP = { ATTENDANCE: 1, ABSENCE: 2, MAYBE: 3 };
  return (data.items || [])
    .sort((a, b) => a.start_at.localeCompare(b.start_at))
    .filter((ev) => {
      try {
        return new Date(ev.start_at) <= cutoff;
      } catch {
        return false;
      }
    })
    .map((ev) => {
      const r = ev.rsvp || null;
      return {
        when: fmtLocal(ev.start_at),
        name: ev.name,
        url: scheduleUrl(ev),
        start_at: ev.start_at,
        schedule_id: ev.schedule_id,
        band_no: ev.band_no || band_no,
        rsvp_enabled: r != null,
        maybe_enabled: r ? r.is_maybe_enabled !== false : false,
        my_rsvp: r ? (STATE_MAP[r.viewer_rsvp_state] ?? null) : null,
      };
    });
}

async function rsvpStatus(band_no, schedule_id, me_name = null) {
  const data = await getSchedule(band_no, schedule_id);
  const sched = data.schedule || data;
  const rsvp = sched.rsvp || {};
  const going = (rsvp.attendee_list || []).map((u) => u.name).filter(Boolean);
  const notGoing = (rsvp.absentee_list || []).map((u) => u.name).filter(Boolean);
  const maybe = (rsvp.maybe_list || []).map((u) => u.name).filter(Boolean);
  const pending = (rsvp.pending_attendee_list || []).map((u) => u.name).filter(Boolean);
  const respondedNames = new Set([...going, ...notGoing, ...maybe, ...pending]);
  const sharers = (sched.secret_sharers || []).filter((s) => s.user_no);
  const notResponded = sharers.filter((s) => s.name && !respondedNames.has(s.name));

  let my_rsvp = null;
  if (me_name) {
    if (going.includes(me_name)) my_rsvp = 1;
    else if (notGoing.includes(me_name)) my_rsvp = 2;
    else if (maybe.includes(me_name)) my_rsvp = 3;
  }

  return {
    event_name: sched.name,
    start_at: sched.start_at,
    total_invited: sharers.length,
    attendee_count: rsvp.attendee_count || 0,
    absentee_count: rsvp.absentee_count || 0,
    maybe_count: rsvp.maybe_count || 0,
    going,
    not_going: notGoing,
    maybe,
    not_responded: notResponded.map((s) => ({ user_no: s.user_no, name: s.name })),
    my_rsvp,
  };
}

async function syncGroupPlan(band_no, calendar_id, group_id, days, me_user_no) {
  const groupData = await getGroupMembers(band_no, group_id);
  const groupMembers = {};
  for (const m of groupData.members || groupData.items || []) {
    if (m.user_no && m.user_no !== me_user_no) groupMembers[m.user_no] = m.name || `User ${m.user_no}`;
  }
  const gids = new Set(Object.keys(groupMembers).map(Number));
  if (!gids.size) throw new Error(`Group ${group_id} has no members (or wrong ID).`);

  const data = await getSchedules(band_no, today(), addDays(days), [{ is_default: false, calendar_id }]);
  const seen = new Map();
  for (const ev of data.items || []) {
    const parts = (ev.schedule_id || "").split("/");
    if (parts.length >= 3) seen.set(parts[2], ev);
  }

  const updates = [];
  for (const [, preview] of seen) {
    const full = await getSchedule(band_no, preview.schedule_id);
    const sched = full.schedule || full;
    if (!sched.is_secret) continue;
    const sharers = new Set((sched.secret_sharers || []).map((s) => s.user_no).filter(Boolean));
    const missing = [...gids].filter((u) => !sharers.has(u));
    if (!missing.length) continue;
    updates.push({ sched, sharers, missing });
  }
  return { gids, groupMembers, seen, updates };
}

async function syncGroupDryRun(band_no, calendar_id, group_id, days = 120, me_user_no = null) {
  const { gids, groupMembers, seen, updates } = await syncGroupPlan(band_no, calendar_id, group_id, days, me_user_no);
  return {
    group_size: gids.size,
    events_checked: seen.size,
    updates_needed: updates.length,
    updates: updates.map(({ sched, missing }) => ({
      schedule_id: sched.schedule_id,
      name: sched.name,
      start_at: sched.start_at,
      missing_count: missing.length,
      missing_names: missing.map((u) => groupMembers[u] || `User ${u}`),
    })),
  };
}

async function syncGroupApply(band_no, calendar_id, group_id, days = 120, me_user_no = null, notify = false) {
  const { updates } = await syncGroupPlan(band_no, calendar_id, group_id, days, me_user_no);
  const applied = [];
  for (const { sched, sharers, missing } of updates) {
    const stripped = stripForCreate(sched);
    stripped.secret_sharers = [...new Set([...sharers, ...missing])].sort().map((u) => ({ user_no: u }));
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
  } catch {
    return false;
  }
}

const NUM_TO_STATE = { 1: "ATTENDANCE", 2: "ABSENCE", 3: "MAYBE" };

async function updateMyRsvp(band_no, schedule_id, rsvp_type, me_user_no) {
  const rsvp_state = NUM_TO_STATE[rsvp_type];
  if (!rsvp_state) throw new Error(`Unknown rsvp_type: ${rsvp_type}`);
  if (!me_user_no) throw new Error("User number unknown — try reopening the extension.");
  return (await getClient()).setRsvp(band_no, schedule_id, rsvp_state, me_user_no);
}

async function detectMe(band_no) {
  try {
    const data = await getMyBandSchedules(band_no);
    const items = data.items || data.schedules || [];
    const user_no = items[0]?.owner?.user_no;
    const name = items[0]?.owner?.name || "";
    if (user_no) {
      await chrome.storage.local.set({ me_user_no: user_no, me_name: name });
      return { user_no, name };
    }
  } catch {}
  return null;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const dispatch = async () => {
    switch (msg.type) {
      case "band_week":
        return bandWeek(msg.band_no, msg.days, msg.calendar_id);
      case "rsvp_status":
        return rsvpStatus(msg.band_no, msg.schedule_id, msg.me_name);
      case "sync_group_dry":
        return syncGroupDryRun(msg.band_no, msg.calendar_id, msg.group_id, msg.days, msg.me_user_no);
      case "sync_group_apply":
        return syncGroupApply(msg.band_no, msg.calendar_id, msg.group_id, msg.days, msg.me_user_no, msg.notify);
      case "get_calendars":
        return getCalendars(msg.band_no);
      case "get_member_groups":
        return getMemberGroups(msg.band_no);
      case "check_auth":
        return readSecretKey();
      case "check_admin":
        return checkIsAdmin(msg.band_no);
      case "update_rsvp":
        return updateMyRsvp(msg.band_no, msg.schedule_id, msg.rsvp_type, msg.me_user_no);
      case "detect_me":
        return detectMe(msg.band_no);
      case "band_no_detected":
        chrome.storage.session.set({ detected_band_no: msg.value });
        return null;
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  };

  dispatch()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      if (/auth|login|session|secretkey|not logged in/i.test(err.message)) clientPromise = null;
      sendResponse({ ok: false, error: err.message });
    });
  return true;
});
