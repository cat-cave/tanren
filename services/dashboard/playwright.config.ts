/**
 * Playwright config for the dashboard's LOCAL-ONLY shell smoke. NOT wired into
 * `just ci` / `just fast-check` (see tests/e2e/README.md). Run manually with
 * `pnpm test:e2e` against a locally-running dashboard.
 */

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.DASHBOARD_E2E_URL ?? "http://localhost:3000",
    headless: true
  }
});
