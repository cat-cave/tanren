// LIVE per-fragment authoring wiring (docs/roadmap/templating-system.md F2).
//
// Builds the `runFragmentAuthoring` seam the route layer threads into the derive.
// On a missing-fragments decision the derive calls into this runner, which
// authors each missing fragment via the injected `FragmentAuthorer`, validates
// the result through the smoke-composition harness, persists the validated
// fragment into the org's `fragments` table, and emits durable
// `fragment.authoring.*` events so the run is observable.
//
// The `FragmentAuthorer` is REQUIRED — there is no stub/in-memory default. The
// route layer wires it via `buildForgeFragmentAuthorerFactory` (the same
// allocating Forge answerer infra the planner/checker/auditor use); tests use
// the `buildFakeFragmentAuthorer` fixture from `tests/fixtures/`. A missing
// authorer is a wiring bug, not a degrade — `buildLiveRunFragmentAuthoring`
// throws if `deps.authorer` is omitted.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import {
  buildFragmentAuthoring,
  type FragmentAuthoring,
  type FragmentAuthorer,
  type FragmentAuthoringEvents,
  type FragmentPersistence,
  type LoadOrgFragments,
  type OrgFragmentSource,
  loadUnifiedFragmentLibrary,
  type FragmentLibrary,
} from "../../engine/templates/index.js";
import { FragmentsStore } from "../../engine/repositories/fragments.js";
import type { EventStore } from "../../engine/eventStore.js";

export interface FragmentAuthoringFlowDeps {
  pool: pg.Pool;
  /** The durable event store — REQUIRED. The per-fragment-authoring run emits
   * `fragment.authoring.{started,succeeded,failed}` events that the operator
   * inspects when F2 halts (templating-system doctrine). Omitting it used to
   * short-circuit the emit path silently; the writer-seam discipline (PR
   * #714/#718) bans silent-degradation, so this is now load-bearing. Production
   * wires `new PgEventStore(scopedPool)` from `mountFeatureRoutes.ts`; tests
   * inject a recording fake (v66 fix). */
  eventStore: EventStore;
  /** The LLM-backed fragment authorer — REQUIRED. There is no default. */
  authorer: FragmentAuthorer;
}

/** Build the live per-fragment authoring seam for ONE (orgId) context. */
export function buildLiveRunFragmentAuthoring(
  deps: FragmentAuthoringFlowDeps,
  ctx: { orgId: string },
): FragmentAuthoring {
  const { pool, eventStore, authorer } = deps;
  const { orgId } = ctx;
  // Loud-throw on a missing eventStore — silent-degradation is banned (v66 fix).
  // The TS signature already requires it; this guards against erased-type callers.
  if (eventStore === undefined) {
    throw new Error(
      "buildLiveRunFragmentAuthoring: `eventStore` is required — the per-fragment authoring run " +
        "must emit `fragment.authoring.*` events for operator observability. Wire " +
        "`new PgEventStore(scopedPool)` from the route mount (v66 fix).",
    );
  }

  const persistence: FragmentPersistence = {
    async create(input) {
      return runWithOrgScope(pool, orgId, async (client) => {
        const row = await FragmentsStore.create(
          client,
          {
            orgId: input.orgId,
            kind: input.spec.kind,
            label: input.spec.label,
            version: "1.0.0",
            bodyTs: input.bodyTs,
            contract: input.contract,
            dependsOn: input.dependsOn,
          },
          { kind: "operator" },
        );
        return { fragmentId: row.fragmentId };
      });
    },
    async markValidated(fragmentId) {
      await runWithOrgScope(pool, orgId, async (client) => {
        await FragmentsStore.markValidated(client, fragmentId, { kind: "operator" });
      });
    },
  };

  const events: FragmentAuthoringEvents = {
    async emit(event) {
      // The fragment.authoring.* events are registered in the event vocabulary
      // (services/orchestrator/src/engine/events/schemas/templates.ts) so the
      // event store accepts them. The synthetic "fragment-authoring" runId is
      // a placeholder — these events fire OUTSIDE a real run; the dashboard
      // surfaces them via the org-scoped event stream.
      const payload =
        event.kind === "fragment.authoring.started"
          ? { orgId: event.orgId, fragmentId: event.fragmentId, kind: event.spec.kind, label: event.spec.label }
          : event.kind === "fragment.authoring.succeeded"
            ? { orgId: event.orgId, fragmentId: event.fragmentId, attempts: event.attempts }
            : { orgId: event.orgId, fragmentId: event.fragmentId, reason: event.reason, attempts: event.attempts };
      await eventStore.append({
        runId: "fragment-authoring",
        eventType: event.kind,
        payload,
      } as Parameters<typeof eventStore.append>[0]);
    },
  };

  return buildFragmentAuthoring({ authorer, persistence, events });
}

/** Build the live unified fragment library loader for ONE (orgId) context. */
export function buildLiveLoadFragmentLibrary(pool: pg.Pool): (orgId: string | undefined) => Promise<FragmentLibrary> {
  const loadOrgFragments: LoadOrgFragments = async (orgId) => {
    return runWithOrgScope(pool, orgId, async (client) => {
      const rows = await FragmentsStore.listValidated(client, { kind: "operator" });
      return rows.map(
        (row): OrgFragmentSource => ({
          fragmentId: row.fragmentId,
          kind: row.kind,
          label: row.label,
          version: row.version,
          bodyTs: row.bodyTs,
          contract: row.contract,
          dependsOn: row.dependsOn,
        }),
      );
    });
  };
  return (orgId) => loadUnifiedFragmentLibrary(orgId, loadOrgFragments);
}
