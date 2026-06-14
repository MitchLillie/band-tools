import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect } from "@playwright/test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", // full build (not the headless shell) is required to load extensions
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, "--no-sandbox"],
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

test("service worker registers", async ({ context, extensionId }) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
  const [sw] = context.serviceWorkers();
  expect(sw.url()).toContain("background.js");
});

test("check_auth reads the HttpOnly secretKey via chrome.cookies", async ({ context, extensionId }) => {
  const page = await openExtensionPage(context, extensionId);
  const res = await page.evaluate(() => chrome.runtime.sendMessage({ type: "check_auth" }));
  expect(res).toEqual({ ok: true, result: "e2e-secret" });
});

test("get_calendars flows through bandstand in the real service worker", async ({ context, extensionId }) => {
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
