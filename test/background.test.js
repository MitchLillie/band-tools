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

function fakeFetch(url) {
  const u = String(url);
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

beforeAll(async () => {
  globalThis.chrome = sinonChrome.default ?? sinonChrome;
  let listener;
  chrome.runtime.onMessage.addListener = (fn) => {
    listener = fn;
  };
  chrome.cookies = {
    getAll: async ({ name }) =>
      name === "secretKey"
        ? [{ domain: ".band.us", value: '"testsecret"' }]
        : name === "band_session"
          ? [{ domain: ".band.us", value: "sess" }]
          : [],
  };
  chrome.storage = { local: { set: async () => {} }, session: { set: async () => {} } };
  globalThis.fetch = fakeFetch;

  await import("../src/background.js");
  send = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
});

describe("background.js message handlers (mocked chrome + fetch)", () => {
  it("check_auth returns the secret", async () => {
    expect(await send({ type: "check_auth" })).toEqual({ ok: true, result: "testsecret" });
  });

  it("get_calendars", async () => {
    const r = await send({ type: "get_calendars", band_no: 1 });
    expect(r.result.internal_calendars).toHaveLength(1);
  });

  it("get_member_groups", async () => {
    const r = await send({ type: "get_member_groups", band_no: 1 });
    expect(r.result.items[0].name).toBe("Group");
  });

  it("check_admin → true", async () => {
    expect((await send({ type: "check_admin", band_no: 1 })).result).toBe(true);
  });

  it("detect_me", async () => {
    expect((await send({ type: "detect_me", band_no: 1 })).result).toEqual({ user_no: 7, name: "Me" });
  });

  it("band_week", async () => {
    const r = await send({ type: "band_week", band_no: 1, days: 3650 });
    expect(r.result[0]).toMatchObject({ name: "Event", schedule_id: SCHEDULE.schedule_id, my_rsvp: 1 });
    expect(r.result[0].url).toContain("/schedule/");
  });

  it("rsvp_status", async () => {
    const r = await send({ type: "rsvp_status", band_no: 1, schedule_id: SCHEDULE.schedule_id, me_name: "Alice" });
    expect(r.result.event_name).toBe("Event");
    expect(r.result.going).toContain("Alice");
    expect(r.result.my_rsvp).toBe(1);
  });

  it("update_rsvp", async () => {
    const r = await send({
      type: "update_rsvp",
      band_no: 1,
      schedule_id: SCHEDULE.schedule_id,
      rsvp_type: 1,
      me_user_no: 7,
    });
    expect(r.ok).toBe(true);
  });

  it("sync_group_dry", async () => {
    const r = await send({ type: "sync_group_dry", band_no: 1, calendar_id: 2, group_id: 1, days: 3650, me_user_no: null });
    expect(r.result.group_size).toBe(1);
    expect(r.result.updates_needed).toBe(1);
    expect(r.result.updates[0].missing_names).toContain("Bob");
  });

  it("sync_group_apply", async () => {
    const r = await send({ type: "sync_group_apply", band_no: 1, calendar_id: 2, group_id: 1, days: 3650, me_user_no: null });
    expect(r.result.applied_count).toBe(1);
  });

  it("unknown type → ok:false", async () => {
    const r = await send({ type: "definitely_not_a_real_type" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown message type/i);
  });
});
