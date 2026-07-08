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
// PR #795 landed `buildLivePipInvoker` / `buildLiveGoInvoker` /
// `buildLiveCargoInvoker` for Python/Go/Rust fragments but did NOT wire them
// either — same class of bug in a new dimension (Codex round-III H2). A
// Python fragment declaring `fastapi==999.999.999` passed the shallow
// pyproject.toml sniff (structural sections only, no resolvability) and
// persisted as validated. This test now pins ALL five invoker slots so a
// future refactor can't silently regress any of them.
//
// This test pins the live-wiring contract:
//   1. `buildLiveRuntimeValiditySmokeDeps()` returns a non-undefined shape
//      populated with all five invokers (pnpm + bundle + pip + go + cargo).
//   2. `buildLiveFragmentAuthoringDeps(...)` (the extracted deps-assembly
//      helper `buildLiveRunFragmentAuthoring` delegates to) threads the
//      runtime-validity smoke into the `FragmentAuthoringDeps` shape so
//      `buildFragmentAuthoring` actually runs the runtime step.
//   3. Removing any of the five invokers from the assembly fails the test
//      loud — a future refactor that deletes the wiring reproduces the
//      PR #789 / PR #795 dead-code bug in code review, not in an apex-run
//      halt.

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
  it("buildLiveRuntimeValiditySmokeDeps returns a populated shape (all five invokers wired)", () => {
    const smoke = buildLiveRuntimeValiditySmokeDeps();
    // The whole thing is populated — the bug was `undefined`.
    expect(smoke).toBeDefined();
    // pnpmInvoker is REQUIRED on the deps shape — a missing one bypasses the
    // runtime-validity step entirely for node-pnpm fragments, which was the
    // PR #789 apex-blocking bug.
    expect(smoke.pnpmInvoker).toBeInstanceOf(Function);
    // The four non-Node invokers are optional on the TS type but the prod
    // wiring supplies them all: each returns `unavailable` when its binary
    // isn't on PATH, so the smoke then falls back to the shallow manifest
    // sniff for that runtime — wiring them unconditionally costs nothing on
    // a host that lacks ruby/python/go/rust. Codex round-III H2: PR #795
    // shipped these factories but no prod call site wired them, so
    // Python/Go/Rust fragments passed the shallow sniff (structural
    // sections only) with unresolvable deps like `fastapi==999.999.999`.
    // Each slot asserted individually so a diff that drops ANY ONE trips
    // this test rather than the whole class silently regressing again.
    expect(smoke.bundleInvoker).toBeInstanceOf(Function);
    expect(smoke.pipInvoker).toBeInstanceOf(Function);
    expect(smoke.goInvoker).toBeInstanceOf(Function);
    expect(smoke.cargoInvoker).toBeInstanceOf(Function);
  });

  it("buildLiveFragmentAuthoringDeps wires runtimeValiditySmoke into the FragmentAuthoringDeps shape", () => {
    const deps = buildLiveFragmentAuthoringDeps(flowDeps(), { orgId: "test-org" });
    // PR #789's bug in one assertion: the runtime-validity slot was
    // undefined ⇒ `fragmentAuthoringRun.ts:487` silently returned OK.
    expect(deps.runtimeValiditySmoke).toBeDefined();
    // Guard against `runtimeValiditySmoke: {}` (a shape that satisfies TS
    // exact-types but leaves the invokers off) — every one of the five
    // invoker slots must be present or the corresponding runtime branch is
    // a no-op. PR #795 shipped the non-Node factories but no prod wiring
    // call, so Python/Go/Rust fragments silently degraded to the shallow
    // manifest sniff. Assert each slot independently so a future refactor
    // that legitimately drops one has to update THIS specific assertion.
    expect(deps.runtimeValiditySmoke?.pnpmInvoker).toBeInstanceOf(Function);
    expect(deps.runtimeValiditySmoke?.bundleInvoker).toBeInstanceOf(Function);
    expect(deps.runtimeValiditySmoke?.pipInvoker).toBeInstanceOf(Function);
    expect(deps.runtimeValiditySmoke?.goInvoker).toBeInstanceOf(Function);
    expect(deps.runtimeValiditySmoke?.cargoInvoker).toBeInstanceOf(Function);
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
    // Round-III H1: `deleteById` is the retract seam the batch-compose retract
    // calls to hard-delete a fragment row when the augmented library fails to
    // compose. A future refactor that drops this wiring must fail this test
    // loud rather than silently regressing to the "leave the row + emit failed"
    // shape (which contaminated the org's library cross-run).
    expect(deps.persistence.deleteById).toBeInstanceOf(Function);
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
