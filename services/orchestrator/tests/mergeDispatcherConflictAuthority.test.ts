// REGRESSION LOCK (Codex P0): the conflict-resolved land path must go through the
// SAME `MergeAuthority` (`prepareIntegration → authorizeLand → land`) as every other
// merge — NEVER `probe.merge()` + a hand-rolled `merge.completed` (the surviving
// parallel merge authority that fail-OPENed past a blocking land-time state and lost
// the §5 transactional finalizer). After a successful conflict resolution the land
// re-enters `driveLand`, which re-reads mergeability + re-judges the fail-closed
// inputs. This drives the REAL `MergeDispatcher.directMerge` (no DB): a `dirty` branch
// → resolver `resolved:true` → the authority land decision.

import { describe, expect, it } from "vitest";
import { MergeDispatcher, type DispatcherDeps } from "../src/engine/workflow/reviewMerge/mergeDispatcher.js";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import type { MergeAuthorityBundle, MergeForRunInput, MergeProbe } from "../src/engine/workflow/reviewMerge/index.js";
import {
  REPO,
  bundle,
  buildDispatcher,
  context,
  fakePool,
  mergeability,
  noopFinalizeWriter,
  reGate,
  recordingEventStore,
  scriptedProbe,
  type ReGateStatus,
} from "./fixtures/mergeDispatcherConflictFixtures.js";

/**
 * The §5 land path with the default (`resolved:true`) conflict resolver — the
 * authority-gated `direct_merge` dispatcher every test below the lazy-thunk cases
 * uses. Wraps the shared `buildDispatcher` (tests/fixtures) with the parent file's
 * positional signature so the existing call sites read unchanged.
 */
function dispatcher(
  probe: MergeProbe,
  events: ReturnType<typeof recordingEventStore>,
  b: MergeAuthorityBundle,
  reGateStatus: ReGateStatus = "passed",
): MergeDispatcher {
  return buildDispatcher({ probe, events, bundle: b, reGateStatus });
}

/**
 * A dispatcher whose authority bundle is built LAZILY (the `buildMergeAuthority` thunk
 * — the production wiring): the dispatcher invokes it inside `driveLand`, AFTER the
 * conflict resolver ran. `buildBundle` is what production's `buildBundleForMergeStage`
 * does (re-read FRESH land-time signals), so a thunk that reflects post-resolution
 * state proves the land authorizes against land-time, not pre-conflict, inputs.
 */
function dispatcherLazy(
  probe: MergeProbe,
  events: ReturnType<typeof recordingEventStore>,
  buildBundle: () => Promise<MergeAuthorityBundle>,
  reGateStatus: ReGateStatus = "passed",
): { dispatcher: MergeDispatcher; builds: () => number } {
  const state = { builds: 0 };
  const input = {
    pool: fakePool,
    secrets: {},
    githubHttp: {},
    runId: "run_1",
    resolveConflict: async () => ({ resolved: true }),
    // The resolved-tree pre_merge re-gate runs BEFORE the lazy bundle build.
    reGateCi: reGate(reGateStatus),
    // §5h: the `behind` freshness routes through the unified base-shift hook → conflict.
    baseShiftRebase: async () => ({ outcome: "conflict" as const, message: "branch conflicts with base" }),
    buildMergeAuthority: async () => {
      state.builds += 1;
      return buildBundle();
    },
    // Audit finding D3 sweep: the dispatcher's finalize REQUIRES a writer.
    runStateWriter: noopFinalizeWriter(),
  } as unknown as MergeForRunInput;
  const deps: DispatcherDeps = {
    input,
    context: context(),
    eventStore: events as never,
    taskId: "task_1",
    integration: "direct_merge",
    pr: { repo: REPO, pullNumber: 1 },
    probe,
  };
  return { dispatcher: new MergeDispatcher(deps), builds: () => state.builds };
}

describe("conflict-resolved land re-enters the MergeAuthority (no parallel merge authority)", () => {
  it("REGRESSION LOCK: resolved:true BUT mergeability:'unknown' at land time → BLOCKED (not merged), probe.merge NEVER called", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // post-resolution mergeability is uncertain — the authority blocks on non-clean.
    const probe = scriptedProbe("unknown");
    const events = recordingEventStore();
    const landed: string[] = [];
    const result = await dispatcher(probe, events, bundle(host, { landed })).directMerge();

    // The authority BLOCKED the land (mergeability unknown only clears on `clean`).
    expect(result.outcome).not.toBe("merged");
    // nothing landed; main was NEVER advanced.
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    // A hand-rolled `merge.completed` was NOT appended on the resolved path.
    expect(events.events).not.toContain("merge.completed");
  });

  it("REGRESSION LOCK: resolved:true BUT review:'changes_requested' at land time → needs_attention/blocked (not merged)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // mergeability clears, but the review verdict blocks the land.
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    const result = await dispatcher(
      probe,
      events,
      bundle(host, { reviewVerdict: "changes_requested", landed }),
    ).directMerge();

    expect(result.outcome).not.toBe("merged");
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(events.events).not.toContain("merge.completed");
  });

  it("a clean conflict-resolved legacy attempt holds for canonical queue authority", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // The resolution made the branch clean, but a raw PR no longer produces an
    // integration-node/proof binding for the authority.
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    const result = await dispatcher(probe, events, bundle(host, { landed })).directMerge();

    expect(result.outcome).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(landed).toEqual([]);
  });

  it("a post-land durable-write seam is unreachable without canonical queue authority", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    const result = await dispatcher(probe, events, bundle(host, { fail: true, landed })).directMerge();

    // Without a persisted node and matching proof, the host CAS and its receipt
    // finalizer are both unreachable; this must hold instead of faking a direct land.
    expect(result.outcome).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(events.events).not.toContain("merge.completed");
  });

  it("REGRESSION LOCK (fresh land-time gate): gate passed PRE-conflict but the FRESH land-time gate FAILS → BLOCKED", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // mergeability clears post-resolution; the conflict resolved `true`.
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    // The bundle is built LAZILY (the production thunk), AFTER the resolver ran — and
    // the FRESH land-time gate now FAILS (a re-gate during resolution flipped it). This
    // mirrors `buildBundleForMergeStage` re-reading the latest gate.verdict: the
    // pre-conflict passing gate is NOT used; the land-time failing gate blocks.
    const lazy = dispatcherLazy(probe, events, async () => bundle(host, { gateOutcome: null, landed }));
    const result = await lazy.dispatcher.directMerge();

    expect(result.outcome).not.toBe("merged");
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    // The bundle was built at LAND time (after resolution), not pre-conflict.
    expect(lazy.builds()).toBe(1);
    expect(events.events).not.toContain("merge.completed");
  });

  it("REGRESSION LOCK (fresh land-time review): review flipped to changes_requested during resolution → BLOCKED", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    // The FRESH land-time review (built lazily after resolution) is changes_requested —
    // the pre-conflict `approved` is NOT used.
    const lazy = dispatcherLazy(probe, events, async () =>
      bundle(host, { reviewVerdict: "changes_requested", landed }),
    );
    const result = await lazy.dispatcher.directMerge();

    expect(result.outcome).not.toBe("merged");
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(lazy.builds()).toBe(1);
    expect(events.events).not.toContain("merge.completed");
  });

  it("REGRESSION LOCK (a): NO bundle → fail-closed BLOCK, NEVER a land (no silent host-merge fallback)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // A CLEAN branch (no conflict) so directMerge goes straight to driveLand — with
    // NEITHER a pre-built bundle NOR a builder → fail-closed BLOCK (the now-unconditional
    // safety): the land is the SOLE authority path, never a fall-through that lands.
    const probe = scriptedProbe("clean");
    // Override freshness to always `clean` (no rebase) so directMerge → driveLand.
    const cleanProbe = { ...probe, readFreshness: async () => mergeability("clean") } as MergeProbe;
    const events = recordingEventStore();
    const input = {
      pool: fakePool,
      secrets: {},
      githubHttp: {},
      runId: "run_1",
      resolveConflict: async () => ({ resolved: true }),
      // NO mergeAuthority, NO buildMergeAuthority — the authority is live (default flag).
      // Audit finding D3 sweep: dispatcher.finalize REQUIRES a writer.
      runStateWriter: noopFinalizeWriter(),
    } as unknown as MergeForRunInput;
    const deps: DispatcherDeps = {
      input,
      context: context(),
      eventStore: events as never,
      taskId: "task_1",
      integration: "direct_merge",
      pr: { repo: REPO, pullNumber: 1 },
      probe: cleanProbe,
    };
    const result = await new MergeDispatcher(deps).directMerge();

    expect(result.outcome).not.toBe("merged");
    // NEVER a host-merge fallthrough: main untouched, no completion recorded.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(events.events).not.toContain("merge.completed");
  });

  it("REGRESSION LOCK (b): resolved-tree fresh pre_merge RE-GATE FAILS → BLOCKED (lands on the resolved tree, not the stale pre-conflict pass)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    // The conflict resolves true, but the FRESH pre_merge re-gate on the RESOLVED TREE
    // FAILS — even though the bundle's gate (the stale pre-conflict pre_merge pass)
    // would clear. The resolved-tree gate blocks the land BEFORE authorization.
    const result = await dispatcher(probe, events, bundle(host, { landed }), "failed").directMerge();

    expect(result.outcome).not.toBe("merged");
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(events.events).not.toContain("merge.completed");
  });

  it("REGRESSION LOCK (c): resolved-tree fresh pre_merge re-gate PASSES but raw PR land still holds", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    // A passing re-gate is necessary but insufficient: it cannot stand in for the
    // persisted canonical node and proof.
    const result = await dispatcher(probe, events, bundle(host, { landed }), "passed").directMerge();

    expect(result.outcome).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(landed).toEqual([]);
  });

  it("TOCTOU LOCK: fresh pre_merge gate PASSED for sha A, head advanced to sha B before land → BLOCKED (gate is commit-bound)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    // The PR head ADVANCED to sha-B after the fresh pre_merge gate passed for sha-A.
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-B" });
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    // The bundle's gate is for sha-A (the OLD head), but the head being landed is sha-B
    // → the commit-binding blocks the land (no un-gated commit lands).
    const result = await dispatcher(
      probe,
      events,
      bundle(host, { landed, gatedHeadSha: "sha-A" }),
      "passed",
    ).directMerge();

    expect(result.outcome).not.toBe("merged");
    expect(landed).toEqual([]);
    // sha-B (un-gated) was NEVER landed; main untouched.
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(events.events).not.toContain("merge.completed");
  });

  it("TOCTOU LOCK: gate PASSED for the CURRENT head still needs the canonical node/proof binding", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    // gatedHeadSha === the live head clears the preserved guard, but raw PR state
    // never becomes a synthetic authority subject.
    const result = await dispatcher(probe, events, bundle(host, { landed }), "passed").directMerge();

    expect(result.outcome).toBe("blocked");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(landed).toEqual([]);
  });
});
