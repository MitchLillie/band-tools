// End-to-end: `bandstand login` ⇄ Band Tools one-click pairing.
//
// Spawns the real bandstand CLI receiver (`bandstand login --port <free>`) with
// BAND_STATE pointed at a temp file and a stub `open` on PATH (so no desktop
// browser tab opens), loads the built extension into Chromium with FAKE band.us
// cookies, opens the landing page, then the popup with that tab active, clicks
// "Send BAND session to bandstand", and checks the CLI saved exactly those cookies
// and exited 0 without a y/N prompt.
//
// Needs a bandstand build that has the loopback receiver (receiveSessionViaLoopback);
// skipped otherwise. BANDSTAND_CLI=/path/to/bandstand/dist/cli.js overrides which
// CLI is spawned; BANDSTAND_E2E_TMP overrides the temp root (default: os.tmpdir()).
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, chromium, expect } from "@playwright/test";

const extDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

const FAKE_SESSION = "e2e-fake-band-session";
const FAKE_SECRET = "e2e-fake-secret-key";

async function resolveCli() {
  if (process.env.BANDSTAND_CLI) return process.env.BANDSTAND_CLI;
  try {
    const mod = await import("bandstand");
    if (typeof mod.receiveSessionViaLoopback !== "function") return null;
    return path.join(path.dirname(fileURLToPath(import.meta.resolve("bandstand"))), "cli.js");
  } catch {
    return null;
  }
}
const cliPath = await resolveCli();

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn `bandstand login` in a sandboxed env; resolves helpers once it's listening. */
async function startCli(tmp) {
  const bin = path.join(tmp, "bin");
  await mkdir(bin, { recursive: true });
  const openLog = path.join(tmp, "open.log");
  for (const name of ["open", "xdg-open"]) {
    const stub = path.join(bin, name);
    await writeFile(stub, `#!/bin/sh\necho "$@" >> "${openLog}"\n`);
    await chmod(stub, 0o755);
  }
  const statePath = path.join(tmp, "band_session.json");
  const port = await freePort();

  const child = spawn(process.execPath, [cliPath, "login", "--port", String(port)], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      BAND_STATE: statePath,
      BAND_CONFIG: path.join(tmp, "band_config.json"),
    },
    // stdin stays open and is never written: if the CLI prompted [y/N] it would
    // hang here and the test would time out instead of passing.
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  const url = `http://127.0.0.1:${port}/`;
  await expect.poll(() => stderr, { timeout: 10_000 }).toContain(`Opening ${url}#pair=`);

  return {
    url,
    port,
    statePath,
    openLog,
    exited,
    output: () => ({ stdout, stderr }),
    kill: () => child.exitCode === null && child.kill("SIGKILL"),
  };
}

const test = base.extend({
  tmp: async ({}, use) => {
    const rootDir = process.env.BANDSTAND_E2E_TMP ?? os.tmpdir();
    await mkdir(rootDir, { recursive: true });
    const dir = await mkdtemp(path.join(rootDir, "bt-pair-"));
    await use(dir);
    await rm(dir, { recursive: true, force: true });
  },
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--no-sandbox"],
    });
    // Belt and braces: nothing in these tests should touch the real BAND.
    await context.route(/band\.us/, (route) => route.abort());
    await context.addCookies([
      // Real-world shapes: secretKey is HttpOnly + path-scoped and quoted.
      { name: "secretKey", value: `"${FAKE_SECRET}"`, domain: ".band.us", path: "/s/login/", httpOnly: true, secure: true },
      { name: "band_session", value: FAKE_SESSION, domain: ".band.us", path: "/", secure: true },
    ]);
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    context.extensionId = new URL(sw.url()).host;
    await use(context);
    await context.close();
  },
});

test.describe("bandstand login ⇄ Band Tools popup", () => {
  test.skip(!cliPath, "installed bandstand has no loopback login receiver (npm i bandstand@latest or set BANDSTAND_CLI)");

  test("popup hands the session to the CLI; saved without a prompt", async ({ context, tmp }) => {
    const cli = await startCli(tmp);
    try {
      // The CLI tried to open the landing page (via the stub), nonce in the fragment.
      await expect.poll(() => readFile(cli.openLog, "utf8").catch(() => "")).toMatch(/#pair=[0-9a-f]{32}/);
      const opened = (await readFile(cli.openLog, "utf8")).trim().split("\n").pop();

      // Popup tab first, then the landing page in front: reloading the popup makes it
      // see the landing page as the active tab, as when the toolbar icon is clicked.
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${context.extensionId}/popup.html`);
      const landing = await context.newPage();
      await landing.goto(opened);
      await expect(landing.getByText("Band Tools", { exact: false }).first()).toBeVisible();
      await popup.reload();

      await expect(popup.locator("#cli-pair")).toBeVisible();
      await popup.bringToFront();
      await popup.click("#cli-pair-send");
      await expect(popup.locator("#cli-pair-msg")).toHaveText(/check your terminal/);

      const { code } = await cli.exited;
      const { stdout, stderr } = cli.output();
      expect(code, `stderr:\n${stderr}`).toBe(0);
      expect(stderr).not.toMatch(/\[y\/N\]|Save these\?/);
      expect(stderr).toContain("pairing nonce verified");
      expect(stdout).toContain("secretKey present: true");

      const saved = JSON.parse(await readFile(cli.statePath, "utf8"));
      const jar = saved.cookies ?? saved;
      expect(jar.band_session).toBe(FAKE_SESSION);
      expect(jar.secretKey).toBe(FAKE_SECRET);
    } finally {
      cli.kill();
    }
  });

  test("popup shows no CLI panel on other tabs", async ({ context }) => {
    const other = await context.newPage();
    await other.goto("about:blank");
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${context.extensionId}/popup.html`);
    await other.bringToFront();
    await popup.reload();
    await expect(popup.locator("#auth-error, #tabs").first()).toBeAttached();
    await expect(popup.locator("#cli-pair")).toBeHidden();
  });
});
