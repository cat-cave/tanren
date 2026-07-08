// REGRESSION: prod wiring for the F2 runtime-validity smoke (Codex HIGH fix).
//
// PR #789 shipped `buildLivePnpmInvoker` / `buildLiveBundleInvoker` +
// `runRuntimeValiditySmoke` but never wired them into the production
// `buildLiveRunFragmentAuthoring` factory — so `fragmentAuthoringRun.ts` fell
// through the `args.runtimeValiditySmoke === undefined` branch and silently
// returned `{ kind: "ok" }`. A fragment declaring `next@^99.0.0` therefore
// passed authoring and persisted as `validated`; the real project detonated
// only at project bootstrap when the writer ran `pnpm install`. One full
// apex trial burned.
//
// This test pins the live-wiring contract:
//   1. `buildLiveRuntimeValiditySmokeDeps()` returns a non-undefined shape
//      populated with both pnpm + bundle invokers.
//   2. `buildLiveFragmentAuthoringDeps(...)` (the extracted deps-assembly
//      helper `buildLiveRunFragmentAuthoring` delegates to) threads the
//      runtime-validity smoke into the `FragmentAuthoringDeps` shape so
//      `buildFragmentAuthoring` actually runs the runtime step.
//   3. Removing either invoker from the assembly fails the test loud — a
//      future refactor that deletes the wiring reproduces PR #789's dead-code
//      bug in code review, not in an apex-run halt.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { EventStore } from "../src/engine/eventStore.js";
import type { FragmentAuthorer } from "../src/engine/templates/index.js";
import {
  buildLiveFragmentAuthoringDeps,
  buildLiveRuntimeValiditySmokeDeps,
  type FragmentAuthoringFlowDeps,
} from "../src/routes/onboarding/index.js";

/** A pool shim — the deps-assembly path only stores the reference; the pool
 * is not opened here (persistence + priorFragmentsLookup close over it but
 * neither is invoked in this test). */
function poolShim(): pg.Pool {
  return {} as unknown as pg.Pool;
}

/** A recording event-store shim satisfying the required-eventStore guard. */
function eventStoreShim(): EventStore {
  return {
    async append() {
      /* no-op */
    },
  };
}

/** A no-op authorer — the assembly reads the reference; the authorer is not
 * invoked in this test. */
function authorerShim(): FragmentAuthorer {
  return async () => ({ bodyTs: "" });
}

function flowDeps(): FragmentAuthoringFlowDeps {
  return {
    pool: poolShim(),
    eventStore: eventStoreShim(),
    authorer: authorerShim(),
  };
}

describe("F2 prod wiring — runtime-validity smoke reaches buildFragmentAuthoring", () => {
  it("buildLiveRuntimeValiditySmokeDeps returns a populated shape (both invokers wired)", () => {
    const smoke = buildLiveRuntimeValiditySmokeDeps();
    // The whole thing is populated — the bug was `undefined`.
    expect(smoke).toBeDefined();
    // pnpmInvoker is REQUIRED on the deps shape — a missing one bypasses the
    // runtime-validity step entirely for node-pnpm fragments, which was the
    // apex-blocking bug.
    expect(smoke.pnpmInvoker).toBeInstanceOf(Function);
    // bundleInvoker is optional on the shape but the prod wiring supplies it
    // (returns `unavailable` when `bundle` isn't on PATH; the smoke then
    // falls back to the Gemfile syntax check, so wiring it unconditionally
    // costs nothing on hosts without ruby). A future refactor that
    // legitimately drops the bundle invoker needs to update this assertion.
    expect(smoke.bundleInvoker).toBeInstanceOf(Function);
  });

  it("buildLiveFragmentAuthoringDeps wires runtimeValiditySmoke into the FragmentAuthoringDeps shape", () => {
    const deps = buildLiveFragmentAuthoringDeps(flowDeps(), { orgId: "test-org" });
    // PR #789's bug in one assertion: the runtime-validity slot was
    // undefined ⇒ `fragmentAuthoringRun.ts:487` silently returned OK.
    expect(deps.runtimeValiditySmoke).toBeDefined();
    // Guard against `runtimeValiditySmoke: {}` (a shape that satisfies TS
    // exact-types but leaves the pnpm gate off) — the pnpm invoker must be
    // present or the runtime step's node-pnpm branch is a no-op.
    expect(deps.runtimeValiditySmoke?.pnpmInvoker).toBeInstanceOf(Function);
    // Bundle invoker likewise: absent ⇒ ruby-bundler fragments fall back to
    // the Gemfile syntax heuristic, which misses the whole class of
    // resolvable-but-unavailable bundler errors. Live wiring supplies both.
    expect(deps.runtimeValiditySmoke?.bundleInvoker).toBeInstanceOf(Function);
  });

  it("buildLiveFragmentAuthoringDeps populates every REQUIRED slot on FragmentAuthoringDeps", () => {
    // Belt to the above: guard the WHOLE deps shape so a future refactor that
    // drops any live slot (authorer / persistence / events /
    // priorFragmentsLookup / runtimeValiditySmoke) trips this test rather
    // than silently downgrading the prod authoring loop.
    const deps = buildLiveFragmentAuthoringDeps(flowDeps(), { orgId: "test-org" });
    expect(deps.authorer).toBeInstanceOf(Function);
    expect(deps.persistence).toBeDefined();
    expect(deps.persistence.createValidated).toBeInstanceOf(Function);
    expect(deps.events).toBeDefined();
    expect(deps.events.emit).toBeInstanceOf(Function);
    expect(deps.priorFragmentsLookup).toBeInstanceOf(Function);
    expect(deps.runtimeValiditySmoke).toBeDefined();
  });

  it("buildLiveFragmentAuthoringDeps throws loud on a missing eventStore (silent-degradation banned)", () => {
    // Matches the guard `buildLiveRunFragmentAuthoring` used to carry; the
    // extract preserved the loud-throw so an erased-type caller can't silently
    // drop the emit path.
    expect(() =>
      buildLiveFragmentAuthoringDeps(
        {
          pool: poolShim(),
          eventStore: undefined as unknown as EventStore,
          authorer: authorerShim(),
        },
        { orgId: "test-org" },
      ),
    ).toThrow(/eventStore.*required/u);
  });
});
