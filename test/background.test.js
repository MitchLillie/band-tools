import { beforeAll, describe, expect, it } from "vitest";
import sinonChrome from "sinon-chrome";

function jsonResponse(data) {
  return new Response(JSON.stringify({ result_code: 1, result_data: data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SCHEDULE = {
  schedule_id: "4/1/100/19700101",
  band_no: 1,
  name: "Event",
  start_at: "2026-06-20T18:00:00-07:00",
  is_secret: true,
  secret_sharers: [],
  rsvp: {
    attendee_list: [{ name: "Alice" }],
    absentee_list: [],
    maybe_list: [],
    pending_attendee_list: [],
    attendee_count: 1,
    absentee_count: 0,
    maybe_count: 0,
    viewer_rsvp_state: "ATTENDANCE",
    is_maybe_enabled: true,
  },
};

const fetchCounts = {};
function callsTo(name) {
  return fetchCounts[name] ?? 0;
}

function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) {
      if (key == null) return { ...data };
      const keys = typeof key === "string" ? [key] : Array.isArray(key) ? key : Object.keys(key);
      const out = {};
      for (const k of keys) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

let cookieListener;

const cliPosts = [];
let cliStatus = 200;

function fakeFetch(url, init) {
  if (String(url).startsWith("http://127.0.0.1")) {
    cliPosts.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve(new Response('{"ok":true}', { status: cliStatus }));
  }
  const u = String(url);
  const name = new URL(u).pathname.split("/").pop();
  fetchCounts[name] = (fetchCounts[name] ?? 0) + 1;
  const route = () => {
    if (u.includes("get_my_band_schedules")) return { items: [{ owner: { user_no: 7, name: "Me" } }] };
    if (u.includes("get_schedules")) return { items: [SCHEDULE], paging: { next_params: null } };
    if (u.includes("get_schedule")) return SCHEDULE;
    if (u.includes("get_calendars")) return { internal_calendars: [{ is_default: true, name: "Main" }] };
    if (u.includes("get_member_groups")) return { items: [{ member_group_id: 1, member_count: 1, name: "Group" }] };
    if (u.includes("get_members_of_band_with_filter")) return { members: [{ user_no: 5, name: "Bob" }] };
    if (u.includes("set_schedule_rsvp_states")) return { affected_rsvp_states: { ATTENDANCE: [{ user_no: 7 }] } };
    if (u.includes("update_schedule")) return { schedule: { schedule_id: SCHEDULE.schedule_id } };
    if (u.includes("touch_band_access")) return {};
    return {};
  };
  return Promise.resolve(jsonResponse(route()));
}

let send;
let parsePairUrl;

const NONCE = "0123456789abcdef0123456789abcdef";
const TABS = {
  1: { id: 1, url: `http://127.0.0.1:7238/#pair=${NONCE}` },
  2: { id: 2, url: "http://127.0.0.1:7238/" },
  3: { id: 3, url: "https://www.band.us/band/1" },
};
const POPUP = { id: "test-ext-id", url: "chrome-extension://test-ext-id/popup.html" };

beforeAll(async () => {
  globalThis.chrome = sinonChrome.default ?? sinonChrome;
  let listener;
  chrome.runtime.onMessage.addListener = (fn) => {
    listener = fn;
  };
  chrome.cookies = {
    onChanged: { addListener: (fn) => (cookieListener = fn) },
    getAll: async ({ name }) =>
      name === "secretKey"
        ? [{ domain: ".band.us", value: '"testsecret"' }]
        : name === "band_session"
          ? [{ domain: ".band.us", value: "sess" }]
          : [],
  };
  chrome.storage = { local: memoryArea(), session: memoryArea() };
  chrome.runtime.id = "test-ext-id";
  chrome.runtime.getURL.callsFake((path) => `chrome-extension://test-ext-id/${path}`);
  chrome.tabs.get.callsFake(async (id) => TABS[id]);
  globalThis.fetch = fakeFetch;

  ({ parsePairUrl } = await import("../src/background.js"));
  send = (msg, sender = {}) => new Promise((resolve) => listener(msg, sender, resolve));
});

describe("background.js message handlers (mocked chrome + fetch)", () => {
  it("check_auth returns the secret (quotes stripped)", async () => {
    const r = await send({ type: "check_auth" });
    expect(r).toEqual({ ok: true, result: "testsecret" });
  });

  it("get_calendars", async () => {
    const r = await send({ type: "get_calendars", band_no: 1 });
    expect(r.ok).toBe(true);
    expect(r.result.internal_calendars).toHaveLength(1);
  });

  it("get_member_groups", async () => {
    const r = await send({ type: "get_member_groups", band_no: 1 });
    expect(r.result.items[0].name).toBe("Group");
  });

  it("check_admin → true when groups load", async () => {
    const r = await send({ type: "check_admin", band_no: 1 });
    expect(r.result).toBe(true);
  });

  it("detect_me resolves owner user_no/name", async () => {
    const r = await send({ type: "detect_me", band_no: 1 });
    expect(r.result).toEqual({ user_no: 7, name: "Me" });
  });

  it("band_week maps events with my_rsvp + url", async () => {
    const r = await send({ type: "band_week", band_no: 1, days: 3650 });
    expect(r.ok).toBe(true);
    expect(r.result[0]).toMatchObject({
      name: "Event",
      schedule_id: SCHEDULE.schedule_id,
      my_rsvp: 1,
    });
    expect(r.result[0].url).toContain("/schedule/");
  });

  it("rsvp_status buckets attendees and detects my status", async () => {
    const r = await send({
      type: "rsvp_status",
      band_no: 1,
      schedule_id: SCHEDULE.schedule_id,
      me_name: "Alice",
    });
    expect(r.result.event_name).toBe("Event");
    expect(r.result.going).toContain("Alice");
    expect(r.result.my_rsvp).toBe(1);
  });

  it("update_rsvp posts a state", async () => {
    const r = await send({
      type: "update_rsvp",
      band_no: 1,
      schedule_id: SCHEDULE.schedule_id,
      rsvp_type: 1,
      me_user_no: 7,
    });
    expect(r.ok).toBe(true);
  });

  it("sync_group_dry finds the missing member", async () => {
    const r = await send({
      type: "sync_group_dry",
      band_no: 1,
      calendar_id: 2,
      group_id: 1,
      days: 3650,
      me_user_no: null,
    });
    expect(r.ok).toBe(true);
    expect(r.result.group_size).toBe(1);
    expect(r.result.updates_needed).toBe(1);
    expect(r.result.updates[0].missing_names).toContain("Bob");
  });

  it("sync_group_apply applies the update", async () => {
    const r = await send({
      type: "sync_group_apply",
      band_no: 1,
      calendar_id: 2,
      group_id: 1,
      days: 3650,
      me_user_no: null,
    });
    expect(r.ok).toBe(true);
    expect(r.result.applied_count).toBe(1);
  });

  it("caches calendars, groups, admin and me per band (one fetch each)", async () => {
    const before = {
      cal: callsTo("get_calendars"),
      grp: callsTo("get_member_groups"),
      me: callsTo("get_my_band_schedules"),
    };
    for (let i = 0; i < 3; i++) {
      await send({ type: "get_calendars", band_no: 1 });
      await send({ type: "get_member_groups", band_no: 1 });
      await send({ type: "check_admin", band_no: 1 });
      await send({ type: "detect_me", band_no: 1 });
    }
    // Band 1 was already cached by the earlier tests.
    expect(callsTo("get_calendars")).toBe(before.cal);
    expect(callsTo("get_member_groups")).toBe(before.grp);
    expect(callsTo("get_my_band_schedules")).toBe(before.me);
    expect(chrome.storage.local.data["cache:calendars:1"].data.internal_calendars).toHaveLength(1);

    // A different band is a different cache entry.
    await send({ type: "get_calendars", band_no: 2 });
    expect(callsTo("get_calendars")).toBe(before.cal + 1);
  });

  it("concurrent requests for the same uncached data share one fetch", async () => {
    const before = callsTo("get_calendars");
    await Promise.all([
      send({ type: "get_calendars", band_no: 3 }),
      send({ type: "get_calendars", band_no: 3 }),
    ]);
    expect(callsTo("get_calendars")).toBe(before + 1);
  });

  it("fresh:true bypasses the cache", async () => {
    const before = callsTo("get_calendars");
    await send({ type: "get_calendars", band_no: 1, fresh: true });
    expect(callsTo("get_calendars")).toBe(before + 1);
  });

  it("invalidate_cache drops one band's entries and the session week/rsvp caches", async () => {
    chrome.storage.session.data.week_cache = { ts: 1, items: [] };
    chrome.storage.session.data.rsvp_status_cache = { x: 1 };
    const r = await send({ type: "invalidate_cache", band_no: 1 });
    expect(r.ok).toBe(true);
    expect(chrome.storage.local.data["cache:calendars:1"]).toBeUndefined();
    expect(chrome.storage.local.data["cache:calendars:2"]).toBeDefined();
    expect(chrome.storage.session.data.week_cache).toBeUndefined();
    expect(chrome.storage.session.data.rsvp_status_cache).toBeUndefined();

    const before = callsTo("get_calendars");
    await send({ type: "get_calendars", band_no: 1 });
    expect(callsTo("get_calendars")).toBe(before + 1);
  });

  it("a new secretKey (new login) invalidates every cached entry", async () => {
    await send({ type: "get_calendars", band_no: 1 });
    // Same value re-set (overwrite) → keep the cache.
    cookieListener({ removed: true, cause: "overwrite", cookie: { name: "secretKey", domain: ".band.us", value: '"testsecret"' } });
    cookieListener({ removed: false, cause: "explicit", cookie: { name: "secretKey", domain: ".band.us", value: '"testsecret"' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(chrome.storage.local.data["cache:calendars:1"]).toBeDefined();
    // Different value → drop everything.
    cookieListener({ removed: false, cause: "explicit", cookie: { name: "secretKey", domain: ".band.us", value: '"other"' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(Object.keys(chrome.storage.local.data).filter((k) => k.startsWith("cache:"))).toEqual([]);
  });

  it("unknown message type → ok:false with an error", async () => {
    const r = await send({ type: "definitely_not_a_real_type" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown message type/i);
  });
});

describe("bandstand login hand-off (popup)", () => {
  it("parsePairUrl accepts only the page bandstand login opens", () => {
    expect(parsePairUrl(`http://127.0.0.1:7238/#pair=${NONCE}`)).toEqual({
      origin: "http://127.0.0.1:7238",
      nonce: NONCE,
    });
    expect(parsePairUrl("http://127.0.0.1:7238/")).toEqual({ origin: "http://127.0.0.1:7238", nonce: null });
    for (const bad of [
      "https://127.0.0.1:7238/",
      "http://localhost:7238/",
      "http://127.0.0.1/",
      "http://127.0.0.1:7238/evil",
      "http://127.0.0.1.evil.example:7238/",
      "https://www.band.us/",
      "not a url",
    ]) {
      expect(parsePairUrl(bad)).toBeNull();
    }
  });

  it("pair_target reports the listener for the CLI tab only", async () => {
    expect(await send({ type: "pair_target", tab_id: 1 }, POPUP)).toEqual({
      ok: true,
      result: { origin: "http://127.0.0.1:7238", nonce: NONCE },
    });
    expect(await send({ type: "pair_target", tab_id: 3 }, POPUP)).toEqual({ ok: true, result: null });
  });

  it("pair_send posts band_session + quote-stripped secretKey with the nonce", async () => {
    cliPosts.length = 0;
    const r = await send({ type: "pair_send", tab_id: 1 }, POPUP);
    expect(r).toEqual({ ok: true, result: { trusted: true } });
    expect(cliPosts).toEqual([
      {
        url: "http://127.0.0.1:7238/session",
        body: { band_session: "sess", secretKey: "testsecret", nonce: NONCE, via: "extension" },
      },
    ]);
  });

  it("pair_send without a nonce leaves confirmation to the CLI", async () => {
    cliPosts.length = 0;
    const r = await send({ type: "pair_send", tab_id: 2 }, POPUP);
    expect(r).toEqual({ ok: true, result: { trusted: false } });
    expect(cliPosts[0].body.nonce).toBeUndefined();
  });

  it("pair_send refuses a non-CLI tab and surfaces CLI errors", async () => {
    cliPosts.length = 0;
    expect((await send({ type: "pair_send", tab_id: 3 }, POPUP)).error).toMatch(/bandstand login/);
    expect(cliPosts).toHaveLength(0);
    cliStatus = 400;
    expect((await send({ type: "pair_send", tab_id: 1 }, POPUP)).error).toMatch(/replied 400/);
    cliStatus = 200;
  });

  it.each([
    ["no sender", {}],
    ["another extension", { ...POPUP, id: "other-ext" }],
    ["a band.us content script", { id: "test-ext-id", tab: { id: 3 }, url: "https://www.band.us/band/1" }],
    ["a web page", { id: "test-ext-id", url: "http://127.0.0.1:7238/" }],
  ])("refuses %s", async (_label, sender) => {
    cliPosts.length = 0;
    const r = await send({ type: "pair_send", tab_id: 1 }, sender);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/only available to the Band Tools popup/);
    expect(cliPosts).toHaveLength(0);
  });
});
