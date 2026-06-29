// Audit finding #7 (v65 doctrine): the CHECKER + AUDITOR prompts are MODE-AWARE.
// PR #704 made the writer mode-aware; the checker + auditor were left blind. A
// mode-blind checker that emits "you didn't set up tests/configs" for a tiny
// specialize-seed diff, or a mode-blind auditor emitting a P1 about "no test
// coverage for the new entrypoint", wedges merge for any spec whose surfaces
// pre-existed in the composed seed — the exact v64 contradiction class one rung
// downstream from the writer fix.
//
// The fix mirrors the writer's `WRITER_SPECIALIZE_SEED_GRADING_INSTRUCTION` shape:
// when `specMode === "specialize_seed"`, BOTH prompts append a seeded-mode tail
// block that tells the answerer the composed seed is pre-existing + proven green
// and that pre-existing seed surfaces (manifest, lockfile, tsconfig, lint/test/
// build configs, contract files, source skeleton, demo) are NOT findings — only
// gaps in the product-specific surfaces this spec was supposed to deliver. When
// `specMode === "from_scratch"` (the default) the block is ABSENT — brownfield/
// legacy specs see the byte-identical legacy prompt.

import { describe, expect, it } from "vitest";
import { buildAuditorPrompt, buildCheckerPrompt } from "../src/engine/workflow/answererPrompts.js";

const STUB_OUTPUT = ["(stub output instructions for the test)"];

const SHARED = {
  specTitle: "Specialize the greenfield app",
  specDescription: "SEED FROM TEMPLATE — INSTANTIATE the seed for THIS product.",
  acceptanceCriteria: ["given the seeded repo, when scaffold lands, then identity is product-specific"],
  baselineSha: "abc123",
};

describe("buildCheckerPrompt — seeded-mode tail block (audit finding #7)", () => {
  // The DEFAULT (no specMode) — byte-identical to the legacy checker prompt the
  // brownfield/legacy specs already see. A regression here would mean the
  // mode-aware tail block leaked into every checker prompt.
  it("specMode absent → NO seeded-mode tail block (byte-identical to the legacy prompt)", () => {
    const prompt = buildCheckerPrompt({ ...SHARED, outputInstructions: STUB_OUTPUT });
    expect(prompt).not.toContain("SPECIALIZE-SEED mode");
    expect(prompt).not.toContain("composed seed is PRE-EXISTING");
    expect(prompt).not.toContain("Do NOT cite any of those pre-existing");
  });

  // `from_scratch` is the explicit default; byte-identical to absent. Asserts the
  // two paths render the same prompt, so a future caller that explicitly passes
  // `from_scratch` doesn't silently diverge from one that omits it.
  it("specMode='from_scratch' → NO seeded-mode tail block (byte-identical to absent)", () => {
    const explicit = buildCheckerPrompt({ ...SHARED, specMode: "from_scratch", outputInstructions: STUB_OUTPUT });
    const absent = buildCheckerPrompt({ ...SHARED, outputInstructions: STUB_OUTPUT });
    expect(explicit).toBe(absent);
    expect(explicit).not.toContain("SPECIALIZE-SEED mode");
  });

  // The actual fix — `specialize_seed` mode emits the tail block. Pins the key
  // phrases the prompt MUST carry so the answerer reads "seed surfaces are NOT
  // findings; only product-specific gaps are."
  it("specMode='specialize_seed' → emits the seeded-mode tail block (scopes off seed surfaces)", () => {
    const prompt = buildCheckerPrompt({ ...SHARED, specMode: "specialize_seed", outputInstructions: STUB_OUTPUT });
    // The banner + the pre-existing + proven-green framing.
    expect(prompt).toContain("SPECIALIZE-SEED mode");
    expect(prompt).toContain("composed seed is PRE-EXISTING and PROVEN GREEN");
    // The enumerated pre-existing surfaces the checker MUST NOT cite as findings.
    expect(prompt).toContain("manifest, lockfile, tsconfig, lint/test/build configs");
    // The block is line-wrapped in the prompt source ("contract" ends one line,
    // "files (justfile + .tanren/ci.yml)" starts the next). Assert each half.
    expect(prompt).toMatch(/contract\s+files \(justfile \+ \.tanren\/ci\.yml\)/u);
    expect(prompt).toContain("source skeleton, and demo");
    // The explicit rule — pre-existing seed surfaces are NOT findings; only the
    // product-specific gaps named by the acceptance criteria are.
    expect(prompt).toContain("Do NOT cite any of those pre-existing");
    expect(prompt).toContain("PRODUCT-");
    expect(prompt).toContain("SPECIFIC surfaces this spec was supposed to deliver");
    // The two concrete false-finding examples the writer fix names, mirrored here.
    expect(prompt).toContain("no tests for the new entrypoint");
    expect(prompt).toContain("missing");
    expect(prompt).toContain("lint config");
  });

  // The seeded-mode block goes near the END of the prompt — after the spec/
  // criteria/subtask block, before the output-instructions tail. That mirrors the
  // writer-prompt placement: the last block the agent reads is the strongest
  // signal on a re-iteration (the v64 reordering doctrine, defensive).
  it("places the seeded-mode block AFTER the spec/criteria block (last-position strongest-signal placement)", () => {
    const prompt = buildCheckerPrompt({
      ...SHARED,
      specMode: "specialize_seed",
      subtask: {
        index: 0,
        title: "Specialize identity",
        intent: "Rename product placeholders",
        behaviorIds: [],
      },
      outputInstructions: STUB_OUTPUT,
    });
    const criteriaIndex = prompt.indexOf("Explicit acceptance criteria");
    const subtaskIndex = prompt.indexOf("Subtask [0]:");
    const seededIndex = prompt.indexOf("SPECIALIZE-SEED mode");
    const outputIndex = prompt.indexOf(STUB_OUTPUT[0]!);
    expect(criteriaIndex).toBeGreaterThan(0);
    expect(subtaskIndex).toBeGreaterThan(criteriaIndex);
    expect(seededIndex).toBeGreaterThan(subtaskIndex);
    expect(outputIndex).toBeGreaterThan(seededIndex);
  });
});

describe("buildAuditorPrompt — seeded-mode tail block (audit finding #7)", () => {
  // Mirror set: absent ⇒ no block (the brownfield/legacy byte-shape).
  it("specMode absent → NO seeded-mode tail block (byte-identical to the legacy prompt)", () => {
    const prompt = buildAuditorPrompt({ ...SHARED, outputInstructions: STUB_OUTPUT });
    expect(prompt).not.toContain("SPECIALIZE-SEED mode");
    expect(prompt).not.toContain("composed seed is PRE-EXISTING");
  });

  // Explicit from_scratch ⇒ byte-identical to absent.
  it("specMode='from_scratch' → NO seeded-mode tail block (byte-identical to absent)", () => {
    const explicit = buildAuditorPrompt({ ...SHARED, specMode: "from_scratch", outputInstructions: STUB_OUTPUT });
    const absent = buildAuditorPrompt({ ...SHARED, outputInstructions: STUB_OUTPUT });
    expect(explicit).toBe(absent);
  });

  // The fix: `specialize_seed` emits the tail block. The auditor's seed-surface
  // scope-off is the same shape as the checker's — pre-existing seed surfaces are
  // not quality findings; only product-specific gaps are.
  it("specMode='specialize_seed' → emits the seeded-mode tail block (scopes off seed surfaces)", () => {
    const prompt = buildAuditorPrompt({ ...SHARED, specMode: "specialize_seed", outputInstructions: STUB_OUTPUT });
    expect(prompt).toContain("SPECIALIZE-SEED mode");
    expect(prompt).toContain("composed seed is PRE-EXISTING and PROVEN GREEN");
    expect(prompt).toContain("manifest, lockfile, tsconfig, lint/test/build configs");
    // The block is line-wrapped in the prompt source ("contract" ends one line,
    // "files (justfile + .tanren/ci.yml)" starts the next). Assert each half.
    expect(prompt).toMatch(/contract\s+files \(justfile \+ \.tanren\/ci\.yml\)/u);
    expect(prompt).toContain("Do NOT cite any of those pre-existing");
    expect(prompt).toContain("no tests for the new entrypoint");
  });

  // Same placement doctrine: the seeded-mode block lands AFTER the spec/criteria/
  // executed-subtasks block + the optional checker-answer block, just before the
  // output instructions — the strongest-signal last-position.
  it("places the seeded-mode block AFTER the spec/subtasks block (last-position strongest-signal placement)", () => {
    const prompt = buildAuditorPrompt({
      ...SHARED,
      specMode: "specialize_seed",
      subtasks: [{ index: 0, title: "Specialize identity", intent: "Rename placeholders", behaviorIds: [] }],
      outputInstructions: STUB_OUTPUT,
    });
    const criteriaIndex = prompt.indexOf("Acceptance criteria:");
    const subtasksIndex = prompt.indexOf("Executed subtasks:");
    const seededIndex = prompt.indexOf("SPECIALIZE-SEED mode");
    const outputIndex = prompt.indexOf(STUB_OUTPUT[0]!);
    expect(criteriaIndex).toBeGreaterThan(0);
    expect(subtasksIndex).toBeGreaterThan(criteriaIndex);
    expect(seededIndex).toBeGreaterThan(subtasksIndex);
    expect(outputIndex).toBeGreaterThan(seededIndex);
  });
});
