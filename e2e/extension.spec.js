import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect } from "@playwright/test";

const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", // full build (not the headless shell) is required to load extensions
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-sandbox"],
    });
    await context.addCookies([
      { name: "secretKey", value: '"e2e-secret"', domain: ".band.us", path: "/", httpOnly: true, secure: true },
      { name: "band_session", value: "e2e-session", domain: ".band.us", path: "/", secure: true },
    ]);
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    await use(new URL(sw.url()).host);
  },
});

async function openExtensionPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

test("service worker (module + bandstand import) registers", async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
  const [sw] = context.serviceWorkers();
  expect(sw.url()).toContain("background.js");
});

test("check_auth reads the HttpOnly secretKey via chrome.cookies", async ({ context, extensionId }) => {
  const page = await openExtensionPage(context, extensionId);
  const res = await page.evaluate(() => chrome.runtime.sendMessage({ type: "check_auth" }));
  expect(res).toEqual({ ok: true, result: "e2e-secret" });
});

test("get_calendars flows through bandstand in the real SW (API mocked)", async ({ context, extensionId }) => {
  await context.route(/api-.*\.band\.us\/.*get_calendars/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result_code: 1,
        result_data: { internal_calendars: [{ is_default: true, name: "E2E Cal" }] },
      }),
    }),
  );
  const page = await openExtensionPage(context, extensionId);
  const res = await page.evaluate(() => chrome.runtime.sendMessage({ type: "get_calendars", band_no: 1 }));
  expect(res.ok).toBe(true);
  expect(res.result.internal_calendars[0].name).toBe("E2E Cal");
});

test("popup renders metadata from cache on reopen; refresh refetches (API mocked)", async ({ context, extensionId }) => {
  const counts = {};
  const data = {
    get_calendars: { internal_calendars: [{ is_default: true, name: "Main" }, { calendar_id: 11, name: "Ventura" }] },
    get_member_groups: { items: [{ member_group_id: 5, member_count: 2, name: "AAA" }] },
    get_my_band_schedules: { items: [{ owner: { user_no: 7, name: "Me" } }] },
    get_schedules: {
      items: [{ schedule_id: "4/1/100/1", band_no: 1, name: "Rehearsal", start_at: new Date(Date.now() + 86_400_000).toISOString() }],
      paging: {},
    },
  };
  await context.route(/api-.*\.band\.us\//, (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    counts[name] = (counts[name] ?? 0) + 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result_code: 1, result_data: data[name] ?? {} }),
    });
  });
  const page = await openExtensionPage(context, extensionId);
  await page.evaluate(() => chrome.storage.sync.set({ default_band: "1", default_calendar: "11", default_group: "5" }));

  const opened = async () => {
    await page.reload();
    await expect(page.locator(".event-item")).toHaveCount(1);
    await expect(page.locator("#week-calendar option")).toHaveCount(3);
    await expect(page.locator("#sync-group option")).toHaveText(["AAA (2)"]);
  };

  await opened();
  expect(counts).toMatchObject({ get_calendars: 1, get_member_groups: 1, get_my_band_schedules: 1, get_schedules: 1 });
  await expect(page.locator("#week-calendar")).toHaveValue("11");

  await opened(); // second open: everything from cache
  expect(counts).toMatchObject({ get_calendars: 1, get_member_groups: 1, get_my_band_schedules: 1, get_schedules: 1 });

  await page.click("#week-refresh");
  await expect(page.locator("#week-refresh")).toBeEnabled();
  await expect(page.locator(".event-item")).toHaveCount(1);
  expect(counts).toMatchObject({ get_calendars: 2, get_member_groups: 2, get_my_band_schedules: 2, get_schedules: 2 });
  await expect(page.locator("#week-calendar")).toHaveValue("11");
});

test("popup shows stale cached data at once, then revalidates in the background (API mocked)", async ({ context, extensionId }) => {
  const counts = {};
  const start = new Date(Date.now() + 86_400_000).toISOString();
  const data = {
    get_calendars: { internal_calendars: [{ calendar_id: 11, name: "Ventura (renamed)" }] },
    get_member_groups: { items: [] },
    get_my_band_schedules: { items: [{ owner: { user_no: 7, name: "Me" } }] },
    get_schedules: { items: [{ schedule_id: "4/1/2/1", band_no: 1, name: "New event", start_at: start }], paging: {} },
  };
  let releaseApi;
  const gate = new Promise((r) => (releaseApi = r));
  await context.route(/api-.*\.band\.us\//, async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    counts[name] = (counts[name] ?? 0) + 1;
    await gate; // hold responses so the cached render is observable
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result_code: 1, result_data: data[name] ?? {} }),
    });
  });
  const page = await openExtensionPage(context, extensionId);
  const staleTs = Date.now() - 20 * 60 * 1000; // past revalidate-after, inside the TTL
  await page.evaluate(({ staleTs, start }) => Promise.all([
    chrome.storage.sync.set({ default_band: "1", default_calendar: "11" }),
    chrome.storage.local.set({
      "cache:calendars:1": { ts: staleTs, data: { internal_calendars: [{ calendar_id: 11, name: "Ventura" }] } },
      "cache:admin:1": { ts: Date.now(), data: false },
      "cache:me:1": { ts: Date.now(), data: { user_no: 7, name: "Me" } },
    }),
    chrome.storage.session.set({
      week_cache: {
        ts: staleTs, band_no: 1, calendar_id: 11, days: 7,
        items: [{ when: "Sat", name: "Old event", url: "https://band.us/x", schedule_id: "4/1/1/1", band_no: 1 }],
      },
    }),
  ]), { staleTs, start });

  await page.reload();
  // Rendered from cache while the API is still held.
  await expect(page.locator(".event-name")).toHaveText(["Old event"]);
  await expect(page.locator("#week-calendar option", { hasText: "Ventura" })).toHaveText(["Ventura"]);

  releaseApi();
  await expect(page.locator(".event-name")).toHaveText(["New event"]);
  await expect(page.locator("#week-calendar option", { hasText: "Ventura" })).toHaveText(["Ventura (renamed)"]);
  await expect(page.locator("#week-calendar")).toHaveValue("11");
  expect(counts).toMatchObject({ get_calendars: 1, get_schedules: 1 });
  expect(counts.get_my_band_schedules).toBeUndefined(); // fresh cache entry → no call
  expect(counts.get_member_groups).toBeUndefined();
});
