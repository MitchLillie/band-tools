import { createHmac } from "node:crypto";
import sinonChrome from "sinon-chrome";
import { beforeAll, describe, expect, it } from "vitest";

// BAND signs JWT sessions with the base64url-DECODED secretKey (not its UTF-8 text).
// The other tests mock fetch and never check `md`, so they can't catch a wrong key.
const SECRET = "c2lnbmluZy1rZXktZm9yLXRlc3Rz"; // base64url, as BAND issues it
const JWT_SESSION = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.sig";

let send;
let lastRequest;

beforeAll(async () => {
  globalThis.chrome = sinonChrome.default ?? sinonChrome;
  let listener;
  chrome.runtime.onMessage.addListener = (fn) => {
    listener = fn;
  };
  chrome.cookies = {
    getAll: async ({ name }) =>
      name === "secretKey"
        ? [{ domain: ".band.us", value: `"${SECRET}"` }]
        : name === "band_session"
          ? [{ domain: ".band.us", value: JWT_SESSION }]
          : [],
  };
  const area = () => ({ get: async () => ({}), set: async () => {}, remove: async () => {} });
  chrome.storage = { local: area(), session: area() };
  globalThis.fetch = async (url, init) => {
    lastRequest = { url: String(url), headers: new Headers(init?.headers) };
    return new Response(JSON.stringify({ result_code: 1, result_data: { internal_calendars: [] } }), {
      headers: { "content-type": "application/json" },
    });
  };

  await import("../src/background.js");
  send = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
});

describe("request signing with a JWT band_session", () => {
  it("HMACs the path with the base64url-decoded secretKey", async () => {
    const r = await send({ type: "get_calendars", band_no: 1 });
    expect(r.ok).toBe(true);
    const path = lastRequest.url.replace(/^https:\/\/[^/]+/, "");
    const expected = createHmac("sha256", Buffer.from(SECRET, "base64url")).update(path).digest("base64");
    expect(lastRequest.headers.get("md")).toBe(expected);
  });
});
