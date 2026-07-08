/**
 * Append-only screen-router registry — THE mounting convention for the
 * fan-out .
 *
 * Each child spec adds exactly one mount function to `SCREEN_MOUNTS` and owns
 * its routes under its own `src/routes/<area>/**` subtree. The array is
 * append-only, so parallel worktree PRs never collide here (each appends one
 * line). `createApp` calls `mountScreens(app, deps)` BEFORE `mountShell`, so a
 * registered child route is always present first and the shell only fills the
 * remaining gaps with placeholders (see the ordering contract in `mountShell`).
 *
 * Example (a future history & costs screen):
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
 * Registered child screens, in mount order. Empty until a screen registers — every
 * sidenav row resolves to a documented placeholder until its owning spec lands
 * and appends its mount function here.
 */
export const SCREEN_MOUNTS: ScreenMount[] = [];

// chat-primary project view, spec creation, routing & limits.
import { mountProjectScreens } from "../routes/projects/index.js";
SCREEN_MOUNTS.push(mountProjectScreens);

// onboarding (org setup + existing-project) + credentials + notifications.
import { mountOnboardingScreens } from "../routes/onboarding/index.js";
SCREEN_MOUNTS.push(mountOnboardingScreens);

// dashboard history & costs (overrides the /costs placeholder).
import { mountCostsScreen } from "../routes/costs/index.js";
SCREEN_MOUNTS.push(mountCostsScreen);

// run-detail view + review-handoff sub-surface (SSE live).
import { mountRunDetailScreens } from "../routes/runs/index.js";
SCREEN_MOUNTS.push(mountRunDetailScreens);

// halted-run failure-recovery surface (`/runs/halted` list +
// `/runs/:runId/recover`). Appended AFTER so its `/runs/:runId`
// handler delegates the `halted` literal back via next() and lands here.
import { mountHaltedRunScreens } from "../routes/runs/halted.js";
SCREEN_MOUNTS.push(mountHaltedRunScreens);

// operator-triggered live run (POST /projects/:projectId/specs/:specId/run).
import { mountTriggerScreens } from "../routes/runs/trigger/index.js";
SCREEN_MOUNTS.push(mountTriggerScreens);

// DORA-like delivery metrics panel (overrides the /dora placeholder).
import { mountDoraScreen } from "../routes/dora/index.js";
SCREEN_MOUNTS.push(mountDoraScreen);

// spec discovery (insight → classification → proposed specs →
// DAG placement → accept with provenance). Overrides the /discovery placeholder
// and adds the project-scoped discovery routes.
import { mountDiscoveryScreens } from "../routes/discovery/index.js";
SCREEN_MOUNTS.push(mountDiscoveryScreens);

// tanren-config audit-gate surface (config-as-code PR review) + the
// Settings toggle. Overrides the /settings/config placeholder.
import { mountConfigScreen } from "../routes/config/index.js";
SCREEN_MOUNTS.push(mountConfigScreen);

// candidate inbox (configurable issue sources → Forge triage →
// accept→discovery / fold / dismiss / close-as-dup). Overrides the /inbox
// placeholder.
import { mountInboxScreens } from "../routes/inbox/index.js";
SCREEN_MOUNTS.push(mountInboxScreens);

// greenfield onboarding (the FULL `/onboarding/new` track —
// multi-round vision interview → derived spec DAG → arrival). Owns its routes
// entirely under routes/onboarding/new; does not touch the shared brownfield
// onboarding handler.
import { mountGreenfieldOnboarding } from "../routes/onboarding/new/index.js";
SCREEN_MOUNTS.push(mountGreenfieldOnboarding);

// scheduled audits — the recurring read-only Answerer-pass library
// (job library + window-fill bar + forge-recommended coverage + composer).
// Overrides the /audits placeholder; findings auto-route to the inbox.
import { mountAuditScreens } from "../routes/audits/index.js";
SCREEN_MOUNTS.push(mountAuditScreens);

// merge queue — the native-delivery operator window: rebase-vs-rebuild
// economics (never-discard read-side) + native merge-queue statistics, both
// reported from the engine's own events. Overrides the /merge-queue nav row.
import { mountMergeQueueScreen } from "../routes/mergeQueue/index.js";
SCREEN_MOUNTS.push(mountMergeQueueScreen);

// budget-halt — enforced project ceiling + real spend (gated) + notional
// (not gated) + pause banner + form POST proxy to PUT project budget.
import { mountBudgetScreen } from "../routes/budget/index.js";
SCREEN_MOUNTS.push(mountBudgetScreen);

/** Run every registered screen mount. Called BEFORE `mountShell`. */
export function mountScreens(app: Hono, deps: ShellDeps): void {
  for (const mount of SCREEN_MOUNTS) {
    mount(app, deps);
  }
}
