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
//
// RUNTIME-VALIDITY SMOKE wiring (Codex HIGH fix — PR #789 was dead code). The
// F2 validate pipeline includes a runtime-validity smoke that materializes the
// composed VFS into a temp dir and runs the runtime's dep resolver (real pnpm
// / real bundle) to reject fragments whose declared deps don't resolve —
// composition-validity is NOT runtime-validity. `buildFragmentAuthoring` takes
// `runtimeValiditySmoke` as an OPTIONAL dep and silently skips the runtime
// step when it's absent (a fragment with `next@^99.0.0` would then persist as
// validated and only blow up at project bootstrap — one full trial
// wasted). `buildLiveRunFragmentAuthoring` MUST wire the live subprocess
// invokers below so the gate actually runs in prod; a regression test in
// `tests/fragmentAuthoringProdWiring.test.ts` pins this.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import {
  buildFragmentAuthoring,
  buildLiveBundleInvoker,
  buildLiveCargoInvoker,
  buildLiveGoInvoker,
  buildLivePipInvoker,
  buildLivePnpmInvoker,
  type FragmentAuthoring,
  type FragmentAuthorer,
  type FragmentAuthoringDeps,
  type FragmentAuthoringEvents,
  type FragmentPersistence,
  type LoadOrgFragments,
  type OrgFragmentSource,
  loadUnifiedFragmentLibrary,
  type FragmentLibrary,
  type PriorFragment,
  type RuntimeValiditySmokeDeps,
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

/** Build the LIVE `RuntimeValiditySmokeDeps` — real subprocess invokers for
 * every supported runtime (pnpm / bundle / pip+uv / go / cargo). Extracted
 * (and exported) so a regression test can pin the shape is non-undefined +
 * every invoker slot is populated. PR #789 shipped the runtime-validity smoke
 * WITHOUT wiring it into prod at all (pnpm/bundle were dead code); PR #795
 * shipped the pip/go/cargo LIVE invoker factories without wiring them either
 * — a Python/Go/Rust fragment declaring `fastapi==999.999.999` passed the
 * shallow manifest sniff and persisted as `validated` (Codex round-III H2:
 * same class of bug as #789). `mountFeatureRoutes` routes through
 * `buildLiveFragmentAuthoringDeps` below which calls this helper
 * unconditionally.
 *
 * The bundle/pip/go/cargo invokers each return `unavailable` when their
 * binary is off PATH; the smoke then falls back to the shallow manifest
 * sniff for that runtime, so wiring them unconditionally costs nothing on
 * hosts without ruby/python/go/rust. */
export function buildLiveRuntimeValiditySmokeDeps(): RuntimeValiditySmokeDeps {
  return {
    pnpmInvoker: buildLivePnpmInvoker(),
    bundleInvoker: buildLiveBundleInvoker(),
    pipInvoker: buildLivePipInvoker(),
    goInvoker: buildLiveGoInvoker(),
    cargoInvoker: buildLiveCargoInvoker(),
  };
}

/** Assemble the full `FragmentAuthoringDeps` for the live wiring. Extracted so a
 * regression test can assert `runtimeValiditySmoke` (and every other slot) is
 * populated BEFORE the deps object reaches `buildFragmentAuthoring`. Removing
 * any slot from this factory reproduces PR #789's dead-code bug — the test
 * fails loud rather than the runtime step silently degrading. */
export function buildLiveFragmentAuthoringDeps(
  deps: FragmentAuthoringFlowDeps,
  ctx: { orgId: string },
): FragmentAuthoringDeps {
  const { pool, eventStore, authorer } = deps;
  const { orgId } = ctx;
  // Loud-throw on a missing eventStore — silent-degradation is banned (v66 fix).
  // The TS signature already requires it; this guards against erased-type callers.
  if (eventStore === undefined) {
    throw new Error(
      "buildLiveFragmentAuthoringDeps: `eventStore` is required — the per-fragment authoring run " +
        "must emit `fragment.authoring.*` events for operator observability. Wire " +
        "`new PgEventStore(scopedPool)` from the route mount (v66 fix).",
    );
  }

  const persistence: FragmentPersistence = {
    // ATOMIC insert-as-validated (audit finding H2 — task #150). Prior two-step
    // `create` (as draft) + `markValidated` (flip) was NOT atomic: a throw
    // between the two runWithOrgScope calls left an orphaned draft row that the
    // unified loader silently ignored (it filters on status='validated'), and
    // the next derive would spawn a fresh authoring run instead of failing loud.
    // `createValidated` collapses to ONE transaction — the row is either fully
    // validated or nothing at all.
    async createValidated(input) {
      return runWithOrgScope(pool, orgId, async (client) => {
        const row = await FragmentsStore.createValidated(
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
    // Round-III H1: RETRACT-WITH-DELETE. Called by the post-authoring batch-
    // compose retract path when the augmented library fails to compose. Under
    // `runWithOrgScope` the org-scoped client's DELETE is bound to the org's
    // rows via RLS; a wrong-scope caller is a no-op. Delete on a missing row
    // succeeds silently (0 rows affected) so a partial-retract from a prior
    // run does not fail the current retract.
    async deleteById(fragmentId) {
      return runWithOrgScope(pool, orgId, async (client) => {
        await FragmentsStore.deleteById(client, fragmentId, { kind: "operator" });
      });
    },
  };

  const events: FragmentAuthoringEvents = {
    async emit(event) {
      // The fragment.authoring.* events are registered in the event vocabulary
      // (services/orchestrator/src/engine/events/schemas/templates.ts) so the
      // event store accepts them. They fire before a run, spec, or project
      // exists, so they are genuinely org-scoped and carry no invented lineage;
      // the dashboard surfaces them via the org-scoped event stream.
      const payload =
        event.kind === "fragment.authoring.started"
          ? { orgId: event.orgId, fragmentId: event.fragmentId, kind: event.spec.kind, label: event.spec.label }
          : event.kind === "fragment.authoring.attempt"
            ? {
                orgId: event.orgId,
                fragmentId: event.fragmentId,
                attempt: event.attempt,
                bodyPreview: event.bodyPreview,
                canonicalSignature: event.canonicalSignature,
                rejection: event.rejection,
                decision: event.decision,
              }
            : event.kind === "fragment.authoring.succeeded"
              ? { orgId: event.orgId, fragmentId: event.fragmentId, attempts: event.attempts }
              : { orgId: event.orgId, fragmentId: event.fragmentId, reason: event.reason, attempts: event.attempts };
      // ORG-SCOPED append (no project): the F2 per-fragment authoring DAG fires
      // BEFORE `createProject` in derive (services/orchestrator/src/engine/forge/
      // interview/derive.ts), so there is no project row to derive `org_id` from.
      // Pass the ambient scoped `orgId` explicitly — the event store's INSERT
      // uses it directly (the prior project_id → org_id subquery would resolve
      // NULL here and trip RLS; that was apex v68's halt).
      await eventStore.append({
        orgId,
        eventType: event.kind,
        payload,
      });
    },
  };

  // fix/f2-prompt-hardening: prior-fragments seam. The F2 writer prompt renders a
  // "these have worked before in this org, follow the shape" section when the
  // caller passes a non-empty prior list. Backed by `FragmentsStore.listValidatedByOrg`
  // under the org-scoped `QueryClient` (RLS bounds visibility). A DB blip here
  // does not fail the authoring run — `buildFragmentAuthoring` catches + logs
  // and proceeds with an empty prior context.
  const priorFragmentsLookup = async (lookupOrgId: string): Promise<readonly PriorFragment[]> => {
    return runWithOrgScope(pool, lookupOrgId, async (client) => {
      const rows = await FragmentsStore.listValidatedByOrg(client, lookupOrgId, { kind: "operator" });
      return rows.map((r) => ({ fragmentId: r.fragmentId, kind: r.kind, label: r.label }));
    });
  };

  // Runtime-validity smoke — the final F2 validate gate (Codex HIGH fix). Wires
  // real pnpm + real bundle subprocess invokers so an authored fragment declaring
  // `next@^99.0.0` (or any unresolvable dep) is REJECTED at authoring time
  // instead of persisting as `validated` and detonating at project bootstrap.
  // Absent this wiring the runtime step is silently skipped (see
  // `fragmentAuthoringRun.ts:487`) — that was the bug PR #789 shipped as. The
  // bundle invoker returns `unavailable` when `bundle` isn't on PATH; the smoke
  // then falls back to the Gemfile syntax check, so wiring it unconditionally
  // costs nothing on hosts without ruby.
  const runtimeValiditySmoke = buildLiveRuntimeValiditySmokeDeps();

  return { authorer, persistence, events, priorFragmentsLookup, runtimeValiditySmoke };
}

/** Build the live per-fragment authoring seam for ONE (orgId) context. */
export function buildLiveRunFragmentAuthoring(
  deps: FragmentAuthoringFlowDeps,
  ctx: { orgId: string },
): FragmentAuthoring {
  return buildFragmentAuthoring(buildLiveFragmentAuthoringDeps(deps, ctx));
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
