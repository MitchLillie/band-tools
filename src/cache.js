// Small TTL cache over a chrome.storage area for slow-changing band metadata
// (calendars, member groups, who-am-I). Entries are stored as
// `cache:<name>:<band_no>` → { ts, data } so they survive service-worker restarts.
//
// - Hit younger than `revalidateAfterMs`: served from storage, no network.
// - Hit between `revalidateAfterMs` and `ttlMs`: served from storage immediately,
//   and refreshed in the background (stale-while-revalidate). Pages that care can
//   watch chrome.storage.onChanged for the new value.
// - Miss / older than `ttlMs` / `fresh: true`: fetched (concurrent requests for the
//   same key share one fetch).

export const CACHE_PREFIX = "cache:";
export const META_TTL_MS = 60 * 60 * 1000;
export const META_REVALIDATE_AFTER_MS = 10 * 60 * 1000;

export function cacheKey(name, band_no) {
  return `${CACHE_PREFIX}${name}:${band_no}`;
}

export function createCache({
  storage,
  ttlMs = META_TTL_MS,
  revalidateAfterMs = META_REVALIDATE_AFTER_MS,
  now = Date.now,
}) {
  const inflight = new Map();
  // Bumped by invalidate() so a fetch that started before it can't write stale data back.
  let generation = 0;

  function refresh(key, fetcher) {
    const pending = inflight.get(key);
    if (pending) return pending;
    const gen = generation;
    const p = (async () => {
      const data = await fetcher();
      if (gen === generation) await storage.set({ [key]: { ts: now(), data } });
      return data;
    })().finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
    return p;
  }

  async function read(key) {
    const entry = (await storage.get(key))?.[key];
    if (!entry || typeof entry.ts !== "number") return null;
    const age = now() - entry.ts;
    return age >= 0 && age < ttlMs ? { data: entry.data, age } : null;
  }

  async function get(key, fetcher, { fresh = false } = {}) {
    if (!fresh) {
      const hit = await read(key);
      if (hit) {
        if (hit.age >= revalidateAfterMs) refresh(key, fetcher).catch(() => {});
        return hit.data;
      }
    }
    return refresh(key, fetcher);
  }

  /** Drop cached entries — all of them, or only those for one band. */
  async function invalidate(band_no = null) {
    generation++;
    inflight.clear();
    const all = (await storage.get(null)) || {};
    const suffix = band_no == null ? null : `:${band_no}`;
    const keys = Object.keys(all).filter(
      (k) => k.startsWith(CACHE_PREFIX) && (suffix == null || k.endsWith(suffix)),
    );
    if (keys.length) await storage.remove(keys);
    return keys.length;
  }

  return { get, invalidate, read };
}
