import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFile(path.join(root, f), "utf8");
const manifest = (f) => read(f).then(JSON.parse);

describe("Firefox build (dist/firefox/)", () => {
  it("background.js is IIFE format", async () => {
    const src = await read("dist/firefox/background.js");
    expect(src.trimStart()).toMatch(/^\(\(\)/);
  });

  it("manifest uses background.scripts, not service_worker", async () => {
    const m = await manifest("dist/firefox/manifest.json");
    expect(Array.isArray(m.background.scripts)).toBe(true);
    expect(m.background.scripts).toContain("background.js");
    expect(m.background.service_worker).toBeUndefined();
    expect(m.background.type).toBeUndefined();
  });

  it("manifest has browser_specific_settings.gecko.id", async () => {
    const m = await manifest("dist/firefox/manifest.json");
    expect(m.browser_specific_settings?.gecko?.id).toBeTruthy();
    expect(m.browser_specific_settings?.gecko?.strict_min_version).toBeTruthy();
  });
});

describe("Chrome build (dist/)", () => {
  it("background.js is ESM format (not IIFE)", async () => {
    const src = await read("dist/background.js");
    expect(src.trimStart()).not.toMatch(/^\(\(\)/);
  });

  it("manifest uses service_worker with type:module", async () => {
    const m = await manifest("dist/manifest.json");
    expect(m.background.service_worker).toBe("background.js");
    expect(m.background.type).toBe("module");
    expect(m.background.scripts).toBeUndefined();
  });
});
