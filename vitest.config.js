import { defineConfig } from "vitest/config";

// Keep vitest to the unit tests under test/. The Playwright specs live in e2e/
// (run via `npm run e2e`) and must NOT be picked up here — they use a different
// test runner whose `test()` throws if invoked under vitest.
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    testTimeout: 30_000,
  },
});
