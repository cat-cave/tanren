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
  // EITHER `"fixed-point"` (synthesize prior recoveries forming a CYCLE with the current
  // snapshot — the same stranded set + merged count RECURRING beyond the immediate neighbor,
  // the stuck-build case that exhausts), OR an explicit ordered list of prior progress signals
  // (to model a converging or stuck history), OR omitted (no prior recoveries).
  priorRecoveries?: "fixed-point" | RecoveryProgressSignal[];
  published?: boolean;
  // Spec ids the reset should report as NOT reset (a concurrent recovery race).
  resetSkips?: string[];
}

function makeDeps(opts: FakeOptions): { deps: TemplateBuildRecoveryDeps; events: RecordingEvents; reset: string[] } {
  const events = new RecordingEvents();
  const reset: string[] = [];
  const skips = new Set(opts.resetSkips ?? []);
  // `"fixed-point"` synthesizes TWO prior recoveries identical to the current snapshot (same
  // merged count + same stranded set) — so the latest attempt RECURS a state it has been in
  // beyond the immediate neighbor (a CYCLE, not a single transient repeat) and exhausts.
  const identical: RecoveryProgressSignal = {
    mergedCount: mergedOf(opts.nodes),
    strandedSpecIds: strandedOf(opts.nodes),
  };
  const priorSignals: RecoveryProgressSignal[] =
    opts.priorRecoveries === "fixed-point" ? [identical, identical] : (opts.priorRecoveries ?? []);
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

  it("a RECURRING identical state (a cycle, not a single transient repeat) is a fixed point — no count threshold", async () => {
    // The state RECURS beyond the immediate neighbor (the same merged count + stranded set seen
    // before) with no net progress ⇒ a cycle ⇒ exhaust. There is no K to climb — a single
    // transient repeat would NOT escalate (the disguised-K=2 fix), but a genuine cycle does.
    const { deps } = makeDeps({
      nodes: [node("d1", "done"), node("s1", "terminal_blocked")],
      priorRecoveries: [
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 1, strandedSpecIds: ["s1"] },
      ],
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

  it("a build that OSCILLATES between two states with no net progress exhausts loud", async () => {
    // The build OSCILLATES between the s1/merged-1 and sb/merged-2 states (s1→sb→s1→sb→s1) with
    // no net forward motion — a sustained cycle (the snapshot recurs a non-immediate prior, and
    // the only states seen since are already-visited ones) ⇒ a fixed point ⇒ exhaust. (A single
    // excursion-and-return would still be exploration — it keeps recovering.)
    const { deps, events, reset } = makeDeps({
      nodes: [node("d1", "done"), node("s1", "terminal_blocked")],
      priorRecoveries: [
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 2, strandedSpecIds: ["sb"] },
        { mergedCount: 1, strandedSpecIds: ["s1"] },
        { mergedCount: 2, strandedSpecIds: ["sb"] },
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

  it("BOUNDED: a forever-stuck build terminates once the no-progress state RECURS (a cycle, not infinite recovery)", async () => {
    // Feed each emitted signal back as a prior. With NO progress (same nodes), a single repeat is
    // NOT yet a fixed point (a transient could recur once); but once the identical state RECURS
    // beyond the immediate neighbor it is a proven cycle ⇒ it terminates fast (not infinitely).
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
    // It recovered TWICE (the first pass with no prior, then a single transient-tolerant repeat),
    // then hit the fixed point the moment the no-progress state RECURRED (the cycle) — bounded,
    // never infinite. The exact count is incidental; the property is that it terminates fast.
    expect(priors.length).toBe(2);
  });
});
