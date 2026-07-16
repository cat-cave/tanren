// §3.2 / §3.3 LOCK (docs/audits/2026-06-09-apex-pre-run.md): the merge-through path's
// land dispositions must be RECOVERABLE, not a terminal dequeue, and a CAS rejection must
// REBASE-then-retry natively (not a GitHub-`behind`-state-dependent path that never fires
// on an unprotected repo). Drives the REAL `MergeDispatcher.directMerge` over the shared
// no-DB harness + an ancestry-augmented `InMemoryCodeHost` whose first land CAS-rejects.
//
// §3.2: authority-`blocked` / `cas_rejected` finalize as recoverable `blocked` (the task
//   stays `running` for the recovery surface), NEVER `merge.conflict` → terminal dequeue.
//   `needs_attention` (a genuine human decision) is the distinct `needs_attention` outcome
//   (parked via the escalator), not a hot-hold.
// §3.3: a CAS rejection drives the unified `baseShiftRebase` hook + re-gate, then re-lands —
//   on an UNPROTECTED repo where GitHub never reports `behind`.

import { describe, expect, it } from "vitest";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";
import { LandCasRejectedError } from "../src/engine/providers/githubCodeHost.js";
import type { LandAuthorizedIntegrationInput } from "../src/engine/contracts/codeHost.js";
import type { MergeForRunInput, MergeProbe } from "../src/engine/workflow/reviewMerge/index.js";
import { MergeDispatcher, type DispatcherDeps } from "../src/engine/workflow/reviewMerge/mergeDispatcher.js";

/**
 * An ancestry-augmented host that REJECTS the first `landAuthorizedIntegration` (modeling a batch
 * sibling racing main ahead between the authority's base read and the ff-only CAS write —
 * the TOCTOU window the real ff-only CAS closes), then lands normally. §6.5: a CodeHost
 * fake that models the CAS race so the merge-through rebase-on-CAS path is provable no-DB.
 */
class RaceOnceCodeHost extends InMemoryCodeHost {
  private rejected = false;
  override async landAuthorizedIntegration(
    input: LandAuthorizedIntegrationInput,
  ): ReturnType<InMemoryCodeHost["landAuthorizedIntegration"]> {
    if (!this.rejected) {
      this.rejected = true;
      throw new LandCasRejectedError(input.intoMain, input.expectedMainSha, "sha-sibling");
    }
    return super.landAuthorizedIntegration(input);
  }
}

/**
 * A host that CAS-rejects the first `rejectCount` lands with an ADVANCING observed main sha
 * each time (`sha-main-1`, `sha-main-2`, … — main genuinely moving under the run = contention
 * = progress), then lands. Models a live, heavily-contended main that keeps advancing past the
 * OLD fixed 2-cap; the progress-based re-drive must keep rebasing+re-landing until it lands.
 */
class AdvancingRaceCodeHost extends InMemoryCodeHost {
  private rejections = 0;
  constructor(private readonly rejectCount: number) {
    super();
  }
  override async landAuthorizedIntegration(
    input: LandAuthorizedIntegrationInput,
  ): ReturnType<InMemoryCodeHost["landAuthorizedIntegration"]> {
    if (this.rejections < this.rejectCount) {
      this.rejections += 1;
      // The observed actual main sha ADVANCES every rejection → a CHANGING signature = progress.
      throw new LandCasRejectedError(input.intoMain, input.expectedMainSha, `sha-main-${this.rejections}`);
    }
    return super.landAuthorizedIntegration(input);
  }
}

/**
 * A host that CAS-rejects EVERY land with the SAME non-advancing observed main sha — an
 * identical rejection signature recurring with no advancement. This is genuine non-convergence
 * (a real stuck, NOT contention): the progress-based guard must recoverable-hold, never loop.
 */
class StuckRaceCodeHost extends InMemoryCodeHost {
  override async landAuthorizedIntegration(
    input: LandAuthorizedIntegrationInput,
  ): ReturnType<InMemoryCodeHost["landAuthorizedIntegration"]> {
    // The observed actual main sha NEVER advances → the same rejection signature every attempt.
    throw new LandCasRejectedError(input.intoMain, input.expectedMainSha, "sha-stuck");
  }
}
import {
  REPO,
  bundle,
  context,
  fakePool,
  mergeability,
  noopFinalizeWriter,
  reGate,
  recordingEventStore,
} from "./fixtures/mergeDispatcherConflictFixtures.js";

/** A probe that is ALWAYS `clean` (no conflict / never `behind`) — the unprotected-repo land. */
function cleanProbe(): MergeProbe {
  return {
    readFreshness: async () => mergeability("clean"),
    readBaseBranch: async () => "main",
    retargetBase: async () => {},
  };
}

/** Build an authority-gated dispatcher straight to the land (clean probe), with optional hooks. */
function landDispatcher(args: {
  host: InMemoryCodeHost;
  events: ReturnType<typeof recordingEventStore>;
  landed: string[];
  buildBundle?: () => Promise<ReturnType<typeof bundle>>;
  staticBundle?: ReturnType<typeof bundle>;
  baseShiftRebase?: MergeForRunInput["baseShiftRebase"];
  reGateStatus?: "passed" | "failed" | "pending";
}): { dispatcher: MergeDispatcher; probe: ReturnType<typeof cleanProbe> } {
  const probe = cleanProbe();
  const input = {
    pool: fakePool,
    secrets: {},
    githubHttp: {},
    runId: "run_1",
    resolveConflict: async () => ({ resolved: true }),
    reGateCi: reGate(args.reGateStatus ?? "passed"),
    ...(args.staticBundle !== undefined && { mergeAuthority: args.staticBundle }),
    ...(args.buildBundle !== undefined && { buildMergeAuthority: args.buildBundle }),
    ...(args.baseShiftRebase !== undefined && { baseShiftRebase: args.baseShiftRebase }),
    // Audit finding #5: the dispatcher's finalize requires a writer for the atomic terminal pair.
    runStateWriter: noopFinalizeWriter(),
  } as unknown as MergeForRunInput;
  const deps: DispatcherDeps = {
    input,
    context: context(),
    eventStore: args.events as never,
    taskId: "task_1",
    integration: "native_queue",
    pr: { repo: REPO, pullNumber: 1 },
    probe,
  };
  return { dispatcher: new MergeDispatcher(deps), probe };
}

describe("§3.2 recoverable land dispositions", () => {
  it("authority BLOCKED → recoverable `blocked` (task running), NEVER terminal merge.conflict", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const events = recordingEventStore();
    const landed: string[] = [];
    // A null gate outcome makes the authority BLOCK (the gate input fails closed).
    const { dispatcher } = landDispatcher({
      host,
      events,
      landed,
      staticBundle: bundle(host, { gateOutcome: null, landed }),
    });
    const result = await dispatcher.directMerge();

    // RECOVERABLE: the outcome is `blocked` (NOT `conflict`), so the coordinator retains
    // it for re-drive rather than terminally dequeuing and stranding it.
    expect(result.outcome).toBe("blocked");
    // The recovery surface sees `merge.blocked`, never a terminal `merge.conflict`.
    expect(events.events).toContain("merge.blocked");
    expect(events.events).not.toContain("merge.conflict");
    expect(landed).toEqual([]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-main");
  });

  it("authority needs_attention (HITL pending) → the distinct `needs_attention` outcome (parked, not hot-held)", async () => {
    const host = new InMemoryCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const events = recordingEventStore();
    const landed: string[] = [];
    // An unresolved HITL signoff makes the authority return `needs_attention` (a genuine
    // human decision), distinct from a transient `blocked`.
    const b = bundle(host, { landed });
    const { dispatcher } = landDispatcher({
      host,
      events,
      landed,
      staticBundle: { ...b, hitlSignoff: "pending" },
    });
    const result = await dispatcher.directMerge();

    expect(result.outcome).toBe("needs_attention");
    expect(events.events).toContain("merge.blocked");
    expect(landed).toEqual([]);
  });
});

describe("§3.3 native rebase-on-CAS (unprotected repo, no GitHub `behind`)", () => {
  it("a CAS rejection drives the baseShiftRebase hook + re-gate, then re-lands", async () => {
    // The host CAS-rejects the FIRST land (a sibling raced main ahead) then lands normally.
    const host = new RaceOnceCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });

    const events = recordingEventStore();
    const landed: string[] = [];
    // The base-shift rebase advances feat onto the new main → sha-feat2 (the rebased head).
    let rebaseCalls = 0;
    const baseShiftRebase: MergeForRunInput["baseShiftRebase"] = async () => {
      rebaseCalls += 1;
      await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat2" });
      return { outcome: "rebased", rebasedHeadSha: "sha-feat2" };
    };
    // The bundle is rebuilt on the re-attempt — its gatedHeadSha tracks the (rebased) head.
    let builds = 0;
    const buildBundle = async (): Promise<ReturnType<typeof bundle>> => {
      builds += 1;
      return bundle(host, { landed, gatedHeadSha: builds === 1 ? "sha-feat" : "sha-feat2" });
    };

    const { dispatcher } = landDispatcher({ host, events, landed, buildBundle, baseShiftRebase });
    const result = await dispatcher.directMerge();

    // The CAS rejection was handled by a NATIVE rebase-then-retry (not a terminal dequeue):
    // the base-shift hook fired, the head re-gated, and the SECOND land succeeded.
    expect(rebaseCalls).toBe(1);
    expect(result.outcome).toBe("merged");
    expect(landed).toEqual(["sha-feat2"]);
    expect(await host.fetchRef({ repo: REPO, remoteBranch: "main" })).toBe("sha-feat2");
    // A rebase-then-regate trail, never a terminal merge.conflict dequeue.
    expect(events.events).toContain("merge.behind");
    expect(events.events).toContain("merge.rebased");
    expect(events.events).not.toContain("merge.conflict");
  });

  it("a CAS rejection with NO base-shift hook holds recoverably `blocked` (never terminal)", async () => {
    const host = new RaceOnceCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });
    const events = recordingEventStore();
    const landed: string[] = [];
    // No baseShiftRebase hook wired → the CAS rejection cannot rebase natively → recoverable
    // hold (NOT a terminal merge.conflict dequeue).
    const { dispatcher } = landDispatcher({
      host,
      events,
      landed,
      staticBundle: bundle(host, { landed, gatedHeadSha: "sha-feat" }),
    });
    const result = await dispatcher.directMerge();

    expect(result.outcome).toBe("blocked");
    expect(events.events).not.toContain("merge.conflict");
    expect(landed).toEqual([]);
  });
});

describe("§3.3 native rebase-on-CAS is PROGRESS-based, not a fixed count", () => {
  it("a CAS that keeps losing to an ADVANCING main keeps rebasing past the old 2-cap and lands", async () => {
    // Main advances under the run FOUR times (well past the old MAX_CAS_REBASE_RETRIES=2):
    // a different observed-main signature each rejection = genuine progress (live contention),
    // so the re-drive must continue UNBOUNDED and eventually land — never give up on a count.
    const REJECTS = 4;
    const host = new AdvancingRaceCodeHost(REJECTS);
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });

    // Each rebase advances feat onto the newly-advanced main → a fresh head per attempt.
    let rebaseCalls = 0;
    const baseShiftRebase: MergeForRunInput["baseShiftRebase"] = async () => {
      rebaseCalls += 1;
      const head = `sha-feat-r${rebaseCalls}`;
      await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: head });
      return { outcome: "rebased", rebasedHeadSha: head };
    };
    // The bundle is rebuilt per re-attempt; its gatedHeadSha tracks the latest rebased head so
    // the authority's commit-binding (gatedHeadSha === landing head) re-validates each round.
    let builds = 0;
    const buildBundle = async (): Promise<ReturnType<typeof bundle>> => {
      builds += 1;
      return bundle(host, { landed, gatedHeadSha: builds === 1 ? "sha-feat" : `sha-feat-r${builds - 1}` });
    };

    const events = recordingEventStore();
    const landed: string[] = [];
    const { dispatcher } = landDispatcher({ host, events, landed, buildBundle, baseShiftRebase });
    const result = await dispatcher.directMerge();

    // It rebased once PER advancing rejection (4 > the old 2-cap) and finally landed — no give-up.
    expect(rebaseCalls).toBe(REJECTS);
    expect(result.outcome).toBe("merged");
    expect(landed).toEqual([`sha-feat-r${REJECTS}`]);
    expect(events.events).not.toContain("merge.conflict");
  });

  it("a CAS stuck on an IDENTICAL non-advancing rejection recoverable-holds (non-convergence, not a count)", async () => {
    // Main NEVER advances: the same rejection signature recurs → a fixed point (genuine stuck,
    // not contention). The progress guard holds RECOVERABLY rather than re-rebasing forever.
    const host = new StuckRaceCodeHost();
    host.seed(REPO, "main", "sha-main");
    await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: "sha-feat" });

    let rebaseCalls = 0;
    const baseShiftRebase: MergeForRunInput["baseShiftRebase"] = async () => {
      rebaseCalls += 1;
      const head = `sha-feat-r${rebaseCalls}`;
      await host.pushRef({ repo: REPO, localRef: "feat", remoteBranch: "feat", sha: head });
      return { outcome: "rebased", rebasedHeadSha: head };
    };
    let builds = 0;
    const buildBundle = async (): Promise<ReturnType<typeof bundle>> => {
      builds += 1;
      return bundle(host, { landed, gatedHeadSha: builds === 1 ? "sha-feat" : `sha-feat-r${builds - 1}` });
    };

    const events = recordingEventStore();
    const landed: string[] = [];
    const { dispatcher } = landDispatcher({ host, events, landed, buildBundle, baseShiftRebase });
    const result = await dispatcher.directMerge();

    // Recoverable hold (the recovery surface re-drives), never a terminal dequeue, never landed.
    expect(result.outcome).toBe("blocked");
    expect(events.events).not.toContain("merge.conflict");
    expect(landed).toEqual([]);
    // It did NOT loop forever: the first rejection is progress (history of 1), it rebased once,
    // then the second identical rejection is the fixed point that holds — a bounded, finite path.
    expect(rebaseCalls).toBe(1);
  });
});
