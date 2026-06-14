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

interface FakeOptions {
  nodes: DagSpecNode[];
  priorRecoveries?: number;
  published?: boolean;
  // Spec ids the reset should report as NOT reset (a concurrent recovery race).
  resetSkips?: string[];
  maxAttempts?: number;
}

function makeDeps(opts: FakeOptions): { deps: TemplateBuildRecoveryDeps; events: RecordingEvents; reset: string[] } {
  const events = new RecordingEvents();
  const reset: string[] = [];
  const skips = new Set(opts.resetSkips ?? []);
  const deps: TemplateBuildRecoveryDeps = {
    loadSnapshot: async (projectId) => snapshot(projectId, opts.nodes),
    resetStrandedSpec: async ({ specId }) => {
      if (skips.has(specId)) return false;
      reset.push(specId);
      return true;
    },
    priorRecoveryCount: async () => opts.priorRecoveries ?? 0,
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
