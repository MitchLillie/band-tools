// End-to-end test in a real Chromium with the unpacked extension loaded.
//
// Proves the genuinely browser-bound bits the headless unit tests can't:
//   - the MV3 *module* service worker loads (incl. the bandstand ESM import)
//   - chrome.cookies reads the HttpOnly secretKey
//   - a request flows through bandstand inside the real service worker
//
// BAND's API is mocked via context.route, and fake band.us cookies are injected,
// so this never touches the real service or needs credentials.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect } from "@playwright/test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      // The full chromium build (not the headless shell) is required to load
      // extensions; it runs in new-headless mode, which supports them.
      channel: "chromium",
      args: [
        `--disable-extensions-except=${root}`,
        `--load-extension=${root}`,
        "--no-sandbox",
      ],
    });
    // Fake band.us auth so the service worker's readSecretKey() succeeds.
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

// Open one of the extension's own pages so chrome.runtime.sendMessage targets the SW.
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

test("get_calendars flows through bandstand in the real SW (API mocked)", async ({
  context,
  extensionId,
}) => {
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
