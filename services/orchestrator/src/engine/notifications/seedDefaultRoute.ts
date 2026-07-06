// Onboarding-seeded DEFAULT notification route (api-mirrors-ux + no-silent
// doctrine). When an org/project is set up, seed a per-org ntfy target + the
// routes that make the apex-critical MILESTONE events (budget fraction/pause +
// deploy.verified/failed/skipped + the human-escalation needs_attention) reach a
// human on the dashboard-visible matrix BY DEFAULT — without an operator
// hand-configuring a `notification_targets` row first.
//
// Why an explicit per-event route set (not just the code-level env default): the
// dispatcher's matrix is per-event-name, so a durable, per-tenant,
// dashboard-visible route exists ONLY when a `notification_routes` row names the
// event. This is the operator-drivable path — exactly the rows a real user would
// create in the matrix UI — so a freshly-onboarded org already has a live route.
// The code-level env default (build.ts `resolveDefaultRouteFromEnv`) remains the
// event-agnostic belt-and-suspenders for any OTHER warn+ event.
//
// Idempotent: if an org-scoped ntfy target labeled as the default route already
// exists, reuse it and only add the routes it is missing — a re-onboard or a
// re-link never double-inserts.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { NotificationRouteStore, NotificationTargetStore } from "./store.js";
import type { NotificationRouteRow, NotificationTargetRow } from "./schemas.js";

// The label the onboarding seed stamps on the org-scoped ntfy target so the
// idempotency check (and the dashboard) can recognize it as the seeded default.
export const DEFAULT_ROUTE_TARGET_LABEL = "default route (onboarding)";

// The apex-critical MILESTONE events the default route delivers. Every entry is a
// warn+-severity event (eventDefaultSeverity.ts) — the exact escalations a live
// apex run must surface to a human (budget burn, the genuine pause, the
// proven-live deploy + its failures, a needs_attention human-decision hold, the
// operator-actionable demo/accounting failures).
//
// `demo.failed` (warn — PR #742) rides here because a demo that cannot even
// SURFACE (unresolvable surface / unsupported kind / provider read fail) blocks
// the full autonomous loop from proving out — apex must see it. Without the
// seed the event would only fire on the env-default belt-and-suspenders, never
// on the per-org matrix operators actually browse.
//
// `usage.accounting_failed` (fail — PR #754) rides here because a run-end
// accounting failure means a run finished with no persisted usage row (an audit
// hole under the plane-split; a fail-closed signal that budget deltas may have
// been skipped). Apex must see it for the same reason — visible on the matrix,
// not just carried via the env-default.
export const DEFAULT_ROUTE_EVENTS: readonly string[] = [
  "dag.budget.milestone",
  "dag.budget.paused",
  "deploy.verified",
  "deploy.failed",
  "deploy.skipped",
  "dag.spec.needs_attention",
  "demo.failed",
  "usage.accounting_failed",
] as const;

export interface EnsureDefaultRouteInput {
  pool: pg.Pool;
  orgId: string;
  // The ntfy topic the default route delivers to (a bare topic — the deploy
  // default base URL injected at boot resolves it). Operator-supplied at
  // onboarding, mirroring how a real user names their alert topic.
  ntfyTopic: string;
  // Optional per-target base URL override; omitted ⇒ the deploy default applies.
  baseUrl?: string;
}

export interface EnsureDefaultRouteResult {
  target: NotificationTargetRow;
  routes: NotificationRouteRow[];
  // True only when the target row itself was created on this call (a fresh org).
  created: boolean;
}

/**
 * Ensure the org has a default ntfy notification route for the apex-critical
 * milestone events. Reads the org's existing targets (org-scoped under RLS) and,
 * if no seeded default target exists, creates one; then ensures a `warn`-floor
 * route exists for each `DEFAULT_ROUTE_EVENTS` entry the target is missing.
 * Idempotent — safe to call on every onboard / repo-link.
 */
export async function ensureDefaultNotificationRoute(
  input: EnsureDefaultRouteInput,
): Promise<EnsureDefaultRouteResult> {
  return runWithOrgScope(input.pool, input.orgId, async (client) => {
    const existing = await NotificationTargetStore.listForOrg(client, input.orgId);
    const match = existing.find(
      (target) =>
        target.scope === "org" && target.channelKind === "ntfy" && target.label === DEFAULT_ROUTE_TARGET_LABEL,
    );
    const target =
      match ??
      (await NotificationTargetStore.create(client, {
        orgId: input.orgId,
        scope: "org",
        // An org-scoped target carries a null userId (the schema's org/user refinement).
        userId: null,
        channelKind: "ntfy",
        destination: input.ntfyTopic,
        // null ⇒ the deploy-default ntfy base URL injected at boot resolves the topic.
        baseUrl: input.baseUrl ?? null,
        label: DEFAULT_ROUTE_TARGET_LABEL,
        enabled: true,
        // The default route never weekend-mutes: a milestone/escalation must land
        // regardless of the day.
        weekendMute: false,
      }));

    const existingRoutes = await NotificationRouteStore.listForTarget(client, target.id);
    const haveEvent = new Set(existingRoutes.map((route) => route.eventName));
    const created: NotificationRouteRow[] = [];
    for (const eventName of DEFAULT_ROUTE_EVENTS) {
      if (haveEvent.has(eventName)) continue;
      const route = await NotificationRouteStore.create(client, {
        targetId: target.id,
        eventName,
        enabled: true,
        // The `warn` floor: every milestone event is warn-severity, so a warn
        // route delivers them while staying silent on routine info/ok lifecycle.
        minSeverity: "warn",
      });
      created.push(route);
    }
    return { target, routes: [...existingRoutes, ...created], created: match === undefined };
  });
}
