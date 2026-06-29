// Audit round-2 H1 (triage half) — `routedToNewSpec` preserves the parent spec's
// writer-prompt MODE into the child remediation spec's `NewSpecRequest`. Without
// preservation, a child remediation spec from a `specialize_seed` parent would land
// `from_scratch` on materialization — the writer/checker/auditor/oracle would all
// run with the wrong standing instructions, re-emerging the v64-class contradiction
// PR #708 closed at the prompt layer one rung deeper. The fix mirrors the same
// "thread it through, don't lose it" doctrine PR #708 applied to checker/auditor
// prompts: triage carries the parent mode forward so the spec-creating contract
// that materializes the NewSpecRequest writes it into the child spec row's `mode`
// column. Absent on the helper ⇒ no `parentSpecMode` key on the request (matches
// the parent's own absent-default semantics).
import { describe, expect, it } from "vitest";

import { routedToNewSpec } from "../src/engine/workflow/loopFindings.js";

const sharedRouted = {
  item: {
    id: "wi_remediate_lint",
    title: "Fix lint",
    body: "the writer added an unused import",
    severity: "P1" as const,
    findingIds: ["finding_lint"],
  },
};

describe("routedToNewSpec — preserves parent spec mode (audit round-2 H1)", () => {
  // The default — no parent mode passed. The NewSpecRequest has no `parentSpecMode`
  // key, byte-identical to the legacy shape. A regression here would silently leak
  // an undefined `parentSpecMode` field into the request envelope.
  it("absent parentSpecMode → NO `parentSpecMode` key on the request (byte-identical to legacy)", () => {
    const req = routedToNewSpec(sharedRouted);
    expect(req.id).toBe("wi_remediate_lint");
    expect(req.title).toBe("Fix lint");
    expect(req.severity).toBe("P1");
    expect(req.findingIds).toEqual(["finding_lint"]);
    expect("parentSpecMode" in req).toBe(false);
  });

  // `specialize_seed` parent → the child request carries `parentSpecMode:
  // "specialize_seed"` so the spec-creating contract materializes the child in the
  // same mode. This is the actual fix — preserves the parent's writer-prompt mode
  // through the triage seam.
  it("parentSpecMode='specialize_seed' → request carries `parentSpecMode: specialize_seed`", () => {
    const req = routedToNewSpec(sharedRouted, "specialize_seed");
    expect(req.parentSpecMode).toBe("specialize_seed");
    // The rest of the request shape is identical — only the new field is added.
    expect(req.id).toBe("wi_remediate_lint");
    expect(req.title).toBe("Fix lint");
  });

  // Explicit `from_scratch` parent → carried forward identically. The consumer must
  // be able to distinguish "parent was explicitly from_scratch" from "no parent
  // mode given" if it later wants to (today both materialize as from_scratch, but
  // the discrimination is preserved for future use).
  it("parentSpecMode='from_scratch' → request carries `parentSpecMode: from_scratch`", () => {
    const req = routedToNewSpec(sharedRouted, "from_scratch");
    expect(req.parentSpecMode).toBe("from_scratch");
  });
});
