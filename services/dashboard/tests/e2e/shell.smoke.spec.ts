/**
 * LOCAL-ONLY Playwright smoke for the dashboard shell. This is NOT part of the
 * CI gate (see ./README.md for the rationale): design-tool rendering differs
 * from a real browser, so pixel/behavioral diffs here would be noisy and would
 * jeopardise the green-CI merge gate. The CI hard gate is the `app.request`
 * rendered-HTML tests in `../shell.render.test.ts`.
 *
 * Run manually:
 *   cd services/dashboard
 *   pnpm add -D @playwright/test && pnpm exec playwright install chromium
 *   TANREN_REQUIRE_AUTH=0 pnpm dev   # in another shell, on :3000
 *   pnpm test:e2e
 *
 * Covers the two behaviors the rendered-HTML tests cannot: the palette opening
 * on ⌘K and the ink/ash theme toggle persisting across a reload.
 */

import { expect, test } from "@playwright/test";

const BASE = process.env.DASHBOARD_E2E_URL ?? "http://localhost:3000";

test("⌘K opens the forge palette", async ({ page }) => {
  await page.goto(`${BASE}/projects`);
  const palette = page.locator('[data-island="palette"]');
  await expect(palette).toBeHidden();
  await page.keyboard.press("Meta+k");
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
});

test("ink/ash toggle persists across reload", async ({ page }) => {
  await page.goto(`${BASE}/projects`);
  await page.locator('[data-theme-value="ash"]').click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "dark");
});
