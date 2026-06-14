import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const STATIC = [
  "popup.html",
  "popup.css",
  "popup.js",
  "content.js",
  "icons",
];

// Chrome build → dist/ (ESM service worker; keeps e2e tests working)
await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/background.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/background.js",
});
await Promise.all([
  cp("manifest.json", "dist/manifest.json"),
  ...STATIC.map((f) => cp(f, `dist/${f}`, { recursive: true })),
]);

// Firefox build → dist/firefox/ (IIFE service worker; no "type":"module")
await build({
  entryPoints: ["src/background.js"],
  bundle: true,
  format: "iife",
  outfile: "dist/firefox/background.js",
});
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const firefoxManifest = {
  ...manifest,
  background: { scripts: ["background.js"] },
  browser_specific_settings: {
    gecko: {
      id: "band-tools@band-tools",
      strict_min_version: "128.0",
    },
  },
};
await writeFile("dist/firefox/manifest.json", JSON.stringify(firefoxManifest, null, 2));
await Promise.all(STATIC.map((f) => cp(f, `dist/firefox/${f}`, { recursive: true })));
