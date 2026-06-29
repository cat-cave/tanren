// Task #86 — v64 root cause: the writer prompt is MODE-AWARE so the standing
// instructions match what the workspace actually looks like at the writer's first
// iteration. Two modes:
//
// - `from_scratch` (DEFAULT — brownfield + non-scaffold specs): the workspace is the
//   project's existing tree (or an empty repo). The standing GRADING instruction tells
//   the writer to "Build everything ELSE — manifest/lockfile, sources, configs, tests,
//   fixtures" and to regenerate the lockfile after a manifest edit.
// - `specialize_seed` (greenfield's scaffold spec post-PR-G): the workspace's initial
//   commit IS the composed seed — manifest, lockfile, tsconfig, lint/test/build configs,
//   contract files, source skeleton, demo are ALREADY in place and proven green by
//   composition. The writer is told to touch ONLY product-identity surfaces and is
//   explicitly forbidden from rebuilding the manifest, regenerating the lockfile,
//   editing configs, or adding new tests.
//
// v64 spent 6 hours / 61 writer iterations without converging because the spec text
// said "INSTANTIATE the seed" but the standing instructions said "Build everything
// ELSE — manifest/lockfile, sources, configs, tests, fixtures" — each iteration the
// writer kept doing what the standing instructions said, checker kept catching the
// scope drift, but each iteration was a DIFFERENT over-broad diff so the fixed-point
// detector never fired. These tests pin the byte shape of both standing instruction
// sets so a future edit cannot silently regress the fix.

import { describe, expect, it } from "vitest";
import type { PlanSubtask } from "../src/engine/answerers/schemas/index.js";
import type { SpecMode } from "../src/engine/state/spec.js";
import { writerPromptFor } from "../src/engine/workflow/subtaskWriterPrompt.js";
import type { SubtaskLoopInput } from "../src/engine/workflow/subtaskLoop.js";

// A minimal SubtaskLoopInput-shaped object — only the fields `writerPromptFor()` reads
// are populated. Mode defaults are passed through (`specMode` omitted → from_scratch).
function inputWith(overrides: Partial<{ specMode: SpecMode; designContextBlock: string }>): SubtaskLoopInput {
  return {
    context: {
      specTitle: "Scaffold the greenfield app",
      specDescription: "SEED FROM TEMPLATE — do NOT author from scratch; INSTANTIATE the seed.",
      acceptanceCriteria: ["given the seeded repo, when scaffold lands, then product identity is adapted"],
      behaviorIds: [],
      behaviorContext: [],
      runId: "run_test",
      specId: "spec_test",
      projectId: "project_test",
      workspacePath: "/workspace/runs/run_test/repo",
      ...(overrides.specMode !== undefined && { specMode: overrides.specMode }),
      ...(overrides.designContextBlock !== undefined && { designContextBlock: overrides.designContextBlock }),
    },
  } as unknown as SubtaskLoopInput;
}

const subtask: PlanSubtask = {
  index: 0,
  title: "Specialize the seed",
  intent: "Rename product identity",
  behaviorIds: [],
};

describe("writerPromptFor — mode-aware standing instructions (task #86)", () => {
  // The `from_scratch` mode is the brownfield/legacy authoring default. The standing
  // instructions match today's WRITER_GRADING_INSTRUCTION + WRITER_CONTRACT_INSTRUCTION
  // verbatim — every existing brownfield/legacy spec keeps byte-identical writer prompts.
  it("from_scratch mode emits the legacy 'build everything ELSE / regenerate lockfile' grading instructions", () => {
    const prompt = writerPromptFor(inputWith({ specMode: "from_scratch" }), subtask, 0, "");
    // The from-scratch grading text is preserved verbatim.
    expect(prompt).toContain("How your change will be graded");
    expect(prompt).toContain("Build everything ELSE");
    expect(prompt).toContain("manifest/lockfile, sources, configs, tests, fixtures");
    expect(prompt).toContain("RECONCILE generated companions");
    expect(prompt).toContain("project's declared install or bootstrap step");
    expect(prompt).toContain("bump to newer PUBLISHED versions");
    expect(prompt).toContain("frozen-lockfile gate");
    // The contract instruction still names the IMMUTABLE-CONTRACT set.
    expect(prompt).toContain("DECLARED CONTRACT files are FIXED");
    expect(prompt).toContain("justfile");
    expect(prompt).toContain(".tanren/ci.yml");
    // The seeded-mode instruction is NOT present in from_scratch mode.
    expect(prompt).not.toContain("SPECIALIZE-SEED mode");
    expect(prompt).not.toContain("seed's pre-existing");
  });

  // An ABSENT `specMode` defaults to `from_scratch` — the byte-identical-to-before-this-
  // change behavior for every existing brownfield/legacy spec. A regression here would
  // mean a code path lost the default and silently flipped a brownfield run into seeded
  // mode (or vice versa).
  it("an absent specMode defaults to from_scratch — byte-identical to before this field landed", () => {
    const explicit = writerPromptFor(inputWith({ specMode: "from_scratch" }), subtask, 0, "");
    const defaulted = writerPromptFor(inputWith({}), subtask, 0, "");
    expect(defaulted).toBe(explicit);
  });

  // The `specialize_seed` mode tells the writer the composed seed is already in place +
  // proven green, enumerates the pre-existing surfaces, and forbids manifest/lockfile/
  // config/test churn. This is the FIX for v64 — the standing instructions stop
  // contradicting the "INSTANTIATE the seed" spec text.
  it("specialize_seed mode emits the seeded-mode grading instructions (no manifest/lockfile/config churn)", () => {
    const prompt = writerPromptFor(inputWith({ specMode: "specialize_seed" }), subtask, 0, "");
    // The seeded-mode banner + the "seed already in place + proven green" framing.
    expect(prompt).toContain("SPECIALIZE-SEED mode");
    expect(prompt).toContain("workspace's initial commit IS the composed seed");
    expect(prompt).toContain("ALREADY IN PLACE and PROVEN GREEN by composition");
    // The pre-existing surfaces are enumerated.
    expect(prompt).toContain("manifest, lockfile, tsconfig, lint/test/build");
    expect(prompt).toContain("contract files (justfile + .tanren/ci.yml)");
    // The product-identity surfaces the writer MAY touch.
    expect(prompt).toContain("product-identity surfaces");
    expect(prompt).toContain("acceptance criteria");
    // The explicit forbids — no rebuilding the manifest, regenerating lockfile, editing
    // configs, adding new tests, or touching the contract files.
    expect(prompt).toContain("do NOT regenerate the lockfile");
    expect(prompt).toContain("do NOT edit tsconfig / lint configs / test configs / build");
    expect(prompt).toContain("do NOT add new tests");
    expect(prompt).toContain("do NOT add or edit the contract files");
    // The "fix the surface YOU touched, never reach for the seed's pre-existing config" rule.
    expect(prompt).toContain("NEVER reach for the seed's pre-existing");
    // The v64-rooted contradiction is GONE: no "Build everything ELSE" framing.
    expect(prompt).not.toContain("Build everything ELSE");
    expect(prompt).not.toContain("manifest/lockfile, sources, configs, tests, fixtures");
    // The lockfile-regeneration / package-manager-upgrade rules are dropped (they don't
    // apply — there ARE no manifest edits in seeded mode).
    expect(prompt).not.toContain("RECONCILE generated companions");
    expect(prompt).not.toContain("frozen-lockfile gate");
    expect(prompt).not.toContain("bump to newer PUBLISHED versions");
  });

  // The contract-file rule still applies in seeded mode, but its framing matches the
  // seed: the seed already includes them in their proven-green shape and specialization
  // never modifies them. The "build everything ELSE" framing is dropped.
  it("specialize_seed mode keeps the immutable-contract rule but drops the 'build everything ELSE' framing", () => {
    const prompt = writerPromptFor(inputWith({ specMode: "specialize_seed" }), subtask, 0, "");
    expect(prompt).toContain("DECLARED CONTRACT files are FIXED");
    expect(prompt).toContain("justfile");
    expect(prompt).toContain(".tanren/ci.yml");
    expect(prompt).toContain("seed already includes them in their proven-green composed");
    // The from_scratch contract instruction's "Build everything ELSE" line is gone here.
    expect(prompt).not.toContain("the contract your work SATISFIES, not changes. Build everything ELSE");
  });

  // The TOOLCHAIN instruction is mode-independent — both modes honor "use the project's
  // OWN declared dependencies + toolchain; never stub/fake/shim." The realness rule is
  // not about scaffolding scope; it is about the writer never inventing fake binaries.
  it("the standing TOOLCHAIN instruction is mode-independent (both modes get it)", () => {
    const fromScratch = writerPromptFor(inputWith({ specMode: "from_scratch" }), subtask, 0, "");
    const seeded = writerPromptFor(inputWith({ specMode: "specialize_seed" }), subtask, 0, "");
    for (const prompt of [fromScratch, seeded]) {
      expect(prompt).toContain("project's OWN declared dependencies and toolchain");
      expect(prompt).toContain("NEVER stub, fake, vendor, or shim");
    }
  });

  // PLACEMENT (task #86 — defensive). The rework block goes AFTER the standing
  // instructions, not before them. The writer reads top→bottom and weights the LAST
  // thing it reads most heavily on a re-iteration; in v64 the order was (spec
  // "INSTANTIATE the seed") → (rework reason "previous attempt had scope drift") →
  // (standing "build everything ELSE"). The standing instruction WON every iteration
  // because it was last. The seeded-mode rewrite removes that contradiction, but the
  // placement matters defensively: putting the concrete failing reason LAST means it is
  // the strongest signal on every re-drive, regardless of mode.
  it("places the rework reason AFTER the standing instructions on iter > 0 (defensive placement)", () => {
    const prompt = writerPromptFor(
      inputWith({ specMode: "from_scratch" }),
      subtask,
      1,
      "you over-edited the tsconfig out of scope",
    );
    const standingIndex = prompt.indexOf("How your change will be graded");
    const reworkIndex = prompt.indexOf("Previous attempt was rejected:");
    expect(standingIndex).toBeGreaterThan(0);
    expect(reworkIndex).toBeGreaterThan(0);
    expect(reworkIndex).toBeGreaterThan(standingIndex);
    expect(prompt).toContain("you over-edited the tsconfig out of scope");
    expect(prompt).toContain("Address it directly.");
  });

  // Same defensive placement applies to seeded mode — the standing block ends with the
  // seeded grading instruction, then the rework block comes after.
  it("places the rework reason AFTER the seeded-mode standing instructions on iter > 0", () => {
    const prompt = writerPromptFor(
      inputWith({ specMode: "specialize_seed" }),
      subtask,
      1,
      "you regenerated the lockfile (out of scope for seeded specialization)",
    );
    const standingIndex = prompt.indexOf("SPECIALIZE-SEED mode");
    const reworkIndex = prompt.indexOf("Previous attempt was rejected:");
    expect(standingIndex).toBeGreaterThan(0);
    expect(reworkIndex).toBeGreaterThan(0);
    expect(reworkIndex).toBeGreaterThan(standingIndex);
    expect(prompt).toContain("you regenerated the lockfile");
  });

  // The first iteration (iter 0) has no rework block — the prompt ends with the standing
  // grading instruction.
  it("iter 0 has no rework block (the writer has nothing to address yet)", () => {
    const prompt = writerPromptFor(inputWith({}), subtask, 0, "");
    expect(prompt).not.toContain("Previous attempt was rejected:");
    expect(prompt).not.toContain("Address it directly.");
  });
});
