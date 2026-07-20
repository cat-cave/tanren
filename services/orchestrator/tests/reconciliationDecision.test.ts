// in-11 — the PURE reconcile decision + snapshot-interpretation proofs. No DB, no
// clock: the progress-based retry / fixed-point / state_unknown / convergence rules
// are exercised directly, so the escalation is proven to key off PROGRESS, never a
// wall-clock or a bare attempt counter.

import { describe, expect, it } from "vitest";
import { decideReconcile, type ReconcileDecision } from "../src/engine/integrations/reconciliationDecision.js";
import { interpretSnapshot, type ReconcileObservation } from "../src/engine/integrations/reconcileProbe.js";
import type { AttemptSignature } from "../src/engine/workflow/convergenceDetector.js";

const observed = { any: "state" } as const;

describe("decideReconcile", () => {
  it("advances a confirmed convergence to a fixed point", () => {
    const decision = decideReconcile(
      { kind: "converged", observedStateHash: `sha256:${"a".repeat(64)}`, observedState: observed },
      [],
    );
    expect(decision.action).toBe("fixed_point");
  });

  it("fail-closes an unconfirmable observation to state_unknown WITHOUT appending history", () => {
    const decision = decideReconcile(
      { kind: "unconfirmable", classification: "provider_response_ambiguous", observedState: observed },
      [{ failureSignature: "progressing", workSignature: "sig-1" }],
    );
    expect(decision).toEqual({ action: "state_unknown", classification: "provider_response_ambiguous" });
  });

  it("routes a confirmed definite failure to needs_attention", () => {
    const decision = decideReconcile(
      { kind: "failed", classification: "resource_conflict", observedState: observed },
      [],
    );
    expect(decision).toMatchObject({ action: "needs_attention", classification: "resource_conflict" });
  });

  it("retries UNBOUNDED while each attempt makes progress — no cap", () => {
    // 200 attempts, each with a DIFFERENT observed signal (genuine forward motion).
    // A wall-clock/counter cap would escalate; progress-based retry never does.
    let history: readonly AttemptSignature[] = [];
    for (let i = 0; i < 200; i += 1) {
      const decision = decideReconcile({ kind: "progressing", signal: `sig-${i}`, observedState: observed }, history);
      expect(decision.action).toBe("retry");
      if (decision.action !== "retry") throw new Error("unreachable");
      history = decision.history;
    }
    // The durable history is bounded (retention window), but retries never stopped.
    expect(history.length).toBeLessThanOrEqual(16);
  });

  it("escalates a PROVEN fixed point (identical observation, no new information) to needs_attention", () => {
    // First identical observation → still progress (nothing to compare on the first).
    const first = decideReconcile({ kind: "progressing", signal: "stuck", observedState: observed }, []);
    expect(first.action).toBe("retry");
    if (first.action !== "retry") throw new Error("unreachable");
    // The SAME observation again reproduces identical work with no new information.
    const second = decideReconcile({ kind: "progressing", signal: "stuck", observedState: observed }, first.history);
    expect(second.action).toBe("needs_attention");
    const escalated = second as Extract<ReconcileDecision, { action: "needs_attention" }>;
    expect(escalated.classification).toMatch(/fixed point/u);
    expect(escalated.classification).toContain("stuck");
  });

  it("keeps a shrinking-magnitude trajectory as progress even at an unchanged signal", () => {
    let history: readonly AttemptSignature[] = [];
    for (const magnitude of [1000, 500, 100, 10, 1]) {
      const decision = decideReconcile(
        { kind: "progressing", signal: "same-signal", magnitude, observedState: observed },
        history,
      );
      expect(decision.action).toBe("retry");
      if (decision.action !== "retry") throw new Error("unreachable");
      history = decision.history;
    }
  });
});

describe("interpretSnapshot", () => {
  const DESIRED = `sha256:${"d".repeat(64)}`;
  const base = {
    observed_state_hash: DESIRED,
    provider_cursor: null,
    provider_etag: null,
    sanitized_snapshot: {},
  };

  it("maps a healthy resource whose observed hash EXACTLY matches desired to converged", () => {
    expect(interpretSnapshot({ ...base, health: "healthy" }, DESIRED).kind).toBe("converged");
  });

  it("maps a healthy-but-DRIFTED resource (observed hash ≠ desired) to progressing, NOT converged", () => {
    // The fail-open the layer-2 audit caught: a health flag is not desired-state
    // confirmation. A different observed hash must NEVER converge/ready the node.
    const drifted = interpretSnapshot(
      { ...base, observed_state_hash: `sha256:${"f".repeat(64)}`, health: "healthy" },
      DESIRED,
    );
    expect(drifted.kind).toBe("progressing");
    expect((drifted as Extract<ReconcileObservation, { kind: "progressing" }>).signal).toMatch(/^drift:/u);
  });

  it("maps missing / degraded to progressing with distinct signals", () => {
    const missing = interpretSnapshot({ ...base, health: "missing" }, DESIRED) as Extract<
      ReconcileObservation,
      { kind: "progressing" }
    >;
    const degraded = interpretSnapshot({ ...base, health: "degraded" }, DESIRED) as Extract<
      ReconcileObservation,
      { kind: "progressing" }
    >;
    expect(missing.kind).toBe("progressing");
    expect(degraded.kind).toBe("progressing");
    expect(missing.signal).not.toEqual(degraded.signal);
  });

  it("maps an undeterminable health to unconfirmable (the 504/ambiguous analog)", () => {
    expect(interpretSnapshot({ ...base, health: "unknown" }, DESIRED).kind).toBe("unconfirmable");
    expect(interpretSnapshot({ ...base, health: "weird" }, DESIRED).kind).toBe("unconfirmable");
  });

  it("folds provider cursor/etag into the progressing signal so real motion reads as progress", () => {
    const a = interpretSnapshot({ ...base, health: "missing", provider_cursor: "c1" }, DESIRED) as Extract<
      ReconcileObservation,
      { kind: "progressing" }
    >;
    const b = interpretSnapshot({ ...base, health: "missing", provider_cursor: "c2" }, DESIRED) as Extract<
      ReconcileObservation,
      { kind: "progressing" }
    >;
    expect(a.signal).not.toEqual(b.signal);
  });
});
