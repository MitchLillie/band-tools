import { describe, expect, it, vi } from "vitest";
import { cacheKey, createCache } from "../src/cache.js";

// Minimal chrome.storage area (get(key|null), set, remove).
function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) {
      if (key == null) return { ...data };
      return key in data ? { [key]: data[key] } : {};
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

function setup({ ttlMs = 1000, revalidateAfterMs = 100 } = {}) {
  let t = 10_000;
  const storage = memoryArea();
  const cache = createCache({ storage, ttlMs, revalidateAfterMs, now: () => t });
  return { storage, cache, advance: (ms) => (t += ms) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("cacheKey", () => {
  it("namespaces by name and band", () => {
    expect(cacheKey("calendars", 42)).toBe("cache:calendars:42");
  });
});

describe("createCache", () => {
  it("fetches on a miss, then serves from storage", async () => {
    const { cache } = setup();
    const fetcher = vi.fn(async () => ({ v: 1 }));
    expect(await cache.get("cache:a:1", fetcher)).toEqual({ v: 1 });
    expect(await cache.get("cache:a:1", fetcher)).toEqual({ v: 1 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refetches (blocking) once the TTL has passed", async () => {
    const { cache, advance } = setup();
    let n = 0;
    const fetcher = vi.fn(async () => ++n);
    expect(await cache.get("k", fetcher)).toBe(1);
    advance(1000);
    expect(await cache.get("k", fetcher)).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("serves a stale-but-valid entry immediately and refreshes it in the background", async () => {
    const { cache, storage, advance } = setup();
    let n = 0;
    const fetcher = vi.fn(async () => ++n);
    await cache.get("k", fetcher);
    advance(500); // past revalidateAfterMs, inside ttlMs
    expect(await cache.get("k", fetcher)).toBe(1); // old value, right away
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(storage.data.k.data).toBe(2);
    expect(await cache.get("k", fetcher)).toBe(2); // fresh again → no more fetches
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not revalidate a young entry", async () => {
    const { cache, advance } = setup();
    const fetcher = vi.fn(async () => 1);
    await cache.get("k", fetcher);
    advance(50);
    await cache.get("k", fetcher);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fresh:true bypasses the cache and stores the new value", async () => {
    const { cache } = setup();
    let n = 0;
    const fetcher = async () => ++n;
    await cache.get("k", fetcher);
    expect(await cache.get("k", fetcher, { fresh: true })).toBe(2);
    expect(await cache.get("k", fetcher)).toBe(2);
  });

  it("shares one fetch between concurrent requests for the same key", async () => {
    const { cache } = setup();
    const fetcher = vi.fn(() => new Promise((r) => setTimeout(() => r("x"), 5)));
    const [a, b] = await Promise.all([cache.get("k", fetcher), cache.get("k", fetcher)]);
    expect([a, b]).toEqual(["x", "x"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const { cache } = setup();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValueOnce("ok");
    await expect(cache.get("k", fetcher)).rejects.toThrow("nope");
    expect(await cache.get("k", fetcher)).toBe("ok");
  });

  it("ignores entries with a future timestamp (clock moved back)", async () => {
    const { cache, storage } = setup();
    storage.data.k = { ts: 99_999_999, data: "weird" };
    expect(await cache.get("k", async () => "real")).toBe("real");
  });

  it("invalidate() drops every cache entry but leaves other storage alone", async () => {
    const { cache, storage } = setup();
    await cache.get(cacheKey("calendars", 1), async () => "c1");
    await cache.get(cacheKey("calendars", 2), async () => "c2");
    storage.data.me_user_no = 7;
    expect(await cache.invalidate()).toBe(2);
    expect(Object.keys(storage.data)).toEqual(["me_user_no"]);
  });

  it("invalidate(band_no) only drops that band's entries", async () => {
    const { cache, storage } = setup();
    await cache.get(cacheKey("calendars", 1), async () => "c1");
    await cache.get(cacheKey("groups", 1), async () => "g1");
    await cache.get(cacheKey("calendars", 12), async () => "c12");
    await cache.invalidate(1);
    expect(Object.keys(storage.data)).toEqual(["cache:calendars:12"]);
  });

  it("a fetch that started before invalidate() doesn't write its stale result back", async () => {
    const { cache, storage } = setup();
    let resolve;
    const pending = cache.get("cache:k:1", () => new Promise((r) => (resolve = r)));
    await flush(); // the fetch is now in flight
    expect(resolve).toBeTypeOf("function");
    await cache.invalidate();
    resolve("stale");
    expect(await pending).toBe("stale"); // the caller still gets its answer…
    expect(storage.data["cache:k:1"]).toBeUndefined(); // …but it isn't cached
  });
});
