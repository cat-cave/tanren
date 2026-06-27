// LIVE per-fragment authoring wiring (docs/roadmap/templating-system.md F2).
//
// Builds the `runFragmentAuthoring` seam the route layer threads into the derive.
// On a missing-fragments decision the derive calls into this runner, which
// authors each missing fragment via the injected `FragmentAuthorer`, validates
// the result through the smoke-composition harness, persists the validated
// fragment into the org's `fragments` table, and emits durable
// `fragment.authoring.*` events so the run is observable.
//
// The `FragmentAuthorer` itself is the seam to an LLM-backed writer; production
// can wire a provider answerer, while the deterministic
// `buildInMemoryFragmentAuthorer` is the test seam + a sane default.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import {
  buildFragmentAuthoring,
  buildInMemoryFragmentAuthorer,
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
  eventStore?: EventStore;
  authorer?: FragmentAuthorer;
}

/** Build the live per-fragment authoring seam for ONE (orgId) context. */
export function buildLiveRunFragmentAuthoring(
  deps: FragmentAuthoringFlowDeps,
  ctx: { orgId: string },
): FragmentAuthoring {
  const { pool, eventStore } = deps;
  const { orgId } = ctx;
  const authorer = deps.authorer ?? buildInMemoryFragmentAuthorer();

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
      if (eventStore === undefined) return;
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
