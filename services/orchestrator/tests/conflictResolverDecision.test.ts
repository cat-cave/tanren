// Unit tests for the PURE conflict-resolution decision core
// (engine/contracts/conflictResolution.ts `decideConflictResolution`). It maps a
// schema-validated ConflictAnswer + the two specs onto the action the resolver
// takes, enforcing the cross-field invariants the Zod schema cannot express
// alone — the guardrails that stop an empty/contradictory resolution from
// silently merging or a spec's intent from being silently dropped.

import { describe, expect, it } from "vitest";
import { ConflictAnswerInvalidError, decideConflictResolution } from "../src/engine/contracts/conflictResolution.js";
import { ConflictAnswer } from "../src/engine/answerers/schemas/index.js";

const specs = { mergingSpecId: "spec_merging", conflictingSpecId: "spec_base" };

describe("decideConflictResolution", () => {
  it("maps a 'resolve' with files to an apply action", () => {
    const answer = ConflictAnswer.parse({
      decision: "resolve",
      reasoning: "merged both APIs",
      resolvedFiles: [{ path: "src/router.ts", content: "export const router = {};\n" }],
      replanSpec: null,
    });
    const decision = decideConflictResolution(answer, specs);
    expect(decision.kind).toBe("apply");
    if (decision.kind !== "apply") throw new Error("unreachable");
    expect(decision.resolvedFiles).toEqual([{ path: "src/router.ts", content: "export const router = {};\n" }]);
  });

  it("REJECTS a 'resolve' with no files (an empty resolution must never merge)", () => {
    const answer = ConflictAnswer.parse({
      decision: "resolve",
      reasoning: "nothing to do",
      resolvedFiles: [],
      replanSpec: null,
    });
    expect(() => decideConflictResolution(answer, specs)).toThrow(ConflictAnswerInvalidError);
  });

  it("REJECTS a 'resolve' that also carries a replanSpec (contradictory)", () => {
    const answer = ConflictAnswer.parse({
      decision: "resolve",
      reasoning: "both",
      resolvedFiles: [{ path: "a.ts", content: "x" }],
      replanSpec: { which: "merging", newContext: "ctx" },
    });
    expect(() => decideConflictResolution(answer, specs)).toThrow(ConflictAnswerInvalidError);
  });

  it("routes 'irreconcilable' + which='merging' back to the MERGING spec with the base as other", () => {
    const answer = ConflictAnswer.parse({
      decision: "irreconcilable",
      reasoning: "the two schemas cannot coexist",
      resolvedFiles: [],
      replanSpec: { which: "merging", newContext: "the base added a unique index" },
    });
    const decision = decideConflictResolution(answer, specs);
    expect(decision.kind).toBe("irreconcilable");
    if (decision.kind !== "irreconcilable") throw new Error("unreachable");
    expect(decision.replan?.specId).toBe("spec_merging");
    expect(decision.replan?.which).toBe("merging");
    expect(decision.replan?.otherSpecId).toBe("spec_base");
    expect(decision.replan?.newContext).toContain("unique index");
  });

  it("routes 'irreconcilable' + which='base' back to the BASE spec with the merging as other", () => {
    const answer = ConflictAnswer.parse({
      decision: "irreconcilable",
      reasoning: "base must absorb the change",
      resolvedFiles: [],
      replanSpec: { which: "base", newContext: "the merging spec renamed the column" },
    });
    const decision = decideConflictResolution(answer, specs);
    if (decision.kind !== "irreconcilable") throw new Error("unreachable");
    expect(decision.replan?.specId).toBe("spec_base");
    expect(decision.replan?.otherSpecId).toBe("spec_merging");
  });

  it("REJECTS 'irreconcilable' with no replanSpec (a spec must be kept alive, never dropped)", () => {
    const answer = ConflictAnswer.parse({
      decision: "irreconcilable",
      reasoning: "stuck",
      resolvedFiles: [],
      replanSpec: null,
    });
    expect(() => decideConflictResolution(answer, specs)).toThrow(ConflictAnswerInvalidError);
  });

  it("REJECTS 'irreconcilable' routing the BASE spec when none was attributed", () => {
    const answer = ConflictAnswer.parse({
      decision: "irreconcilable",
      reasoning: "stuck",
      resolvedFiles: [],
      replanSpec: { which: "base", newContext: "ctx" },
    });
    expect(() => decideConflictResolution(answer, { mergingSpecId: "spec_merging" })).toThrow(
      ConflictAnswerInvalidError,
    );
  });

  it("REJECTS 'irreconcilable' that also carries resolved files (contradictory)", () => {
    const answer = ConflictAnswer.parse({
      decision: "irreconcilable",
      reasoning: "stuck",
      resolvedFiles: [{ path: "a.ts", content: "x" }],
      replanSpec: { which: "merging", newContext: "ctx" },
    });
    expect(() => decideConflictResolution(answer, specs)).toThrow(ConflictAnswerInvalidError);
  });
});
