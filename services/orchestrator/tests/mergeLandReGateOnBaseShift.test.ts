// V42 STRAND-THE-DEPENDENTS LOCK (tanren-owns-the-engine.md §5 commit-binding): after a
// never-discard base-shift jj-rebases a DEPENDENT onto a merged ancestor, the PR head
// ADVANCES but the branch is now CURRENT with main — so the `behind` auto-rebase never
// fires — while the gate VERDICT is still for the PRE-base-shift commit. The authority's
// commit-binding (gatedHeadSha === landingHead, the §5 "never land an un-gated commit"
// guarantee) then fail-closes FOREVER with no re-gate trigger: the dependent + every
// descendant strand. The fix RE-GATES the current head when it differs from the gated
// commit (for ANY reason), reusing the #601 re-gate machinery, so the fresh verdict binds
// to the landing commit and the land proceeds fail-closed-CORRECT.
//
// Drives the REAL `MergeDispatcher.directMerge` over the shared no-DB harness + an
// `InMemoryCodeHost`. The §5 guarantee is NOT weakened: these tests prove a passing re-gate
// lands the (now-bound) current head, a FAILING re-gate routes to writer rework (never
// lands), and a non-terminal re-gate holds recoverably (never a stale-verdict land).

import { describe, expect, it } from "vitest";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import type { MergeForRunInput, MergeProbe } from "../src/engine/workflow/reviewMerge/index.js";
import { MergeDispatcher, type DispatcherDeps } from "../src/engine/workflow/reviewMerge/mergeDispatcher.js";
import {
  REPO,
  bundle,
  context,
  fakePool,
  mergeability,
  noopFinalizeWriter,
  recordingEventStore,
} from "./fixtures/mergeDispatcherConflictFixtures.js";

/** A probe that is ALWAYS `clean` (current with main — the post-base-shift dependent). */
function cleanProbe(): MergeProbe {
  return {
    readFreshness: async () => mergeability("clean"),
    readBaseBranch: async () => "main",
    retargetBase: async () => {},
  };
}

type ReGateResult = { status: "passed" | "failed" | "pending"; gateError?: string };

/**
 * Build an authority-gated dispatcher straight to the land (clean probe). The bundle's
 * `gatedHeadSha` is set STALE (the pre-base-shift commit) while the live PR head is
 * `sha-feat2` (the base-shift-advanced head) — the exact v42 mismatch. The re-gate hook
 * records the head it was asked to verify so the test can prove it re-gated the CURRENT head.
 */
function buildScenario(args: {
  reGate: () => Promise<ReGateResult>;
  reGateGateRework?: MergeForRunInput["reGateGateRework"];
  rebuildOnReGate?: boolean;
}): {
  dispatcher: MergeDispatcher;
  host: InMemoryCodeHost;
  events: ReturnType<typeof recordingEventStore>;
  landed: string[];
  reGateHeads: Array<string | undefined>;
} {
  const host = new InMemoryCodeHost();
  host.seed(REPO, "main", "sha-main");
  const events = recordingEventStore();
  const landed: string[] = [];
  const reGateHeads: Array<string | undefined> = [];

  const reGateCi: MergeForRunInput["reGateCi"] = async (input) => {
    reGateHeads.push(input?.rebasedHeadSha);
    return args.reGate();
  };
  // The bundle starts gated on the STALE pre-base-shift sha. On rebuild (after a passing
  // re-gate), the fresh verdict is now anchored to the CURRENT head (`sha-feat2`).
  let builds = 0;
  const buildMergeAuthority = async (): Promise<ReturnType<typeof bundle>> => {
    builds += 1;
    return bundle(host, { landed, gatedHeadSha: builds === 1 ? "sha-stale" : "sha-feat2" });
  };

  const input = {
    pool: fakePool,
    secrets: {},
    githubHttp: {},
    runId: "run_1",
    resolveConflict: async () => ({ resolved: true }),
    reGateCi,
    ...(args.reGateGateRework !== undefined && { reGateGateRework: args.reGateGateRework }),
    buildMergeAuthority,
    // Audit finding #5: the dispatcher's finalize requires a writer for the atomic terminal pair.
    runStateWriter: noopFinalizeWriter(),
  } as unknown as MergeForRunInput;
  const deps: DispatcherDeps = {
    input,
    context: context(),
    eventStore: events as never,
    taskId: "task_1",
    integration: "native_queue",
    pr: { repo: REPO, pullNumber: 1 },
    probe: cleanProbe(),
  };
  return { dispatcher: new MergeDispatcher(deps), host, events, landed, reGateHeads };
}

describe("§5 v42: a base-shift-advanced head (gated != current) is RE-GATED then lands", () => {
  it("re-gates the CURRENT head, rebuilds the bundle (gated===landing), and lands", async () => {
    const scenario = buildScenario({ reGate: async () => ({ status: "passed" }) });
    // The base-shift already advanced the live head to `sha-feat2` (current with main).
    await scenario.host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat2" });

    const result = await scenario.dispatcher.directMerge();

    // The re-gate verified the CURRENT head (the base-shift-advanced commit) — NOT the stale
    // gated sha — so the verdict binds to the landing commit (the §5 guarantee, re-gated not bypassed).
    expect(scenario.reGateHeads).toEqual(["sha-feat2"]);
    // The land then proceeded fail-closed-CORRECT (gated === landing after the rebuild).
    expect(result.outcome).toBe("merged");
    expect(scenario.landed).toEqual(["sha-feat2"]);
    expect(await scenario.host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat2");
    // The re-gate trail is observable; no terminal conflict dequeue.
    expect(scenario.events.events).toContain("merge.rebased");
    expect(scenario.events.events).not.toContain("merge.conflict");
  });

  it("a FAILING re-gate on the advanced head routes to WRITER REWORK — never lands a stale verdict", async () => {
    const reworked: Array<{ specId: string; gateError: string }> = [];
    const reGateGateRework: MergeForRunInput["reGateGateRework"] = {
      routeGateFailToRework: async (input) => void reworked.push(input),
    };
    const scenario = buildScenario({
      reGate: async () => ({ status: "failed", gateError: "test tier failed on the shifted base" }),
      reGateGateRework,
    });
    await scenario.host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat2" });

    const result = await scenario.dispatcher.directMerge();

    // §5 PRESERVED: a genuinely-failing re-gate does NOT land — it routes the spec to writer
    // rework (never-discard re-author), recoverable, carrying the gate error as steering.
    expect(reworked).toHaveLength(1);
    expect(reworked[0]?.gateError).toMatch(/test tier failed/u);
    expect(result.outcome).toBe("conflict");
    expect(scenario.landed).toEqual([]);
    expect(await scenario.host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("a NON-TERMINAL re-gate holds recoverably (re_gate_pending) — never lands a stale verdict", async () => {
    const scenario = buildScenario({ reGate: async () => ({ status: "pending" }) });
    await scenario.host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat2" });

    const result = await scenario.dispatcher.directMerge();

    // §5 PRESERVED: a still-running re-gate is a RECOVERABLE re-drive (the coordinator re-runs
    // the gate next tick), not a stale-verdict land and not a terminal dequeue.
    expect(result.outcome).toBe("re_gate_pending");
    expect(scenario.landed).toEqual([]);
    expect(scenario.events.events).toContain("merge.regate_pending");
  });
});

describe("§5 v42: no re-gate when the gated head IS the current head (no needless work)", () => {
  it("lands directly when gatedHeadSha === current head (no mismatch → no re-gate)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const events = recordingEventStore();
    const landed: string[] = [];
    const reGateHeads: Array<string | undefined> = [];
    const input = {
      pool: fakePool,
      secrets: {},
      githubHttp: {},
      runId: "run_1",
      resolveConflict: async () => ({ resolved: true }),
      reGateCi: async (i: { rebasedHeadSha?: string } | undefined) => {
        reGateHeads.push(i?.rebasedHeadSha);
        return { status: "passed" as const };
      },
      // The gate verdict IS for the live head (`sha-feat`) — the common, no-mismatch case.
      mergeAuthority: bundle(host, { landed, gatedHeadSha: "sha-feat" }),
      // Audit finding #5: the dispatcher's finalize requires a writer for the atomic terminal pair.
      runStateWriter: noopFinalizeWriter(),
    } as unknown as MergeForRunInput;
    const deps: DispatcherDeps = {
      input,
      context: context(),
      eventStore: events as never,
      taskId: "task_1",
      integration: "native_queue",
      pr: { repo: REPO, pullNumber: 1 },
      probe: cleanProbe(),
    };

    const result = await new MergeDispatcher(deps).directMerge();

    // No mismatch ⇒ the re-gate hook was NEVER called (no needless work), and the land proceeded.
    expect(reGateHeads).toEqual([]);
    expect(result.outcome).toBe("merged");
    expect(landed).toEqual(["sha-feat"]);
  });
});
