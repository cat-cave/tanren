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
import type { ReviewMergeRunContext } from "../src/engine/workflow/reviewMerge/context.js";
import type { PullRequestMergeability } from "../src/engine/contracts/vcsProvider.js";
import type { LandFinalizer } from "../src/engine/merge/mergeAuthorityImpl.js";
import type { AuditPosture } from "../src/engine/contracts/auditPosture.js";

const REPO = { owner: "o", name: "r" };
const POSTURE: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };

function mergeability(state: PullRequestMergeability["state"]): PullRequestMergeability {
  return { state, behind: state === "behind", baseBranch: "main", headBranch: "feat" };
}

/** A probe whose mergeability is `dirty` first (to trigger the conflict), then scripted. */
function scriptedProbe(postResolution: PullRequestMergeability["state"]): MergeProbe & { mergeCalls: number } {
  let read = 0;
  const probe = {
    mergeCalls: 0,
    // first read (ensureUpToDate) → dirty → conflict; subsequent (driveLand) → scripted.
    readMergeability: async (): Promise<PullRequestMergeability> => {
      read += 1;
      return mergeability(read === 1 ? "dirty" : postResolution);
    },
    merge: async () => {
      probe.mergeCalls += 1;
      return { merged: true, mergeSha: "host-merge-sha", conflict: false, status: 200, message: "ok" };
    },
    updateBranch: async () => ({ outcome: "up_to_date" as const, message: "" }),
    retargetBase: async () => {},
    deleteIntegrationBranch: async () => {},
  };
  return probe;
}

/** A recording event store (captures appended event types). */
function recordingEventStore() {
  const events: string[] = [];
  return { events, append: async (input: { eventType: string }) => void events.push(input.eventType) };
}

/** A fake pool (no DB): the task-finalize UPDATEs are no-ops here. */
const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };

/** The §5 finalizer: records land (or throws for the merge_state_unknown case). */
function fakeFinalizer(opts: { fail?: boolean; landed: string[] }): LandFinalizer {
  return {
    finalizeLanded: async (input) => {
      if (opts.fail) throw new Error("durable finalize failed");
      opts.landed.push(input.mainSha);
      return { auditId: "audit_1" };
    },
  };
}

interface BundleOverrides {
  reviewVerdict?: MergeAuthorityBundle["reviewVerdict"];
  /** Override the gate outcome — `null` ⇒ a failing/absent gate (blocks). */
  gateOutcome?: MergeAuthorityBundle["gateOutcome"] | null;
  fail?: boolean;
  landed: string[];
}

function bundle(host: InMemoryCodeHost, o: BundleOverrides): MergeAuthorityBundle {
  const gateOutcome = o.gateOutcome === null ? undefined : (o.gateOutcome ?? { passed: true, results: [] });
  return {
    codeHost: host,
    orgId: "org_1",
    finalizerFor: () => fakeFinalizer({ fail: o.fail ?? false, landed: o.landed }),
    gateConfigHash: "gc",
    policyVersion: "pv",
    gateOutcome,
    findings: [],
    auditPosture: POSTURE,
    reviewVerdict: o.reviewVerdict ?? "approved",
    budget: { ceilingUsd: undefined, spentUsd: 0 },
    demo: "not_required",
    hitlSignoff: "not_required",
  };
}

function context(): ReviewMergeRunContext {
  return {
    runId: "run_1",
    specId: "spec_1",
    projectId: "proj_1",
    prUrl: "https://github.com/o/r/pull/1",
    baseBranch: "main",
    mergeIntegration: "direct_merge",
    governancePosture: "open",
    policyVersion: 1,
    reviewPolicy: "auto",
    tanrenLogins: [],
    platformLogins: [],
  };
}

/** A `reGateCi` hook returning the given pre_merge gate status (the resolved-tree gate). */
type ReGateStatus = "passed" | "failed" | "pending";
function reGate(status: ReGateStatus): () => Promise<{ status: ReGateStatus }> {
  return async () => ({ status });
}

function dispatcher(
  probe: MergeProbe,
  events: ReturnType<typeof recordingEventStore>,
  b: MergeAuthorityBundle,
  reGateStatus: ReGateStatus = "passed",
): MergeDispatcher {
  const input = {
    pool: fakePool,
    secrets: {},
    vcsProvider: {},
    runId: "run_1",
    resolveConflict: async () => ({ resolved: true }),
    // The resolved-tree pre_merge re-gate (§5): defaults to passing so the
    // authority then judges the OTHER fail-closed inputs. A test overrides it.
    reGateCi: reGate(reGateStatus),
    mergeAuthority: b,
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
  return new MergeDispatcher(deps);
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
    vcsProvider: {},
    runId: "run_1",
    resolveConflict: async () => ({ resolved: true }),
    // The resolved-tree pre_merge re-gate runs BEFORE the lazy bundle build.
    reGateCi: reGate(reGateStatus),
    buildMergeAuthority: async () => {
      state.builds += 1;
      return buildBundle();
    },
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
    // nothing landed; main was NEVER advanced, and the host PR-merge API was never called.
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
    expect(probe.mergeCalls).toBe(0);
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

  it("a clean conflict-resolved land goes through the writer-backed finalizer (one transaction)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // the resolution made the branch clean — the authority authorizes + lands.
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    const result = await dispatcher(probe, events, bundle(host, { landed })).directMerge();

    expect(result.outcome).toBe("merged");
    // The land went through the ff-only CAS (main advanced to the authorized head),
    // and the §5 finalizer recorded the land — NOT probe.merge().
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");
    expect(landed).toEqual(["sha-feat"]);
    expect(probe.mergeCalls).toBe(0);
  });

  it("a post-land durable-write failure on the conflict-resolved path → merge_state_unknown (never silent)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    const result = await dispatcher(probe, events, bundle(host, { fail: true, landed })).directMerge();

    // The host land fired (main advanced) but the durable record FAILED → the
    // dispatcher holds it as a recoverable conflict carrying the reconcile reason,
    // NEVER a silent merged/inconsistency. main DID advance (the external land fired).
    expect(result.outcome).toBe("conflict");
    expect(result.message).toMatch(/merge_state_unknown|durable finalize/u);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");
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

  it("REGRESSION LOCK (a): flag ON + NO bundle → BLOCKED, NEVER probe.merge (no silent host-merge fallback)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    // A CLEAN branch (no conflict) so directMerge goes straight to driveLand — with the
    // authority live but NEITHER a pre-built bundle NOR a builder → fail-closed BLOCK,
    // never a fall-through to landViaHostMerge (probe.merge).
    const probe = scriptedProbe("clean");
    // Override mergeability to always `clean` (no conflict) so directMerge → driveLand
    // directly. The `merge` closure still mutates the original `probe.mergeCalls`.
    const cleanProbe = { ...probe, readMergeability: async () => mergeability("clean") } as MergeProbe;
    const events = recordingEventStore();
    const input = {
      pool: fakePool,
      secrets: {},
      vcsProvider: {},
      runId: "run_1",
      resolveConflict: async () => ({ resolved: true }),
      // NO mergeAuthority, NO buildMergeAuthority — the authority is live (default flag).
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
    // NEVER the legacy host-merge: probe.merge was not called, main untouched.
    expect(probe.mergeCalls).toBe(0);
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
    expect(probe.mergeCalls).toBe(0);
    expect(events.events).not.toContain("merge.completed");
  });

  it("REGRESSION LOCK (c): resolved-tree fresh pre_merge re-gate PASSES → lands via the authority + CAS + finalizer", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const probe = scriptedProbe("clean");
    const events = recordingEventStore();
    const landed: string[] = [];
    // The resolved-tree pre_merge re-gate PASSES → the authority authorizes + lands via
    // the ff-only CAS + the §5 finalizer (not probe.merge).
    const result = await dispatcher(probe, events, bundle(host, { landed }), "passed").directMerge();

    expect(result.outcome).toBe("merged");
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat");
    expect(landed).toEqual(["sha-feat"]);
    expect(probe.mergeCalls).toBe(0);
  });
});
