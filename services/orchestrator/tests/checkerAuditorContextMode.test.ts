// Audit finding #7 (v65 doctrine): the spec mode must be THREADED through
// `CheckerSubtaskContext` and `AuditorSpecContext` — not just exposed on the
// underlying prompt builder. These context types are the only legitimate seam the
// stages (`subtaskStages.ts` + `auditorStage.ts`) construct prompts through, so a
// missing field at THIS layer means the mode never reaches the answerer no matter
// how aware the prompt builder is.
//
// Pairs with `answererPromptsMode.test.ts` (the prompt builder branches on mode)
// + the reGate threading; together they prove the END-TO-END plumbing.

import { describe, expect, it } from "vitest";
import type { PlanSubtask } from "../src/engine/answerers/schemas/index.js";
import { buildCheckerPrompt } from "../src/engine/workflow/checker/checker.js";
import { buildAuditorPrompt } from "../src/engine/workflow/auditor/auditor.js";

const SUBTASK: PlanSubtask = {
  index: 0,
  title: "Specialize identity",
  intent: "Rename product placeholders",
  behaviorIds: [],
};

const CHECKER_BASE = {
  specTitle: "Specialize the greenfield app",
  specDescription: "SEED FROM TEMPLATE — INSTANTIATE the seed for THIS product.",
  acceptanceCriteria: ["given the seeded repo, when scaffold lands, then identity is product-specific"],
  subtask: SUBTASK,
  baselineSha: "abc123",
};

const AUDITOR_BASE = {
  specTitle: CHECKER_BASE.specTitle,
  specDescription: CHECKER_BASE.specDescription,
  acceptanceCriteria: CHECKER_BASE.acceptanceCriteria,
  subtasks: [SUBTASK],
  baselineSha: "abc123",
};

describe("CheckerSubtaskContext — specMode threads through to the prompt", () => {
  // Absent specMode ⇒ legacy prompt (no seeded-mode block). The stage call sites
  // omit specMode for the from_scratch default; this proves that path is unchanged.
  it("specMode absent on the context → NO seeded-mode tail block in the prompt", () => {
    const prompt = buildCheckerPrompt(CHECKER_BASE);
    expect(prompt).not.toContain("SPECIALIZE-SEED mode");
  });

  // specMode='specialize_seed' on the context ⇒ the prompt builder emits the
  // seeded-mode tail block. This proves the checker.ts context → answererPrompts
  // bridge actually threads the field (a regression that dropped the `specMode`
  // spread would silently leave EVERY checker call mode-blind).
  it("specMode='specialize_seed' on the context → the prompt carries the seeded-mode block", () => {
    const prompt = buildCheckerPrompt({ ...CHECKER_BASE, specMode: "specialize_seed" });
    expect(prompt).toContain("SPECIALIZE-SEED mode");
    expect(prompt).toContain("composed seed is PRE-EXISTING and PROVEN GREEN");
  });

  // Explicit from_scratch is byte-identical to absent — the context layer doesn't
  // silently diverge between the two paths.
  it("specMode='from_scratch' on the context → byte-identical to absent (legacy prompt)", () => {
    const explicit = buildCheckerPrompt({ ...CHECKER_BASE, specMode: "from_scratch" });
    const absent = buildCheckerPrompt(CHECKER_BASE);
    expect(explicit).toBe(absent);
  });
});

describe("AuditorSpecContext — specMode threads through to the prompt", () => {
  it("specMode absent on the context → NO seeded-mode tail block in the prompt", () => {
    const prompt = buildAuditorPrompt(AUDITOR_BASE);
    expect(prompt).not.toContain("SPECIALIZE-SEED mode");
  });

  it("specMode='specialize_seed' on the context → the prompt carries the seeded-mode block", () => {
    const prompt = buildAuditorPrompt({ ...AUDITOR_BASE, specMode: "specialize_seed" });
    expect(prompt).toContain("SPECIALIZE-SEED mode");
    expect(prompt).toContain("composed seed is PRE-EXISTING and PROVEN GREEN");
  });

  it("specMode='from_scratch' on the context → byte-identical to absent (legacy prompt)", () => {
    const explicit = buildAuditorPrompt({ ...AUDITOR_BASE, specMode: "from_scratch" });
    const absent = buildAuditorPrompt(AUDITOR_BASE);
    expect(explicit).toBe(absent);
  });
});
