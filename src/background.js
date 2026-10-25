import * as bandstand from "bandstand/browser";
import { cacheKey, createCache } from "./cache.js";

const { BandClient, isJwtSession, stripForCreate } = bandstand;

// Independent reads run concurrently (per-event details 3 at a time) — but only
// when the bundled bandstand has its pacing gate (shipped alongside mapLimit),
// which still spaces request starts. An older client would let concurrent calls
// go out unpaced, so fall back to one-at-a-time there.
const DETAIL_CONCURRENCY = 3;
const hasPacer = typeof bandstand.mapLimit === "function";

async function mapLimit(items, fn) {
  if (hasPacer) return bandstand.mapLimit(items, DETAIL_CONCURRENCY, fn);
  const out = [];
  for (const [i, item] of items.entries()) out.push(await fn(item, i));
  return out;
}

async function both(a, b) {
  return hasPacer ? Promise.all([a(), b()]) : [await a(), await b()];
}

// Calendars, member groups and who-am-I barely change: cache them (1h TTL,
// background refresh after 10 min) so the popup and content script open instantly.
const metaCache = createCache({ storage: chrome.storage.local });

// Mark load-unpacked dev builds with a "DEV" toolbar badge so they're easy to
// tell apart from a Web Store install. installType is "development" for unpacked
// extensions and "normal" for Store installs. getSelf needs no permission.
Promise.resolve(chrome.management?.getSelf?.())
  .then((self) => {
    if (self?.installType !== "development") return;
    chrome.action.setBadgeText({ text: "DEV" });
    chrome.action.setBadgeBackgroundColor({ color: "#e8392c" });
    chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
  })
  .catch(() => {});

async function readSession() {
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
  return { secretKey: sk.value.replace(/"/g, ""), session: session.value };
}

const isBandCookie = (c) => c.domain === "band.us" || c.domain.endsWith(".band.us");

/**
 * The page `bandstand login` opens: http://127.0.0.1:<port>/#pair=<nonce>. Returns
 * the listener's origin and the one-time nonce (null if the fragment is missing,
 * e.g. the URL was retyped — the CLI then asks for confirmation), or null for any
 * other URL.
 */
export function parsePairUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/") {
    return null;
  }
  const nonce = /^#pair=([0-9a-f]{32})$/.exec(url.hash)?.[1] ?? null;
  return { origin: url.origin, nonce };
}

/**
 * Only the extension's own pages (the popup) may trigger a hand-off — never a
 * content script, which runs inside band.us pages.
 */
function isExtensionPage(sender) {
  // Content scripts report the web page's URL, so an extension URL means one of ours.
  return sender?.id === chrome.runtime.id && String(sender.url).startsWith(chrome.runtime.getURL(""));
}

async function pairTarget(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return parsePairUrl(tab?.url ?? "");
}

/**
 * Hand this browser's BAND session to `bandstand login`, which is listening on the
 * tab's 127.0.0.1 origin. The tab URL is read here, not taken from the popup.
 */
async function sendToCli(tabId) {
  const target = await pairTarget(tabId);
  if (!target) throw new Error("Open the page `bandstand login` opened, then try again.");
  const [bsAll, skAll] = await Promise.all([
    chrome.cookies.getAll({ name: "band_session" }),
    chrome.cookies.getAll({ name: "secretKey" }),
  ]);
  const bs = bsAll.find(isBandCookie);
  const sk = skAll.find(isBandCookie);
  if (!bs) throw new Error("Not logged in — visit band.us first.");
  if (!sk) throw new Error("secretKey cookie missing — visit band.us first.");
  let res;
  try {
    res = await fetch(`${target.origin}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        band_session: bs.value,
        secretKey: sk.value.replace(/"/g, ""),
        nonce: target.nonce ?? undefined,
        via: "extension",
      }),
    });
  } catch {
    throw new Error("bandstand isn't listening — is `bandstand login` still running?");
  }
  if (!res.ok) throw new Error(`bandstand replied ${res.status}`);
  return { trusted: Boolean(target.nonce) };
}

async function readSecretKey() {
  return (await readSession()).secretKey;
}

let clientPromise = null;
let clientSecretKey = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { secretKey, session } = await readSession();
      clientSecretKey = secretKey;
      // JWT sessions sign with the base64url-decoded secretKey; tell bandstand which
      // kind this is, since band_session never enters its jar in browser mode.
      return BandClient.create({
        cookies: { secretKey },
        sendCookieHeader: false,
        credentials: "include",
        jwtSession: isJwtSession({ band_session: session }),
      });
    })().catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// A new secretKey means a new login (possibly another account): drop the client
// and everything cached under the old identity.
chrome.cookies.onChanged?.addListener(({ cookie, removed, cause }) => {
  if (cookie.name !== "secretKey" || !cookie.domain.includes("band.us")) return;
  if (removed && cause === "overwrite") return; // the matching add follows
  if (!removed && clientSecretKey !== null && cookie.value.replace(/"/g, "") === clientSecretKey) return;
  clientPromise = null;
  clientSecretKey = null;
  invalidateCaches().catch(() => {});
});

async function invalidateCaches(band_no = null) {
  await metaCache.invalidate(band_no);
  await chrome.storage.session?.remove?.(["week_cache", "rsvp_status_cache"]);
}

async function getCalendars(band_no, fresh = false) {
  return metaCache.get(
    cacheKey("calendars", band_no),
    async () => (await getClient()).getCalendars(band_no),
    { fresh },
  );
}
async function getMemberGroups(band_no, fresh = false) {
  return metaCache.get(
    cacheKey("groups", band_no),
    async () => (await getClient()).getMemberGroups(band_no),
    { fresh },
  );
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
async function createSchedule(band_no, schedule, announceable = false) {
  return (await getClient()).createSchedule(band_no, schedule, { announceable });
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
  // Roster and event list are independent — fetch them together.
  const [groupData, data] = await both(
    () => getGroupMembers(band_no, group_id),
    () => getSchedules(band_no, today(), addDays(days), [{ is_default: false, calendar_id }]),
  );
  const groupMembers = {};
  for (const m of groupData.members || groupData.items || []) {
    if (m.user_no && m.user_no !== me_user_no) groupMembers[m.user_no] = m.name || `User ${m.user_no}`;
  }
  const gids = new Set(Object.keys(groupMembers).map(Number));
  if (!gids.size) throw new Error(`Group ${group_id} has no members (or wrong ID).`);

  const seen = new Map();
  for (const ev of data.items || []) {
    const parts = (ev.schedule_id || "").split("/");
    if (parts.length >= 3) seen.set(parts[2], ev);
  }

  const fulls = await mapLimit([...seen.values()], (preview) => getSchedule(band_no, preview.schedule_id));
  const updates = [];
  for (const full of fulls) {
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

const AUTH_ERROR_RE = /auth|login|session|secretkey|not logged in/i;

// Only band admins can list member groups. Cache the verdict either way, except
// when the failure was auth (re-login should be able to flip it).
async function checkIsAdmin(band_no, fresh = false) {
  try {
    return await metaCache.get(
      cacheKey("admin", band_no),
      async () => {
        try {
          await getMemberGroups(band_no, fresh);
          return true;
        } catch (err) {
          if (AUTH_ERROR_RE.test(err.message)) throw err;
          return false;
        }
      },
      { fresh },
    );
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

// Display names are per band, so who-am-I is cached per band.
async function detectMe(band_no, fresh = false) {
  try {
    const me = await metaCache.get(
      cacheKey("me", band_no),
      async () => {
        const data = await getMyBandSchedules(band_no);
        const items = data.items || data.schedules || [];
        const user_no = items[0]?.owner?.user_no;
        if (!user_no) throw new Error("no schedules of mine on this band");
        return { user_no, name: items[0]?.owner?.name || "" };
      },
      { fresh },
    );
    // Kept for the content script, which reads me_user_no directly.
    await chrome.storage.local.set({ me_user_no: me.user_no, me_name: me.name });
    return me;
  } catch {}
  return null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
        return getCalendars(msg.band_no, msg.fresh);
      case "get_member_groups":
        return getMemberGroups(msg.band_no, msg.fresh);
      case "check_auth":
        return readSecretKey();
      case "pair_target":
      case "pair_send":
        if (!isExtensionPage(sender)) throw new Error("only available to the Band Tools popup");
        return msg.type === "pair_target" ? pairTarget(msg.tab_id) : sendToCli(msg.tab_id);
      case "check_admin":
        return checkIsAdmin(msg.band_no, msg.fresh);
      case "update_rsvp":
        return updateMyRsvp(msg.band_no, msg.schedule_id, msg.rsvp_type, msg.me_user_no);
      case "detect_me":
        return detectMe(msg.band_no, msg.fresh);
      case "invalidate_cache":
        await invalidateCaches(msg.band_no ?? null);
        return true;
      case "band_no_detected":
        chrome.storage.session.set({ detected_band_no: msg.value });
        return null;
      case "get_schedule":
        return getSchedule(msg.band_no, msg.schedule_id);
      case "create_schedule":
        return createSchedule(msg.band_no, msg.schedule, msg.announceable);
      case "copy_schedule": {
        const src = await getSchedule(msg.band_no, msg.source_schedule_id);
        const payload = stripForCreate(src.schedule || src);
        if (msg.overrides) Object.assign(payload, msg.overrides);
        // Ensure calendar has calendar_id — create_schedule requires it
        if (payload.calendar && payload.calendar.calendar_id == null && payload.calendar.is_default) {
          // Look up the default calendar id from the calendar list
          try {
            const cals = await getCalendars(msg.band_no);
            const list = cals?.internal_calendars || cals?.calendars || cals?.items || [];
            const def = list.find(c => c.is_default);
            if (def?.calendar_id != null) payload.calendar.calendar_id = def.calendar_id;
          } catch { /* fall through with whatever we have */ }
        }
        return createSchedule(msg.band_no, payload, msg.announceable);
      }
      case "copy_schedule_into": {
        const src = await getSchedule(msg.band_no, msg.source_schedule_id);
        const payload = stripForCreate(src.schedule || src);
        if (msg.overrides) Object.assign(payload, msg.overrides);
        if (payload.calendar && payload.calendar.calendar_id == null && payload.calendar.is_default) {
          try {
            const cals = await getCalendars(msg.band_no);
            const list = cals?.internal_calendars || cals?.calendars || cals?.items || [];
            const def = list.find(c => c.is_default);
            if (def?.calendar_id != null) payload.calendar.calendar_id = def.calendar_id;
          } catch {}
        }
        return updateSchedule(msg.band_no, msg.dest_schedule_id, payload, msg.announceable);
      }
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  };

  dispatch()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => {
      if (AUTH_ERROR_RE.test(err.message)) clientPromise = null;
      sendResponse({ ok: false, error: err.message });
    });
  return true;
});
