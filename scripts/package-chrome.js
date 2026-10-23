// Pack dist/ into a Chrome Web Store-ready .zip, excluding the Firefox build.
// Run after `npm run build`. Output: band-tools-chrome-<version>.zip in repo root.
import { createWriteStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

// Minimal pure-Node zip writer (store-only, no compression) — extension
// uploads to the Chrome Web Store don't need DEFLATE, and avoiding it keeps
// the script dependency-free.
const STORE = 0;
const FILE = 0x0800;
const DIR = 0x10;

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function listFiles(root) {
  const out = [];
  async function walk(dir, base = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        // Skip the Firefox build — it must not be uploaded to the Chrome Web Store.
        if (rel === "firefox") continue;
        await walk(full, rel);
      } else if (entry.isFile()) {
        out.push({ full, rel });
      }
    }
  }
  await walk(root);
  return out;
}

function dosTime(d = new Date()) {
  const t = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const dt = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: t, date: dt };
}

async function main() {
  const dist = "dist";
  if (!(await stat(dist).catch(() => null))) {
    throw new Error(`${dist}/ not found — run \`npm run build\` first`);
  }

  const manifest = JSON.parse(await readFile(join(dist, "manifest.json"), "utf8"));
  const version = manifest.version;
  if (!version) throw new Error("manifest.json has no version field");

  const zipName = `band-tools-chrome-${version}.zip`;
  const files = await listFiles(dist);
  // Sort so the output is deterministic.
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const { time, date } = dosTime();
  const local = [];
  const central = [];
  let offset = 0;
  const chunks = [];

  for (const { full, rel } of files) {
    const nameBuf = Buffer.from(rel, "utf8");
    const data = await readFile(full);
    const crc = crc32(data);

    // Local file header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);          // version needed
    lh.writeUInt16LE(FILE, 6);        // flags
    lh.writeUInt16LE(STORE, 8);       // method
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);

    // Central directory entry
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);          // version made by
    cd.writeUInt16LE(20, 6);          // version needed
    cd.writeUInt16LE(FILE, 8);
    cd.writeUInt16LE(STORE, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);          // extra
    cd.writeUInt16LE(0, 32);          // comment
    cd.writeUInt16LE(0, 34);          // disk
    cd.writeUInt16LE(0, 36);          // internal attrs
    cd.writeUInt32LE(0, 38);          // external attrs (regular file)
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  chunks.push(...local, ...central, eocd);
  await pipeline(chunks, createWriteStream(zipName));

  console.log(`wrote ${zipName} (${files.length} files)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
