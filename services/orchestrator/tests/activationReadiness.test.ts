// in-6 unit tests for the activation-readiness predicate. Pure-function tests
// (no DB) covering every trap-class self-check: vacuous-truth (#4), allow-list
// (#8), unknown-status fail-closed, coercion/blank-slip (#5), and the
// required-vs-optional split. The RLS integration test covers the scoped query
// + the full activate path.

import { describe, expect, it } from "vitest";
import {
  ACTIVATION_PASS_STATUSES,
  ACTIVATION_REQUIRED_CRITICALITIES,
  evaluateActivationReadiness,
  isActivationPassStatus,
  isActivationRequiredCriticality,
  ProjectActivationReadinessBlockedError,
  type CapabilityReadinessRow,
  type MaterializationGapRow,
} from "../src/engine/repositories/activationReadiness.js";

const req = (over: Partial<CapabilityReadinessRow> = {}): CapabilityReadinessRow => ({
  requirementId: over.requirementId ?? "req_1",
  capability: over.capability ?? "messaging.send",
  criticality: over.criticality ?? "merge_required",
  status: over.status ?? "enqueued",
  waitReason: over.waitReason ?? null,
});

const gap = (over: Partial<MaterializationGapRow> = {}): MaterializationGapRow => ({
  requirementId: over.requirementId ?? "req_gap",
  capability: over.capability ?? "deploy.release",
  criticality: over.criticality ?? "release_required",
});

describe("activationReadiness — criticality + status allow-lists", () => {
  it("treats merge_required + release_required as activation-required, best_effort as optional", () => {
    expect(isActivationRequiredCriticality("merge_required")).toBe(true);
    expect(isActivationRequiredCriticality("release_required")).toBe(true);
    expect(isActivationRequiredCriticality("best_effort")).toBe(false);
  });

  it("treats an UNKNOWN criticality as NOT activation-required (fail-closed via the predicate, not here)", () => {
    // The helper itself returns false for unknown — the predicate's gap/row logic
    // ensures an unknown criticality is simply ignored (not a blocker). This is
    // correct: an unknown criticality is not in the required allow-list.
    expect(isActivationRequiredCriticality("unknown_severity")).toBe(false);
    expect(isActivationRequiredCriticality("")).toBe(false);
  });

  it("treats enqueued + ready as pass statuses; everything else fails (allow-list, trap #8)", () => {
    expect(isActivationPassStatus("enqueued")).toBe(true);
    expect(isActivationPassStatus("ready")).toBe(true);
    // Every other status — including unknown — fails.
    expect(isActivationPassStatus("pending")).toBe(false);
    expect(isActivationPassStatus("awaiting_grant")).toBe(false);
    expect(isActivationPassStatus("needs_attention")).toBe(false);
    expect(isActivationPassStatus("blocked")).toBe(false);
    expect(isActivationPassStatus("unknown_status")).toBe(false);
    expect(isActivationPassStatus("")).toBe(false);
  });

  it("the allow-lists are frozen (a regression that adds/removes a value is a diff)", () => {
    expect([...ACTIVATION_REQUIRED_CRITICALITIES]).toEqual(["merge_required", "release_required"]);
    expect([...ACTIVATION_PASS_STATUSES]).toEqual(["enqueued", "ready"]);
  });
});

describe("evaluateActivationReadiness — the pure predicate", () => {
  it("EMPTY rows + EMPTY gaps → ready (the legitimate no-requirements case; NOT the vacuous-truth trap)", () => {
    // A project with no compiled integration_requirements has no required
    // capabilities — the gate is a no-op. This is correct (the gate engages
    // only when in-5 compiled requirements exist). The empty set is genuinely
    // ready, not vacuously "all bad things absent".
    const verdict = evaluateActivationReadiness([], []);
    expect(verdict.ready).toBe(true);
    expect(verdict.blockers).toEqual([]);
    expect(verdict.gaps).toEqual([]);
  });

  it("a REQUIRED capability in a PASS status (enqueued — grant present) → ready", () => {
    const verdict = evaluateActivationReadiness([req({ status: "enqueued" })], []);
    expect(verdict.ready).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it("a REQUIRED capability in `ready` → ready", () => {
    const verdict = evaluateActivationReadiness([req({ status: "ready" })], []);
    expect(verdict.ready).toBe(true);
  });

  it("a REQUIRED capability `awaiting_grant` → NOT ready (the core in-6 block)", () => {
    const verdict = evaluateActivationReadiness(
      [req({ status: "awaiting_grant", waitReason: "grant_absent:slack:product/test" })],
      [],
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toHaveLength(1);
    expect(verdict.blockers[0]).toMatchObject({
      capability: "messaging.send",
      status: "awaiting_grant",
      waitReason: "grant_absent:slack:product/test",
      criticality: "merge_required",
    });
  });

  it("a REQUIRED capability `needs_attention` → NOT ready (fail-closed on a broken integration)", () => {
    const verdict = evaluateActivationReadiness([req({ status: "needs_attention" })], []);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers[0]?.status).toBe("needs_attention");
  });

  it("a REQUIRED capability `pending` (deps not ready / not yet evaluated) → NOT ready", () => {
    const verdict = evaluateActivationReadiness([req({ status: "pending" })], []);
    expect(verdict.ready).toBe(false);
  });

  it("a REQUIRED capability with an UNKNOWN status → NOT ready (trap #8 allow-list; unknown never passes)", () => {
    const verdict = evaluateActivationReadiness([req({ status: "super_ready" })], []);
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers[0]?.status).toBe("super_ready");
  });

  it("an OPTIONAL (best_effort) capability un-ready → ready (in-6 must NOT over-gate on non-required)", () => {
    const verdict = evaluateActivationReadiness([req({ criticality: "best_effort", status: "awaiting_grant" })], []);
    expect(verdict.ready).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it("an UNKNOWN criticality un-ready → ready (unknown criticality is not required; ignored, not a blocker)", () => {
    // An unknown criticality is outside the required allow-list, so it's treated
    // as optional. This is distinct from an unknown STATUS (which blocks). The
    // criticality field comes from the in-5 compiled + validated
    // IntegrationRequirementV1, so an unknown value here would be a schema
    // violation upstream — but the predicate is defensive (allow-list).
    const verdict = evaluateActivationReadiness([req({ criticality: "future_tier", status: "awaiting_grant" })], []);
    expect(verdict.ready).toBe(true);
  });

  it("mixed: required-PASS + optional-BLOCK → ready (optional never blocks)", () => {
    const verdict = evaluateActivationReadiness(
      [
        req({ requirementId: "req_required", criticality: "merge_required", status: "enqueued" }),
        req({ requirementId: "req_optional", criticality: "best_effort", status: "awaiting_grant" }),
      ],
      [],
    );
    expect(verdict.ready).toBe(true);
  });

  it("mixed: required-BLOCK + optional-PASS → NOT ready (the required one blocks)", () => {
    const verdict = evaluateActivationReadiness(
      [
        req({ requirementId: "req_required", criticality: "release_required", status: "awaiting_grant" }),
        req({ requirementId: "req_optional", criticality: "best_effort", status: "enqueued" }),
      ],
      [],
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toHaveLength(1);
    expect(verdict.blockers[0]?.requirementId).toBe("req_required");
  });

  it("multiple required, ONE blocked → NOT ready (exact multiset — count the blocker)", () => {
    const verdict = evaluateActivationReadiness(
      [
        req({ requirementId: "req_a", status: "enqueued" }),
        req({ requirementId: "req_b", status: "awaiting_grant" }),
        req({ requirementId: "req_c", status: "ready" }),
      ],
      [],
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toHaveLength(1);
    expect(verdict.blockers[0]?.requirementId).toBe("req_b");
  });

  it("ALL required pass → ready (POSITIVE evidence — not just NOT EXISTS bad, trap #4)", () => {
    const verdict = evaluateActivationReadiness(
      [req({ requirementId: "req_a", status: "enqueued" }), req({ requirementId: "req_b", status: "ready" })],
      [],
    );
    expect(verdict.ready).toBe(true);
  });
});

describe("evaluateActivationReadiness — materialization gaps (trap #4 vacuous-truth)", () => {
  it("a required requirement with NO capability node → NOT ready (fail-closed on the missing evaluation)", () => {
    // The empty-set trap: if we only checked `NOT EXISTS(bad status)` over
    // capability_nodes, a missing node would pass vacuously. The gap check
    // requires POSITIVE evidence the node EXISTS and was evaluated.
    const verdict = evaluateActivationReadiness([], [gap()]);
    expect(verdict.ready).toBe(false);
    expect(verdict.gaps).toHaveLength(1);
    expect(verdict.gaps[0]).toMatchObject({
      capability: "deploy.release",
      criticality: "release_required",
    });
  });

  it("an optional requirement with no node → ready (the gap only matters for required)", () => {
    const verdict = evaluateActivationReadiness([], [gap({ criticality: "best_effort" })]);
    expect(verdict.ready).toBe(true);
    expect(verdict.gaps).toEqual([]);
  });

  it("a required gap + a required pass node → NOT ready (the gap blocks even though a node passed)", () => {
    const verdict = evaluateActivationReadiness(
      [req({ requirementId: "req_present", status: "enqueued" })],
      [gap({ requirementId: "req_missing" })],
    );
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers).toHaveLength(0);
    expect(verdict.gaps).toHaveLength(1);
  });
});

describe("ProjectActivationReadinessBlockedError — typed fail-loud", () => {
  it("carries the blockers + gaps + projectId so the caller can surface them", () => {
    const verdict = evaluateActivationReadiness(
      [req({ capability: "messaging.send", status: "awaiting_grant", waitReason: "grant_absent:slack" })],
      [gap({ capability: "deploy.release" })],
    );
    const error = new ProjectActivationReadinessBlockedError("proj_test", verdict);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ProjectActivationReadinessBlockedError");
    expect(error.projectId).toBe("proj_test");
    expect(error.verdict.ready).toBe(false);
    expect(error.verdict.blockers[0]?.capability).toBe("messaging.send");
    expect(error.verdict.gaps[0]?.capability).toBe("deploy.release");
    expect(error.message).toMatch(/messaging\.send/u);
    expect(error.message).toMatch(/awaiting_grant/u);
    expect(error.message).toMatch(/deploy\.release/u);
    expect(error.message).toMatch(/no capability node materialized/u);
  });

  it("a ready verdict never produces an error in practice (the assertion throws only when !ready)", () => {
    const ready = evaluateActivationReadiness([req({ status: "enqueued" })], []);
    expect(ready.ready).toBe(true);
    // The error class is still constructible (it's just data), but
    // assertIntegrationActivationReadiness only throws when !ready.
    const error = new ProjectActivationReadinessBlockedError("proj_ok", ready);
    expect(error.verdict.blockers).toEqual([]);
    expect(error.verdict.gaps).toEqual([]);
  });
});
