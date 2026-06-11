// Shared fixtures for the merge-dispatcher conflict-authority tests (the §5 land
// decision + the §7 apex-stall #1 lock), extracted so both
// `mergeDispatcherConflictAuthority.test.ts` and
// `mergeDispatcherConflictAuthority.apexStall.test.ts` stay under the 500-line cap
// and share ONE no-DB harness (the same scripted probe, recording event store,
// fake finalizer, authority bundle, run context, and re-gate hook).

import { MergeDispatcher, type DispatcherDeps } from "../../src/engine/workflow/reviewMerge/mergeDispatcher.js";
import type { InMemoryCodeHost } from "../conformance/fakes/inMemoryCodeHost.js";
import type {
  MergeAuthorityBundle,
  MergeForRunInput,
  MergeProbe,
} from "../../src/engine/workflow/reviewMerge/index.js";
import type { ReviewMergeRunContext } from "../../src/engine/workflow/reviewMerge/context.js";
import type { PullRequestMergeability } from "../../src/engine/contracts/vcsProvider.js";
import type { LandFinalizer } from "../../src/engine/merge/mergeAuthorityImpl.js";
import type { AuditPosture } from "../../src/engine/contracts/auditPosture.js";

export const REPO = { owner: "o", name: "r" };
export const POSTURE: AuditPosture = { blockReviewAt: "P1", p2p3Handling: "route-to-dag" };

export function mergeability(state: PullRequestMergeability["state"]): PullRequestMergeability {
  return { state, behind: state === "behind", baseBranch: "main", headBranch: "feat" };
}

/**
 * A probe whose freshness is `behind` first (so `ensureUpToDate` routes to the unified
 * `baseShiftRebase` — which the dispatcher wires to surface a `conflict`, §5h), then the
 * scripted post-resolution state the land authority re-judges.
 */
export function scriptedProbe(postResolution: PullRequestMergeability["state"]): MergeProbe {
  let read = 0;
  return {
    // first read (ensureUpToDate) → behind → unified rebase surfaces a conflict; subsequent
    // (driveLand → land) → the scripted post-resolution state.
    readFreshness: async (): Promise<PullRequestMergeability> => {
      read += 1;
      return mergeability(read === 1 ? "behind" : postResolution);
    },
    readBaseBranch: async () => "main",
    retargetBase: async () => {},
  };
}

/** A recording event store (captures appended event types). */
export function recordingEventStore() {
  const events: string[] = [];
  return { events, append: async (input: { eventType: string }) => void events.push(input.eventType) };
}

/** A fake pool (no DB): the task-finalize UPDATEs are no-ops here. */
export const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) };

/** The §5 finalizer: records land (or throws for the merge_state_unknown case). */
export function fakeFinalizer(opts: { fail?: boolean; landed: string[] }): LandFinalizer {
  return {
    finalizeLanded: async (input) => {
      if (opts.fail) throw new Error("durable finalize failed");
      opts.landed.push(input.mainSha);
      return { auditId: "audit_1" };
    },
  };
}

export interface BundleOverrides {
  reviewVerdict?: MergeAuthorityBundle["reviewVerdict"];
  /** Override the gate outcome — `null` ⇒ a failing/absent gate (blocks). */
  gateOutcome?: MergeAuthorityBundle["gateOutcome"] | null;
  /** The sha the gate verdict was FOR — defaults to the landed head (`sha-feat`). */
  gatedHeadSha?: string;
  fail?: boolean;
  landed: string[];
}

export function bundle(host: InMemoryCodeHost, o: BundleOverrides): MergeAuthorityBundle {
  const gateOutcome = o.gateOutcome === null ? undefined : (o.gateOutcome ?? { passed: true, results: [] });
  return {
    codeHost: host,
    orgId: "org_1",
    finalizerFor: () => fakeFinalizer({ fail: o.fail ?? false, landed: o.landed }),
    gateConfigHash: "gc",
    policyVersion: "pv",
    gateOutcome,
    // The gate verdict was for the landed head (`sha-feat`) unless overridden (TOCTOU lock).
    gatedHeadSha: o.gatedHeadSha ?? "sha-feat",
    findings: [],
    auditPosture: POSTURE,
    reviewVerdict: o.reviewVerdict ?? "approved",
    budget: { ceilingUsd: undefined, spentUsd: 0 },
    demo: "not_required",
    hitlSignoff: "not_required",
  };
}

export function context(): ReviewMergeRunContext {
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
export type ReGateStatus = "passed" | "failed" | "pending";
export function reGate(status: ReGateStatus): () => Promise<{ status: ReGateStatus }> {
  return async () => ({ status });
}

/**
 * A counting conflict-resolver hook (apex-stall lock): records EVERY invocation so a
 * test can assert the resolver fires EXACTLY ONCE, never the 90× retry loop.
 */
export function countingResolver(resolved: boolean): {
  hook: () => Promise<{ resolved: boolean }>;
  calls: () => number;
} {
  let calls = 0;
  return {
    hook: async () => {
      calls += 1;
      return { resolved };
    },
    calls: () => calls,
  };
}

/**
 * Build an authority-gated `MergeDispatcher` over the no-DB harness, with an optional
 * injected conflict resolver + re-gate status. Defaults mirror the production land
 * wiring: a `resolved:true` resolver and a passing resolved-tree re-gate, so a test
 * overrides only the input it is asserting on.
 */
export function buildDispatcher(args: {
  probe: MergeProbe;
  events: ReturnType<typeof recordingEventStore>;
  bundle: MergeAuthorityBundle;
  integration?: "direct_merge" | "native_queue";
  reGateStatus?: ReGateStatus;
  resolveConflict?: () => Promise<{ resolved: boolean }>;
}): MergeDispatcher {
  const input = {
    pool: fakePool,
    secrets: {},
    vcsProvider: {},
    runId: "run_1",
    resolveConflict: args.resolveConflict ?? (async () => ({ resolved: true })),
    // The resolved-tree pre_merge re-gate (§5): defaults to passing so the authority
    // then judges the OTHER fail-closed inputs. A test overrides it.
    reGateCi: reGate(args.reGateStatus ?? "passed"),
    // §5h: the `behind` freshness routes through the unified base-shift hook, which surfaces
    // the CONFLICT (jj owns conflict — never a `mergeable_state` `dirty` read). This is what
    // drives the conflict-resolved land flow the regression locks assert.
    baseShiftRebase: async () => ({ outcome: "conflict" as const, message: "branch conflicts with base" }),
    mergeAuthority: args.bundle,
  } as unknown as MergeForRunInput;
  const deps: DispatcherDeps = {
    input,
    context: context(),
    eventStore: args.events as never,
    taskId: "task_1",
    integration: args.integration ?? "direct_merge",
    pr: { repo: REPO, pullNumber: 1 },
    probe: args.probe,
  };
  return new MergeDispatcher(deps);
}
