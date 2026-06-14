// src/constants.ts
var DEFAULT_API_BASE = "https://api-usw.band.us";
var DEFAULT_AKEY = "bbc59b0b5f7a1c6efe950f6236ccda35";
var BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0";
var DEFAULT_TIME_ZONE_ID = "America/Los_Angeles";
var DEFAULT_TIME_ZONE_OFFSET_MS = -252e5;
var DEFAULT_JITTER_MS = [300, 900];
var COOKIE_INSTRUCTIONS = `BAND session is missing or expired. To grab a fresh one:

  1. Open  https://www.band.us/   (log in if needed)
  2. DevTools \u2192 Application \u2192 Cookies \u2192 https://www.band.us
  3. Copy the VALUES of these two cookies:
       * band_session
       * secretKey     (HttpOnly, not in document.cookie \u2014 grab it from this panel)
  4. Paste when prompted as:   band_session=<value>; secretKey=<value>

     Quotes around secretKey's value are fine \u2014 they'll be stripped. Including the
     other cookies (BBC, di, language, \u2026) is optional but helps traffic look
     browser-native.`;

// src/cookies.ts
function parseCookieHeader(input) {
  const trimmed = input.trim().replace(/^['"]+|['"]+$/g, "");
  if (!trimmed.includes("=")) {
    return trimmed ? { band_session: trimmed } : {};
  }
  const jar = {};
  for (const part of trimmed.split(";")) {
    const segment = part.trim();
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const name = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (name) jar[name] = value;
  }
  return jar;
}
function serializeCookieHeader(jar) {
  return Object.entries(jar).filter(([name]) => name !== "secretKey").map(([name, value]) => `${name}=${value}`).join("; ");
}
function mergeSetCookies(jar, setCookies) {
  let changed = false;
  for (const raw of setCookies) {
    const firstPair = raw.split(";", 1)[0] ?? "";
    const eq = firstPair.indexOf("=");
    if (eq === -1) continue;
    const name = firstPair.slice(0, eq).trim();
    const value = firstPair.slice(eq + 1).trim();
    if (name && jar[name] !== value) {
      jar[name] = value;
      changed = true;
    }
  }
  return changed;
}
function extractSecret(jar) {
  const raw = jar.secretKey;
  return raw === void 0 ? void 0 : raw.replace(/^"+|"+$/g, "");
}

// src/crypto.ts
var encoder = new TextEncoder();
function extractPath(url) {
  const noScheme = url.replace(/^.*?:\/\//, "");
  const path = noScheme.replace(/^[^/]+/, "");
  return path.replaceAll("'", "%27");
}
function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function importHmacKey(secret, crypto = globalThis.crypto) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
async function signPath(key, url, crypto = globalThis.crypto) {
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(extractPath(url)));
  return bytesToBase64(new Uint8Array(mac));
}

// src/errors.ts
var AuthError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
};
var BandApiError = class extends Error {
  resultCode;
  response;
  constructor(message, resultCode, response) {
    super(message);
    this.name = "BandApiError";
    this.resultCode = resultCode;
    this.response = response;
  }
};

// src/store.ts
var MemoryCookieStore = class {
  jar;
  constructor(jar = {}) {
    this.jar = { ...jar };
  }
  async load() {
    return { ...this.jar };
  }
  async save(jar) {
    this.jar = { ...jar };
  }
};

// src/client.ts
var AUTH_HINTS = ["auth", "login", "session", "token", "unauth"];
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function readSetCookies(headers) {
  const getter = headers.getSetCookie;
  return typeof getter === "function" ? getter.call(headers) : [];
}
var BandClient = class _BandClient {
  cfg;
  hmacKey;
  jar;
  lastCallAt = 0;
  warmed = false;
  referer = "https://www.band.us/";
  constructor(cfg, hmacKey, jar) {
    this.cfg = cfg;
    this.hmacKey = hmacKey;
    this.jar = jar;
  }
  static async create(options = {}) {
    const store = options.store ?? new MemoryCookieStore();
    const jar = await store.load();
    const seed = typeof options.cookies === "string" ? parseCookieHeader(options.cookies) : options.cookies;
    Object.assign(jar, seed ?? {});
    const sendCookieHeader = options.sendCookieHeader ?? true;
    if (sendCookieHeader && !jar.band_session) {
      throw new AuthError("no band_session on file");
    }
    const secret = extractSecret(jar);
    if (!secret) {
      throw new AuthError(
        "no secretKey cookie on file \u2014 it's HttpOnly so `copy(document.cookie)` won't grab it. Copy it from DevTools \u2192 Application \u2192 Cookies."
      );
    }
    const crypto = options.crypto ?? globalThis.crypto;
    const hmacKey = await importHmacKey(secret, crypto);
    const cfg = {
      store,
      // Bind the default global fetch to the global scope. Calling it detached
      // (as `this.cfg.fetchImpl(...)`) throws "Illegal invocation" in browsers and
      // service workers, where fetch requires its `this` to be the global object.
      fetchImpl: options.fetch ?? globalThis.fetch.bind(globalThis),
      crypto,
      apiBase: options.apiBase ?? DEFAULT_API_BASE,
      akey: options.akey ?? DEFAULT_AKEY,
      timeZoneId: options.timeZoneId ?? DEFAULT_TIME_ZONE_ID,
      timeZoneOffsetMs: options.timeZoneOffsetMs ?? DEFAULT_TIME_ZONE_OFFSET_MS,
      jitterMs: options.jitterMs === void 0 ? DEFAULT_JITTER_MS : options.jitterMs,
      warmUp: options.warmUp ?? true,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? defaultSleep,
      sendCookieHeader,
      credentials: options.credentials
    };
    await store.save(jar);
    return new _BandClient(cfg, hmacKey, jar);
  }
  /** Names of the cookies currently in the jar (no values). */
  cookieNames() {
    return Object.keys(this.jar);
  }
  // ---- pacing / warm-up ----
  async jitter() {
    if (!this.cfg.jitterMs || this.lastCallAt === 0) return;
    const [min, max] = this.cfg.jitterMs;
    const elapsed = this.cfg.now() - this.lastCallAt;
    const target = min + Math.random() * (max - min);
    if (elapsed < target) await this.cfg.sleep(target - elapsed);
  }
  /** Mimic a calendar-page visit before the first write. Best-effort. */
  async warmUp(bandNo) {
    if (this.warmed || !this.cfg.warmUp) return;
    this.warmed = true;
    try {
      await this.call("GET", "/v2.0.0/touch_band_access", { params: { band_no: bandNo } });
      await this.call("GET", "/v2.0.0/get_calendars", { params: { band_no: bandNo } });
    } catch {
    }
  }
  // ---- core call ----
  appHeaders() {
    return {
      language: "en",
      "device-time-zone-id": this.cfg.timeZoneId,
      "device-time-zone-ms-offset": String(this.cfg.timeZoneOffsetMs),
      akey: this.cfg.akey,
      origin: "https://www.band.us",
      referer: this.referer,
      "user-agent": BROWSER_UA
    };
  }
  async call(method, path, opts = {}) {
    await this.jitter();
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.params ?? {})) params.set(key, String(value));
    params.set("ts", String(this.cfg.now()));
    const url = `${this.cfg.apiBase}${path}?${params.toString()}`;
    const headers = {
      ...this.appHeaders(),
      md: await signPath(this.hmacKey, url, this.cfg.crypto)
    };
    if (this.cfg.sendCookieHeader) {
      headers.cookie = serializeCookieHeader(this.jar);
    }
    const init = { method, headers };
    if (this.cfg.credentials) init.credentials = this.cfg.credentials;
    if (method === "POST") {
      headers["content-type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      const form = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.body ?? {})) form.set(key, String(value));
      init.body = form.toString();
    }
    const res = await this.cfg.fetchImpl(url, init);
    this.lastCallAt = this.cfg.now();
    if (mergeSetCookies(this.jar, readSetCookies(res.headers))) {
      await this.cfg.store.save(this.jar);
    }
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`HTTP ${res.status} on ${path}`);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new BandApiError(`HTTP ${res.status} on ${path}: ${body}`);
    }
    const json = await res.json();
    if (json.result_code !== 1) {
      const blob = JSON.stringify(json).toLowerCase();
      if (AUTH_HINTS.some((hint) => blob.includes(hint))) {
        throw new AuthError(`API auth error: ${JSON.stringify(json)}`);
      }
      throw new BandApiError(`API error (result_code=${json.result_code})`, json.result_code, json);
    }
    return json.result_data;
  }
  // ---- high-level ----
  getCalendars(bandNo) {
    return this.call("GET", "/v2.0.0/get_calendars", {
      params: { band_no: bandNo, calendar_types: "internal" }
    });
  }
  getMembers(bandNo) {
    return this.call("GET", "/v2.0.0/get_members_of_band_with_filter", {
      params: { band_no: bandNo, filter: "add_schedule_sharer" }
    });
  }
  getMemberGroups(bandNo) {
    return this.call("GET", "/v2.1.0/get_member_groups", { params: { band_no: bandNo } });
  }
  getGroupMembers(bandNo, groupId) {
    return this.call("GET", "/v2.0.0/get_members_of_band_with_filter", {
      params: { band_no: bandNo, filter: "member_group", param1: groupId }
    });
  }
  getSchedule(bandNo, scheduleId) {
    return this.call("GET", "/v1.6.0/get_schedule", {
      params: { band_no: bandNo, schedule_id: scheduleId, for_schedule_detail: "true" }
    });
  }
  /**
   * Fetch schedules in a `[startYmd, endYmd]` window, following `paging.next_params`
   * to aggregate every page (BAND paginates large windows). `maxPages` is a safety cap.
   */
  async getSchedules(bandNo, startYmd, endYmd, opts = {}) {
    const calendars = opts.calendars ?? [{ is_default: true }];
    const maxPages = opts.maxPages ?? 50;
    const baseParams = {
      band_no: bandNo,
      start_at: startYmd,
      future_end_at: endYmd,
      calendars: JSON.stringify(calendars)
    };
    const items = [];
    let extra = {};
    let lastPaging;
    for (let page = 0; page < maxPages; page++) {
      const data = await this.call("GET", "/v1.6.0/get_schedules", {
        params: { ...baseParams, ...extra }
      });
      items.push(...data.items ?? []);
      lastPaging = data.paging;
      const next = data.paging?.next_params;
      if (!next) break;
      extra = pagingToParams(next);
    }
    return { items, paging: lastPaging };
  }
  async createSchedule(bandNo, schedule, opts = {}) {
    this.referer = `https://www.band.us/band/${bandNo}/calendar`;
    await this.warmUp(bandNo);
    return this.call("POST", "/v2.0.0/create_schedule", {
      body: {
        band_no: bandNo,
        schedule: JSON.stringify(schedule),
        announceable: String(opts.announceable ?? false),
        purpose: "create"
      }
    });
  }
  async updateSchedule(bandNo, scheduleId, schedule, opts = {}) {
    this.referer = `https://www.band.us/band/${bandNo}/calendar`;
    await this.warmUp(bandNo);
    return this.call("POST", "/v2.0.3/update_schedule", {
      body: {
        band_no: bandNo,
        schedule_id: scheduleId,
        schedule: JSON.stringify(schedule),
        notify_to_members: String(opts.notify ?? false),
        recurring_edit_type: opts.recurringEditType ?? "ALL"
      }
    });
  }
  /**
   * Delete a schedule. For a recurring series, `repeatEditType` controls scope
   * (`ALL` removes every occurrence); it's harmless on a one-off event. Note BAND
   * spells this param `repeat_edit_type` here, unlike `update_schedule`.
   */
  deleteSchedule(bandNo, scheduleId, opts = {}) {
    this.referer = `https://www.band.us/band/${bandNo}/calendar`;
    return this.call("GET", "/v1/schedule/delete_schedule", {
      params: {
        band_no: bandNo,
        schedule_id: scheduleId,
        repeat_edit_type: opts.repeatEditType ?? "ALL",
        notify_to_members: String(opts.notify ?? false)
      }
    });
  }
  getMyBandSchedules(bandNo) {
    return this.call("GET", "/v2.0.0/get_my_band_schedules", { params: { band_no: bandNo } });
  }
  /** Resolve the current user's `{ user_no, name }` from their own schedules, or null. */
  async getMe(bandNo) {
    const data = await this.getMyBandSchedules(bandNo);
    const owner = (data.items ?? data.schedules ?? [])[0]?.owner;
    return owner?.user_no ? { user_no: owner.user_no, name: owner.name ?? "" } : null;
  }
  /** Set a user's RSVP on a schedule (defaults to the given user). */
  setRsvp(bandNo, scheduleId, state, userNo) {
    this.referer = `https://www.band.us/band/${bandNo}/calendar`;
    return this.call("POST", "/v2.0.0/set_schedule_rsvp_states", {
      body: {
        band_no: bandNo,
        schedule_id: scheduleId,
        target_users: JSON.stringify([{ user_no: userNo }]),
        rsvp_state: state
      }
    });
  }
};
function pagingToParams(next) {
  if (typeof next === "string") {
    return Object.fromEntries(new URLSearchParams(next));
  }
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    if (value != null) out[key] = String(value);
  }
  return out;
}

// src/schedule.ts
var WRITABLE_SCHEDULE_FIELDS = /* @__PURE__ */ new Set([
  "name",
  "description",
  "calendar",
  "start_at",
  "end_at",
  "is_all_day",
  "is_lunar",
  "is_secret",
  "secret_sharers",
  "schedule_time_zone_id",
  "photos",
  "files",
  "dropbox_files",
  "external_files",
  "alarms",
  "rsvp",
  "is_local_meetup",
  "location"
]);
var WRITABLE_RSVP_FIELDS = /* @__PURE__ */ new Set([
  "is_child_member_addible",
  "custom_states",
  "rsvp_visible_qualification",
  "recurring_rsvp_end_offset",
  "is_maybe_enabled"
]);
var EMPTY_LIST_FIELDS = ["photos", "files", "dropbox_files", "external_files"];
function stripForCreate(src) {
  const out = {};
  for (const [key, value] of Object.entries(src)) {
    if (WRITABLE_SCHEDULE_FIELDS.has(key)) out[key] = value;
  }
  for (const field of EMPTY_LIST_FIELDS) {
    if (out[field] === void 0) out[field] = [];
  }
  const cal = out.calendar;
  if (cal && typeof cal === "object") {
    const ref = {
      calendar_id: cal.calendar_id,
      is_default: Boolean(cal.is_default)
    };
    out.calendar = ref;
  }
  const rsvp = out.rsvp;
  if (rsvp && typeof rsvp === "object") {
    const cleaned = {};
    for (const [key, value] of Object.entries(rsvp)) {
      if (WRITABLE_RSVP_FIELDS.has(key)) cleaned[key] = value;
    }
    if (cleaned.recurring_rsvp_end_offset === void 0) cleaned.recurring_rsvp_end_offset = null;
    out.rsvp = cleaned;
  }
  if (Array.isArray(out.secret_sharers)) {
    out.secret_sharers = normalizeSharers(out.secret_sharers);
  }
  return out;
}
function normalizeSharers(sharers) {
  const out = [];
  for (const s of sharers) {
    const userNo = s?.user_no;
    if (typeof userNo === "number") out.push({ user_no: userNo });
  }
  return out;
}
function applySharerFlags(schedule, opts) {
  const me = opts.me ?? null;
  let touched = false;
  if (opts.groupUserNos) {
    schedule.secret_sharers = opts.groupUserNos.filter((u) => u !== me).map((u) => ({ user_no: u }));
    touched = true;
  }
  const sharers = normalizeSharers(schedule.secret_sharers ?? []);
  const present = new Set(sharers.map((s) => s.user_no));
  for (const u of opts.addUserNos ?? []) {
    if (u === me || present.has(u)) continue;
    sharers.push({ user_no: u });
    present.add(u);
    touched = true;
  }
  const remove = new Set(opts.removeUserNos ?? []);
  let result = sharers;
  if (remove.size > 0) {
    result = sharers.filter((s) => !remove.has(s.user_no));
    touched = true;
  }
  if (touched) {
    schedule.secret_sharers = result;
    schedule.is_secret = true;
  }
}
function parseUserList(input) {
  if (!input) return [];
  const out = [];
  for (const piece of input.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (!Number.isInteger(n)) throw new RangeError(`not a user_no: ${trimmed}`);
    out.push(n);
  }
  return out;
}

// src/format.ts
function yyyymmdd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}
function dateWindow(start, end, days, today = /* @__PURE__ */ new Date()) {
  return {
    start: start ?? yyyymmdd(today),
    end: end ?? yyyymmdd(new Date(today.getTime() + days * 864e5))
  };
}
function parseIso(raw) {
  if (!raw) return null;
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}
function fmtLocal(date) {
  const day = date.toLocaleDateString("en-US", { weekday: "long" });
  const md = `${date.getMonth() + 1}/${date.getDate()}`;
  const hour = date.getHours() % 12 || 12;
  const ampm = date.getHours() < 12 ? "am" : "pm";
  const minutes = date.getMinutes();
  const time = minutes === 0 ? `${hour}${ampm}` : `${hour}:${String(minutes).padStart(2, "0")}${ampm}`;
  return `${day} ${md} @ ${time}`;
}
function scheduleUrl(ev) {
  const sid = encodeURIComponent(ev.schedule_id ?? "");
  return `https://band.us/band/${ev.band_no ?? ""}/schedule/${sid}`;
}

// src/rsvp.ts
function rsvpSummary(schedule) {
  const r = schedule.rsvp ?? {};
  const going = r.attendee_list ?? [];
  const notGoing = r.absentee_list ?? [];
  const maybe = r.maybe_list ?? [];
  const pending = r.pending_attendee_list ?? [];
  const respondedNames = new Set(
    [...going, ...notGoing, ...maybe, ...pending].map((m) => m.name).filter(Boolean)
  );
  const invited = (schedule.secret_sharers ?? []).filter((s) => s.user_no);
  const notResponded = invited.filter((s) => s.name && !respondedNames.has(s.name)).map((s) => ({ user_no: s.user_no, name: s.name }));
  return {
    going,
    notGoing,
    maybe,
    pending,
    notResponded,
    counts: {
      going: r.attendee_count ?? going.length,
      notGoing: r.absentee_count ?? notGoing.length,
      maybe: r.maybe_count ?? maybe.length,
      invited: invited.length
    }
  };
}
export {
  AuthError,
  BandApiError,
  BandClient,
  COOKIE_INSTRUCTIONS,
  DEFAULT_AKEY,
  DEFAULT_API_BASE,
  MemoryCookieStore,
  applySharerFlags,
  dateWindow,
  extractSecret,
  fmtLocal,
  mergeSetCookies,
  normalizeSharers,
  parseCookieHeader,
  parseIso,
  parseUserList,
  rsvpSummary,
  scheduleUrl,
  serializeCookieHeader,
  stripForCreate,
  yyyymmdd
};
