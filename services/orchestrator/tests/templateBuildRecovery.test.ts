// Tests for template-build SELF-RECOVERY (templating-system.md §2 + the autonomy
// thesis) — `recoverStrandedTemplateBuild`, the bounded auto-requeue of a stranded,
// bound template-build so it NEVER needs manual DB clearing. The robustness gap: a
// failed template-build persists bound to a deterministic slug, so the NEXT derive
// RESUMES it, re-sees the terminally-blocked spec, and re-strands forever. The
// contract proven here:
//   1. a bound build with a terminally-blocked spec is AUTO-REQUEUED (the spec is
//      reset to re-drivable, a `template.build.recovered` event is emitted) rather
//      than immediately re-stranding;
//   2. the recovery is BOUNDED — after K prior recoveries it STOPS, emits a loud
//      `template.build.recovery_exhausted`, and throws (no infinite loop);
//   3. a build that already PUBLISHED a validated template is NEVER re-driven
//      (the succeeded-build short-circuit);
//   4. a build with no terminally-blocked spec (a fresh derive / converged build) is
//      a clean no-op (`not_stranded`).
// Everything live is a SEAM: the DAG read, the spec reset, the prior-attempt count,
// and the published-template check are injected fakes.

import { describe, expect, it } from "vitest";
import type { DagSnapshot, DagSpecNode } from "../src/engine/contracts/dagWalker.js";
import type { EventStore } from "../src/engine/eventStore.js";
import {
  DEFAULT_MAX_RECOVERY_ATTEMPTS,
  recoverStrandedTemplateBuild,
  TemplateBuildRecoveryExhaustedError,
  type RecoveryProgressSignal,
  type TemplateBuildRecoveryDeps,
} from "../src/engine/templates/index.js";

// ---- Fakes -----------------------------------------------------------------

class RecordingEvents implements EventStore {
  readonly appended: Array<{ eventType: string; payload: Record<string, unknown>; projectId: string }> = [];
  async append(input: { eventType: string; payload: unknown; projectId: string }): Promise<void> {
    this.appended.push({
      eventType: input.eventType,
      payload: input.payload as Record<string, unknown>,
      projectId: input.projectId,
    });
  }
}

function node(specId: string, phase: DagSpecNode["phase"]): DagSpecNode {
  return { specId, phase, dependsOn: [], priority: "tbd", orderKey: 0 };
}

function snapshot(projectId: string, nodes: DagSpecNode[]): DagSnapshot {
  return { projectId, nodes, archived: false };
}

// The stranded set of the CURRENT snapshot, normalized (sorted, deduped) the same way
// the recovery does — used to synthesize "no-progress" prior recoveries that match it.
function strandedOf(nodes: DagSpecNode[]): string[] {
  return [...new Set(nodes.filter((n) => n.phase === "terminal_blocked").map((n) => n.specId))].sort((x, y) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
}

function mergedOf(nodes: DagSpecNode[]): number {
  return nodes.filter((n) => n.phase === "done").length;
}

interface FakeOptions {
  nodes: DagSpecNode[];
  // EITHER a count of prior recoveries (synthesized as IDENTICAL no-progress signals
  // matching the current snapshot — the stuck-build case the flat cap modeled), OR an
  // explicit ordered list of prior progress signals (to model a converging build).
  priorRecoveries?: number | RecoveryProgressSignal[];
  published?: boolean;
  // Spec ids the reset should report as NOT reset (a concurrent recovery race).
  resetSkips?: string[];
  maxAttempts?: number;
}

function makeDeps(opts: FakeOptions): { deps: TemplateBuildRecoveryDeps; events: RecordingEvents; reset: string[] } {
  const events = new RecordingEvents();
  const reset: string[] = [];
  const skips = new Set(opts.resetSkips ?? []);
  // A bare count synthesizes that many IDENTICAL no-progress recoveries (same merged
  // count + same stranded set as the current snapshot) — so the historical flat-cap
  // tests model a truly-stuck build and still exhaust.
  const priorSignals: RecoveryProgressSignal[] = Array.isArray(opts.priorRecoveries)
    ? opts.priorRecoveries
    : Array.from({ length: opts.priorRecoveries ?? 0 }, () => ({
        mergedCount: mergedOf(opts.nodes),
        strandedSpecIds: strandedOf(opts.nodes),
      }));
  const deps: TemplateBuildRecoveryDeps = {
    loadSnapshot: async (projectId) => snapshot(projectId, opts.nodes),
    resetStrandedSpec: async ({ specId }) => {
      if (skips.has(specId)) return false;
      reset.push(specId);
      return true;
    },
    priorRecoveries: async () => priorSignals,
    hasPublishedValidatedTemplate: async () => opts.published ?? false,
    events,
    ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
  };
  return { deps, events, reset };
}

const ctx = { orgId: "org_acme", projectId: "project_tmpl", stack: "ts-pnpm" };

// ---- 1. AUTO-REQUEUE a stranded build --------------------------------------

describe("recoverStrandedTemplateBuild — requeues a stranded bound build", () => {
  it("resets the terminally-blocked specs to re-drivable + emits template.build.recovered", async () => {
    const { deps, events, reset } = makeDeps({
      nodes: [node("s1", "done"), node("s2", "terminal_blocked"), node("s3", "terminal_blocked")],
    });

    const outcome = await recoverStrandedTemplateBuild(deps, ctx);

    expect(outcome).toEqual({ kind: "requeued", requeuedSpecIds: ["s2", "s3"], attempt: 1 });
    // The blocked specs were reset; the done spec was left alone.
    expect(reset).toEqual(["s2", "s3"]);

    // A DURABLE recovery event was emitted (Tanren recovered, not silently retried).
    const recovered = events.appended.find((e) => e.eventType === "template.build.recovered");
    expect(recovered).toMatchObject({
      projectId: "project_tmpl",
      payload: {
        orgId: "org_acme",
        stack: "ts-pnpm",
        requeuedSpecIds: ["s2", "s3"],
        attempt: 1,
        maxAttempts: DEFAULT_MAX_RECOVERY_ATTEMPTS,
      },
    });
  });

  it("the recovered attempt number reflects prior recoveries (the bound is visible)", async () => {
    const { deps, events } = makeDeps({ nodes: [node("s1", "terminal_blocked")], priorRecoveries: 2 });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toMatchObject({ kind: "requeued", attempt: 3 });
    expect(events.appended.find((e) => e.eventType === "template.build.recovered")?.payload).toMatchObject({
      attempt: 3,
    });
  });

  it("skips specs that raced out of the blocked state, recording only genuinely-reset ids", async () => {
    const { deps, reset } = makeDeps({
      nodes: [node("s1", "terminal_blocked"), node("s2", "terminal_blocked")],
      resetSkips: ["s1"],
    });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toEqual({ kind: "requeued", requeuedSpecIds: ["s2"], attempt: 1 });
    expect(reset).toEqual(["s2"]);
  });

  it("treats an all-raced reset (nothing actually reset) as not_stranded, no event", async () => {
    const { deps, events } = makeDeps({
      nodes: [node("s1", "terminal_blocked")],
      resetSkips: ["s1"],
    });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toEqual({ kind: "not_stranded" });
    expect(events.appended.find((e) => e.eventType === "template.build.recovered")).toBeUndefined();
  });
});

// ---- 2. BOUNDED — no infinite loop -----------------------------------------

describe("recoverStrandedTemplateBuild — the recovery is BOUNDED", () => {
  it("after K prior recoveries it STOPS: throws + emits recovery_exhausted, no further requeue", async () => {
    const { deps, events, reset } = makeDeps({
      nodes: [node("s1", "terminal_blocked")],
      priorRecoveries: DEFAULT_MAX_RECOVERY_ATTEMPTS,
    });

    await expect(recoverStrandedTemplateBuild(deps, ctx)).rejects.toBeInstanceOf(TemplateBuildRecoveryExhaustedError);

    // It did NOT requeue again (no reset, no recovered event) — the loop is bounded.
    expect(reset).toEqual([]);
    expect(events.appended.find((e) => e.eventType === "template.build.recovered")).toBeUndefined();

    // The LOUD, durable terminal record was emitted.
    const exhausted = events.appended.find((e) => e.eventType === "template.build.recovery_exhausted");
    expect(exhausted).toMatchObject({
      projectId: "project_tmpl",
      payload: {
        orgId: "org_acme",
        stack: "ts-pnpm",
        requeuedSpecIds: ["s1"],
        maxAttempts: DEFAULT_MAX_RECOVERY_ATTEMPTS,
      },
    });
  });

  it("respects a custom maxAttempts cap", async () => {
    // At exactly the cap (1 prior recovery, cap 1) it exhausts.
    const exhausting = makeDeps({ nodes: [node("s1", "terminal_blocked")], priorRecoveries: 1, maxAttempts: 1 });
    await expect(recoverStrandedTemplateBuild(exhausting.deps, ctx)).rejects.toBeInstanceOf(
      TemplateBuildRecoveryExhaustedError,
    );

    // Under the cap (0 prior, cap 1) it still recovers once.
    const recovering = makeDeps({ nodes: [node("s1", "terminal_blocked")], priorRecoveries: 0, maxAttempts: 1 });
    const outcome = await recoverStrandedTemplateBuild(recovering.deps, ctx);
    expect(outcome).toMatchObject({ kind: "requeued", attempt: 1 });
  });

  it("the thrown error carries the stranded spec ids + attempt count for the loud finding", async () => {
    const { deps } = makeDeps({
      nodes: [node("s1", "terminal_blocked"), node("s2", "terminal_blocked")],
      priorRecoveries: DEFAULT_MAX_RECOVERY_ATTEMPTS,
    });
    const error = await recoverStrandedTemplateBuild(deps, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemplateBuildRecoveryExhaustedError);
    const exhausted = error as TemplateBuildRecoveryExhaustedError;
    expect(exhausted.attempts).toBe(DEFAULT_MAX_RECOVERY_ATTEMPTS);
    expect(exhausted.strandedSpecIds).toEqual(["s1", "s2"]);
    expect(exhausted.projectId).toBe("project_tmpl");
  });
});

// ---- 3. A PUBLISHED build is never re-driven -------------------------------

describe("recoverStrandedTemplateBuild — a succeeded build short-circuits", () => {
  it("a build that already published a validated template is NOT re-driven, even with a stranded spec", async () => {
    const { deps, events, reset } = makeDeps({
      nodes: [node("s1", "terminal_blocked")],
      published: true,
    });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toEqual({ kind: "already_published" });
    // No reset, no recovery event — the validated template stands.
    expect(reset).toEqual([]);
    expect(events.appended).toEqual([]);
  });
});

// ---- 4. A non-stranded build is a clean no-op ------------------------------

describe("recoverStrandedTemplateBuild — a healthy build is a no-op", () => {
  it("a build with no terminally-blocked spec is not_stranded, no reset, no event", async () => {
    const { deps, events, reset } = makeDeps({
      nodes: [node("s1", "done"), node("s2", "in_flight"), node("s3", "pending")],
    });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toEqual({ kind: "not_stranded" });
    expect(reset).toEqual([]);
    expect(events.appended).toEqual([]);
  });
});

// ---- 5. PROGRESS-AWARE bound: converging keeps recovering, stuck exhausts ----

describe("recoverStrandedTemplateBuild — the bound is PROGRESS-AWARE", () => {
  it("a build that keeps MERGING more specs recovers past the flat cap (it is converging)", async () => {
    // Already over the flat cap (4 prior recoveries, default cap 3) — BUT each prior
    // recovery merged strictly more specs (1→2→3→4), and the current snapshot has even
    // more merged (5). Every step made progress ⇒ consecutive no-progress streak is 0 ⇒
    // it keeps recovering, NOT exhaust.
    const { deps, events } = makeDeps({
      nodes: [
        node("m1", "done"),
        node("m2", "done"),
        node("m3", "done"),
        node("m4", "done"),
        node("m5", "done"),
        node("s1", "terminal_blocked"),
      ],
      priorRecoveries: [
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 2, strandedSpecIds: ["s1"] },
        { mergedCount: 3, strandedSpecIds: ["s1"] },
        { mergedCount: 4, strandedSpecIds: ["s1"] },
      ],
    });

    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    // Recovered (not exhausted), and the visible attempt is the no-progress streak +1 = 1.
    expect(outcome).toMatchObject({ kind: "requeued", attempt: 1 });
    const recovered = events.appended.find((e) => e.eventType === "template.build.recovered");
    expect(recovered?.payload).toMatchObject({ mergedCount: 5, strandedSpecIds: ["s1"], attempt: 1 });
  });

  it("a build whose STRANDED SET changes recovers past the flat cap (a different spec now blocks)", async () => {
    // Over the flat cap (3 prior), same merged count throughout, but the stranded set
    // shifted each recovery (s1 → s2 → s3) and is again different now (s4). The set
    // changing IS progress ⇒ no-progress streak 0 ⇒ keeps recovering.
    const { deps } = makeDeps({
      nodes: [node("d1", "done"), node("s4", "terminal_blocked")],
      priorRecoveries: [
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 1, strandedSpecIds: ["s2"] },
        { mergedCount: 1, strandedSpecIds: ["s3"] },
      ],
    });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toMatchObject({ kind: "requeued", attempt: 1 });
  });

  it("a build STUCK at the SAME failure (no new merges, same stranded set) K times STILL exhausts loud", async () => {
    // Same merged count AND same stranded set across all 3 prior recoveries and the
    // current snapshot — zero forward progress, K=3 consecutive ⇒ exhaust loud.
    const { deps, events, reset } = makeDeps({
      nodes: [node("d1", "done"), node("s1", "terminal_blocked")],
      priorRecoveries: [
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 1, strandedSpecIds: ["s1"] },
      ],
    });
    await expect(recoverStrandedTemplateBuild(deps, ctx)).rejects.toBeInstanceOf(TemplateBuildRecoveryExhaustedError);
    expect(reset).toEqual([]);
    const exhausted = events.appended.find((e) => e.eventType === "template.build.recovery_exhausted");
    expect(exhausted?.payload).toMatchObject({ mergedCount: 1, strandedSpecIds: ["s1"], maxAttempts: 3 });
  });

  it("only CONSECUTIVE trailing no-progress recoveries count: early progress does NOT forgive a recent freeze", async () => {
    // Five priors: it converged early (merged 1→2→3) then FROZE at the same failure for
    // the last steps. The current snapshot matches the frozen tail. The consecutive
    // no-progress streak is exactly the frozen run, which meets the cap ⇒ exhaust. The
    // bound MUST still terminate a build that stopped advancing, even if it once moved.
    const { deps } = makeDeps({
      nodes: [node("d1", "done"), node("d2", "done"), node("d3", "done"), node("s1", "terminal_blocked")],
      maxAttempts: 3,
      priorRecoveries: [
        // The progress era: merged 1→2→3, stranded set shifting.
        { mergedCount: 1, strandedSpecIds: ["sa"] },
        { mergedCount: 2, strandedSpecIds: ["sb"] },
        // Frozen from here: merged 3, stranded {s1} — three consecutive no-progress steps.
        { mergedCount: 3, strandedSpecIds: ["s1"] },
        { mergedCount: 3, strandedSpecIds: ["s1"] },
        { mergedCount: 3, strandedSpecIds: ["s1"] },
      ],
    });
    await expect(recoverStrandedTemplateBuild(deps, ctx)).rejects.toBeInstanceOf(TemplateBuildRecoveryExhaustedError);
  });

  it("a SINGLE step of progress resets the streak: a recovery right after progress is attempt 1 again", async () => {
    // Frozen for a while, then the current snapshot finally merged one more (3→4). That
    // single forward step makes the most-recent comparison progress ⇒ streak 0 ⇒ recover.
    const { deps, events } = makeDeps({
      nodes: [
        node("d1", "done"),
        node("d2", "done"),
        node("d3", "done"),
        node("d4", "done"),
        node("s1", "terminal_blocked"),
      ],
      maxAttempts: 2,
      priorRecoveries: [
        { mergedCount: 3, strandedSpecIds: ["s1"] },
        { mergedCount: 3, strandedSpecIds: ["s1"] },
        { mergedCount: 3, strandedSpecIds: ["s1"] },
      ],
    });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toMatchObject({ kind: "requeued", attempt: 1 });
    expect(events.appended.find((e) => e.eventType === "template.build.recovered")?.payload).toMatchObject({
      mergedCount: 4,
    });
  });

  it("BOUNDED: a forever-stuck build terminates (does not infinitely recover) under the progress-aware cap", async () => {
    // Simulate repeated recoveries that never make progress, feeding each emitted signal
    // back as a prior. The cap MUST be hit within a bounded number of iterations.
    const priors: RecoveryProgressSignal[] = [];
    const nodes = [node("d1", "done"), node("s1", "terminal_blocked")];
    let thrown: unknown;
    for (let i = 0; i < 50; i++) {
      const { deps } = makeDeps({ nodes, maxAttempts: 3, priorRecoveries: priors });
      const result = await recoverStrandedTemplateBuild(deps, ctx).then(
        () => "recovered" as const,
        (error: unknown) => error,
      );
      if (result === "recovered") {
        // No progress was made (same nodes) ⇒ record an identical no-progress signal.
        priors.push({ mergedCount: 1, strandedSpecIds: ["s1"] });
        continue;
      }
      thrown = result;
      break;
    }
    // It terminated (did NOT loop forever) by throwing exhausted, after exactly the
    // cap's worth of no-progress recoveries.
    expect(thrown).toBeInstanceOf(TemplateBuildRecoveryExhaustedError);
    expect(priors.length).toBe(3);
  });
});
