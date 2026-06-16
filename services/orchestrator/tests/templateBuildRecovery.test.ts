// Tests for template-build SELF-RECOVERY (templating-system.md §2 + the autonomy
// thesis) — `recoverStrandedTemplateBuild`, the UNBOUNDED-while-converging auto-requeue
// of a stranded, bound template-build so it NEVER needs manual DB clearing. The
// robustness gap: a failed template-build persists bound to a deterministic slug, so the
// NEXT derive RESUMES it, re-sees the terminally-blocked spec, and re-strands forever.
// The contract proven here:
//   1. a bound build with a terminally-blocked spec is AUTO-REQUEUED (the spec is reset
//      to re-drivable, a `template.build.recovered` event is emitted);
//   2. the recovery is bounded by INTELLIGENT NON-CONVERGENCE DETECTION (apex v35 — the
//      shared `convergenceDetector`), NOT a count: a build that keeps merging more specs
//      OR shifting its stranded set recovers UNBOUNDED; a build at a FIXED POINT (the
//      identical stranded set with no new merges) STOPS, emits a loud
//      `template.build.recovery_exhausted`, and throws;
//   3. a build that already PUBLISHED a validated template is NEVER re-driven;
//   4. a build with no terminally-blocked spec is a clean no-op (`not_stranded`).
// Everything live is a SEAM: the DAG read, the spec reset, the prior-recovery signals,
// and the published-template check are injected fakes.

import { describe, expect, it } from "vitest";
import type { DagSnapshot, DagSpecNode } from "../src/engine/contracts/dagWalker.js";
import type { EventStore } from "../src/engine/eventStore.js";
import {
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

// The stranded set of the CURRENT snapshot, normalized (sorted, deduped) the same way the
// recovery does — used to synthesize a fixed-point prior recovery that matches it.
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
  // EITHER `"fixed-point"` (synthesize ONE prior recovery IDENTICAL to the current snapshot
  // — the stuck-build case that exhausts), OR an explicit ordered list of prior progress
  // signals (to model a converging or stuck history), OR omitted (no prior recoveries).
  priorRecoveries?: "fixed-point" | RecoveryProgressSignal[];
  published?: boolean;
  // Spec ids the reset should report as NOT reset (a concurrent recovery race).
  resetSkips?: string[];
}

function makeDeps(opts: FakeOptions): { deps: TemplateBuildRecoveryDeps; events: RecordingEvents; reset: string[] } {
  const events = new RecordingEvents();
  const reset: string[] = [];
  const skips = new Set(opts.resetSkips ?? []);
  // `"fixed-point"` synthesizes ONE prior recovery identical to the current snapshot (same
  // merged count + same stranded set) — so the latest attempt is a fixed point and exhausts.
  const priorSignals: RecoveryProgressSignal[] =
    opts.priorRecoveries === "fixed-point"
      ? [{ mergedCount: mergedOf(opts.nodes), strandedSpecIds: strandedOf(opts.nodes) }]
      : (opts.priorRecoveries ?? []);
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
    expect(reset).toEqual(["s2", "s3"]);

    const recovered = events.appended.find((e) => e.eventType === "template.build.recovered");
    expect(recovered).toMatchObject({
      projectId: "project_tmpl",
      payload: { orgId: "org_acme", stack: "ts-pnpm", requeuedSpecIds: ["s2", "s3"], attempt: 1 },
    });
    // The bounded-count `maxAttempts` field is GONE from the event (no count).
    expect((recovered?.payload as Record<string, unknown> | undefined)?.maxAttempts).toBeUndefined();
  });

  it("the recovered attempt number reflects prior recoveries (an OBSERVABLE counter, not a bound)", async () => {
    // Two prior recoveries that each made PROGRESS (more merged) and the current also advanced ⇒
    // it recovers (not a fixed point), showing attempt = priors + 1 = 3.
    const { deps, events } = makeDeps({
      nodes: [node("d1", "done"), node("d2", "done"), node("d3", "done"), node("s1", "terminal_blocked")],
      priorRecoveries: [
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 2, strandedSpecIds: ["s1"] },
      ],
    });
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

// ---- 2. BOUNDED by a FIXED POINT — no infinite loop, no count ---------------

describe("recoverStrandedTemplateBuild — bounded by the fixed-point detector (no count)", () => {
  it("at a FIXED POINT (identical stranded set + no new merges) it STOPS: throws + emits recovery_exhausted, no further requeue", async () => {
    const { deps, events, reset } = makeDeps({
      nodes: [node("s1", "terminal_blocked")],
      priorRecoveries: "fixed-point",
    });

    await expect(recoverStrandedTemplateBuild(deps, ctx)).rejects.toBeInstanceOf(TemplateBuildRecoveryExhaustedError);

    expect(reset).toEqual([]);
    expect(events.appended.find((e) => e.eventType === "template.build.recovered")).toBeUndefined();

    const exhausted = events.appended.find((e) => e.eventType === "template.build.recovery_exhausted");
    expect(exhausted).toMatchObject({
      projectId: "project_tmpl",
      payload: { orgId: "org_acme", stack: "ts-pnpm", requeuedSpecIds: ["s1"] },
    });
    expect((exhausted?.payload as Record<string, unknown> | undefined)?.maxAttempts).toBeUndefined();
  });

  it("a SINGLE identical prior recovery is already a fixed point (no count threshold to reach)", async () => {
    // ONE prior recovery identical to the current snapshot is enough — there is no K to climb.
    const { deps } = makeDeps({
      nodes: [node("d1", "done"), node("s1", "terminal_blocked")],
      priorRecoveries: [{ mergedCount: 1, strandedSpecIds: ["s1"] }],
    });
    await expect(recoverStrandedTemplateBuild(deps, ctx)).rejects.toBeInstanceOf(TemplateBuildRecoveryExhaustedError);
  });

  it("the thrown error carries the stranded spec ids for the loud finding", async () => {
    const { deps } = makeDeps({
      nodes: [node("s1", "terminal_blocked"), node("s2", "terminal_blocked")],
      priorRecoveries: "fixed-point",
    });
    const error = await recoverStrandedTemplateBuild(deps, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemplateBuildRecoveryExhaustedError);
    const exhausted = error as TemplateBuildRecoveryExhaustedError;
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

// ---- 5. UNBOUNDED while converging; fixed point stops it -------------------

describe("recoverStrandedTemplateBuild — UNBOUNDED while progressing", () => {
  it("a build that keeps MERGING more specs recovers UNBOUNDED (far past any old flat cap)", async () => {
    // Eight prior recoveries — far past the old flat cap of 3 — but each merged strictly more
    // specs and the current snapshot advanced again. Every step is progress ⇒ keep recovering.
    const priorRecoveries: RecoveryProgressSignal[] = Array.from({ length: 8 }, (_, i) => ({
      mergedCount: i + 1,
      strandedSpecIds: ["s1"],
    }));
    const { deps, events } = makeDeps({
      nodes: [...Array.from({ length: 9 }, (_, i) => node(`m${i}`, "done")), node("s1", "terminal_blocked")],
      priorRecoveries,
    });

    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toMatchObject({ kind: "requeued", attempt: 9 });
    const recovered = events.appended.find((e) => e.eventType === "template.build.recovered");
    expect(recovered?.payload).toMatchObject({ mergedCount: 9, strandedSpecIds: ["s1"] });
  });

  it("a build whose STRANDED SET changes recovers (a different spec now blocks = progress)", async () => {
    // The stranded set shifted each recovery (s1 → s2 → s3) and is different now (s4). A
    // changed stranded set IS progress ⇒ recover, even with the same merged count.
    const { deps } = makeDeps({
      nodes: [node("d1", "done"), node("s4", "terminal_blocked")],
      priorRecoveries: [
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 1, strandedSpecIds: ["s2"] },
        { mergedCount: 1, strandedSpecIds: ["s3"] },
      ],
    });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toMatchObject({ kind: "requeued" });
  });

  it("a build STUCK at the SAME failure (the latest recovery matches the snapshot) exhausts loud", async () => {
    // The most-recent prior recovery is identical to the current snapshot (no new merges, same
    // stranded set) ⇒ a fixed point ⇒ exhaust — regardless of earlier progress.
    const { deps, events, reset } = makeDeps({
      nodes: [node("d1", "done"), node("s1", "terminal_blocked")],
      priorRecoveries: [
        // early progress, then the most-recent prior is identical to the current snapshot (fixed point).
        { mergedCount: 0, strandedSpecIds: ["sa"] },
        { mergedCount: 1, strandedSpecIds: ["s1"] },
      ],
    });
    await expect(recoverStrandedTemplateBuild(deps, ctx)).rejects.toBeInstanceOf(TemplateBuildRecoveryExhaustedError);
    expect(reset).toEqual([]);
    const exhausted = events.appended.find((e) => e.eventType === "template.build.recovery_exhausted");
    expect(exhausted?.payload).toMatchObject({ mergedCount: 1, strandedSpecIds: ["s1"] });
  });

  it("a SINGLE step of progress (one more merged) lets it recover even after a frozen run", async () => {
    // The prior froze at merged=3, but the current snapshot finally merged one more (4). That
    // single forward step makes the latest-vs-prior comparison progress ⇒ recover.
    const { deps, events } = makeDeps({
      nodes: [
        node("d1", "done"),
        node("d2", "done"),
        node("d3", "done"),
        node("d4", "done"),
        node("s1", "terminal_blocked"),
      ],
      priorRecoveries: [
        { mergedCount: 3, strandedSpecIds: ["s1"] },
        { mergedCount: 3, strandedSpecIds: ["s1"] },
      ],
    });
    const outcome = await recoverStrandedTemplateBuild(deps, ctx);
    expect(outcome).toMatchObject({ kind: "requeued" });
    expect(events.appended.find((e) => e.eventType === "template.build.recovered")?.payload).toMatchObject({
      mergedCount: 4,
    });
  });

  it("BOUNDED: a forever-stuck build terminates the moment it stops changing (does not infinitely recover)", async () => {
    // Feed each emitted signal back as a prior. With NO progress (same nodes), the SECOND pass
    // is already a fixed point (the prior matches the snapshot) ⇒ it terminates fast.
    const priors: RecoveryProgressSignal[] = [];
    const nodes = [node("d1", "done"), node("s1", "terminal_blocked")];
    let thrown: unknown;
    for (let i = 0; i < 50; i++) {
      const { deps } = makeDeps({ nodes, priorRecoveries: priors });
      const result = await recoverStrandedTemplateBuild(deps, ctx).then(
        () => "recovered" as const,
        (error: unknown) => error,
      );
      if (result === "recovered") {
        priors.push({ mergedCount: 1, strandedSpecIds: ["s1"] });
        continue;
      }
      thrown = result;
      break;
    }
    expect(thrown).toBeInstanceOf(TemplateBuildRecoveryExhaustedError);
    // It recovered ONCE (the first pass, no prior to compare), then hit the fixed point.
    expect(priors.length).toBe(1);
  });
});
