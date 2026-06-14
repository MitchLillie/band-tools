import { cp, rm } from "node:fs/promises";
import { build } from "esbuild";

const STATIC = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "options.html",
  "options.js",
  "content.js",
  "icons",
];

await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/background.js"],
  bundle: true,
  format: "esm",
  outfile: "dist/background.js",
});
await Promise.all(STATIC.map((f) => cp(f, `dist/${f}`, { recursive: true })));
