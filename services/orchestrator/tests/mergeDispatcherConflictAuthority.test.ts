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
  fail?: boolean;
  landed: string[];
}

function bundle(host: InMemoryCodeHost, o: BundleOverrides): MergeAuthorityBundle {
  return {
    codeHost: host,
    orgId: "org_1",
    finalizerFor: () => fakeFinalizer({ fail: o.fail ?? false, landed: o.landed }),
    gateConfigHash: "gc",
    policyVersion: "pv",
    gateOutcome: { passed: true, results: [] },
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

function dispatcher(
  probe: MergeProbe,
  events: ReturnType<typeof recordingEventStore>,
  b: MergeAuthorityBundle,
): MergeDispatcher {
  const input = {
    pool: fakePool,
    secrets: {},
    vcsProvider: {},
    runId: "run_1",
    resolveConflict: async () => ({ resolved: true }),
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
});
