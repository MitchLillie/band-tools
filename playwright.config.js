import { defineConfig } from "@playwright/test";

// Chrome extensions require a persistent context and a single worker.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 30_000,
});
