/**
 * Append-only screen-router registry — THE mounting convention for the Phase 2B
 * fan-out (P2B-0002…0009).
 *
 * Each child spec adds exactly one mount function to `SCREEN_MOUNTS` and owns
 * its routes under its own `src/routes/<area>/**` subtree. The array is
 * append-only, so parallel worktree PRs never collide here (each appends one
 * line). `createApp` calls `mountScreens(app, deps)` BEFORE `mountShell`, so a
 * registered child route is always present first and the shell only fills the
 * remaining gaps with placeholders (see the ordering contract in `mountShell`).
 *
 * Example (a future P2B-0005 history & costs screen):
 *
 *   // services/dashboard/src/routes/costs/index.tsx
 *   import { loadShellContext, renderShell, type ShellDeps } from "../../app/mountShell.js";
 *   export function mountCostsScreen(app: Hono, deps: ShellDeps): void {
 *     app.get("/costs", async (c) => {
 *       const ctx = await loadShellContext(c, deps, { activeNavId: "costs" });
 *       return renderShell(c, ctx, { title: "tanren · costs" }, <CostsBody ctx={ctx} />);
 *     });
 *   }
 *
 *   // here, append one line:
 *   import { mountCostsScreen } from "../routes/costs/index.js";
 *   SCREEN_MOUNTS.push(mountCostsScreen);
 */

import type { Hono } from "hono";
import type { ShellDeps } from "./mountShell.js";

/** A child-screen mount function: registers the spec's routes on the app. */
export type ScreenMount = (app: Hono, deps: ShellDeps) => void;

/**
 * Registered child screens, in mount order. Empty during P2B-0001 — every
 * sidenav row resolves to a documented placeholder until its owning spec lands
 * and appends its mount function here.
 */
export const SCREEN_MOUNTS: ScreenMount[] = [];

// P2B-0003 — chat-primary project view, spec creation, routing & limits.
import { mountProjectScreens } from "../routes/projects/index.js";
SCREEN_MOUNTS.push(mountProjectScreens);

// P2B-0002 onboarding (org setup + existing-project) + credentials + notifications.
import { mountOnboardingScreens } from "../routes/onboarding/index.js";
SCREEN_MOUNTS.push(mountOnboardingScreens);

// P2B-0005: dashboard history & costs (overrides the /costs placeholder).
import { mountCostsScreen } from "../routes/costs/index.js";
SCREEN_MOUNTS.push(mountCostsScreen);

// P2B-0004: run-detail view + review-handoff sub-surface (SSE live).
import { mountRunDetailScreens } from "../routes/runs/index.js";
SCREEN_MOUNTS.push(mountRunDetailScreens);

// P2B-0008: halted-run failure-recovery surface (`/runs/halted` list +
// `/runs/:runId/recover`). Appended AFTER P2B-0004 so its `/runs/:runId`
// handler delegates the `halted` literal back via next() and lands here.
import { mountHaltedRunScreens } from "../routes/runs/halted.js";
SCREEN_MOUNTS.push(mountHaltedRunScreens);

// P2B-0006: operator-triggered live run (POST /projects/:projectId/specs/:specId/run).
import { mountTriggerScreens } from "../routes/runs/trigger/index.js";
SCREEN_MOUNTS.push(mountTriggerScreens);

// P3-0019: DORA-like delivery metrics panel (overrides the /dora placeholder).
import { mountDoraScreen } from "../routes/dora/index.js";
SCREEN_MOUNTS.push(mountDoraScreen);

// P3-0014: spec discovery (insight → classification → proposed specs →
// DAG placement → accept with provenance). Overrides the /discovery placeholder
// and adds the project-scoped discovery routes.
import { mountDiscoveryScreens } from "../routes/discovery/index.js";
SCREEN_MOUNTS.push(mountDiscoveryScreens);

// P3-0017: tanren-config audit-gate surface (config-as-code PR review) + the
// Settings toggle. Overrides the /settings/config placeholder.
import { mountConfigScreen } from "../routes/config/index.js";
SCREEN_MOUNTS.push(mountConfigScreen);

// P3-0022: candidate inbox (configurable issue sources → Forge triage →
// accept→discovery / fold / dismiss / close-as-dup). Overrides the /inbox
// placeholder.
import { mountInboxScreens } from "../routes/inbox/index.js";
SCREEN_MOUNTS.push(mountInboxScreens);

/** Run every registered screen mount. Called BEFORE `mountShell`. */
export function mountScreens(app: Hono, deps: ShellDeps): void {
  for (const mount of SCREEN_MOUNTS) {
    mount(app, deps);
  }
}
