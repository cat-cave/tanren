// Spec-quality contract tests — workstream 1 of the spec-loop redesign.
//
// Covers the four-part contract end to end:
//   1. The strict SpecQualityAnswer schema (malformed → throws, loud).
//   2. The `validateEmittedSpecs` gate: a good spec passes; a non-accomplishable /
//      untestable / illegible / trivial spec is REJECTED with guidance and looped
//      back to the emitter (bounded); a persistently-invalid spec surfaces LOUD
//      (PersistentlyInvalidSpecError), never a silent pass; a malformed validator
//      answer is fail-closed.
//   3. The reusable prompt contract is PRESENT in the spec-emitters (triage +
//      discovery) and the planner/writer prompts carry the grading/criteria text.

import { describe, expect, it } from "vitest";

import { SpecQualityAnswer, SPEC_QUALITY_CONTRACT_PROMPT } from "../src/engine/answerers/schemas/specQuality.js";
import {
  buildSpecQualityPrompt,
  validateEmittedSpecs,
  PersistentlyInvalidSpecError,
  type CandidateSpec,
  type SpecQualityAnswerer,
} from "../src/engine/forge/specQuality/index.js";
import { buildTriagePrompt } from "../src/engine/forge/inbox/index.js";
import { buildDiscoveryPrompt } from "../src/engine/forge/discovery/index.js";
import { buildPlannerPrompt } from "../src/engine/workflow/planner/planner.js";
import type { TriageAnswererContext } from "../src/engine/forge/inbox/index.js";
import type { DiscoveryAnswererContext } from "../src/engine/forge/discovery/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const goodSpec: CandidateSpec = {
  title: "Add a 'copy short link' button to the link list",
  description:
    "On the dashboard's link list, add a button next to each shortened link that copies its " +
    "short URL to the clipboard, so a user can share a link without selecting the text by hand.",
  acceptanceCriteria: [
    "given the link list, when the user clicks the copy button on a row, then that row's short URL is on the clipboard and a 'copied' toast shows",
  ],
};

const passAnswer: SpecQualityAnswer = {
  accomplishable: { pass: true, reason: "one bounded UI button change" },
  demoable: { pass: true, reason: "click the button, observe the toast + clipboard" },
  nonTrivial: { pass: true, reason: "involves clipboard + toast wiring, worth a spec" },
  legible: { pass: true, reason: "plain-language title + purpose" },
  overall: "pass",
  revisionGuidance: "",
};

function reviseAnswer(guidance: string): SpecQualityAnswer {
  return {
    accomplishable: { pass: false, reason: "spans the whole product" },
    demoable: { pass: false, reason: "no observable behavior named" },
    nonTrivial: { pass: true, reason: "large enough" },
    legible: { pass: false, reason: "jargon-only title" },
    overall: "revise",
    revisionGuidance: guidance,
  };
}

// A scripted validator: returns answers from a queue, recording the specs it saw.
function scriptedValidator(answers: SpecQualityAnswer[]): SpecQualityAnswerer & { seen: CandidateSpec[] } {
  const seen: CandidateSpec[] = [];
  let i = 0;
  return {
    seen,
    async validate(spec: CandidateSpec): Promise<SpecQualityAnswer> {
      seen.push(spec);
      const answer = answers[i++];
      if (answer === undefined) throw new Error("scriptedValidator ran out of answers");
      return answer;
    },
  };
}

// ---------------------------------------------------------------------------
// 1 · the strict schema
// ---------------------------------------------------------------------------

describe("SpecQualityAnswer schema", () => {
  it("accepts a well-formed pass answer", () => {
    expect(() => SpecQualityAnswer.parse(passAnswer)).not.toThrow();
  });

  it("throws (loud) on a malformed answer — missing a required dimension", () => {
    const malformed = { ...passAnswer } as Record<string, unknown>;
    delete malformed["legible"];
    expect(() => SpecQualityAnswer.parse(malformed)).toThrow(/legible/iu);
  });

  it("throws on an out-of-vocabulary overall verdict", () => {
    expect(() => SpecQualityAnswer.parse({ ...passAnswer, overall: "maybe" })).toThrow(/overall|enum|invalid/iu);
  });
});

// ---------------------------------------------------------------------------
// 2 · the validateEmittedSpecs gate
// ---------------------------------------------------------------------------

describe("validateEmittedSpecs", () => {
  it("passes a good spec on the first validation (0 revisions)", async () => {
    const validator = scriptedValidator([passAnswer]);
    const { specs } = await validateEmittedSpecs({ specs: [goodSpec], validator });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.revisions).toBe(0);
    expect(specs[0]!.answer.overall).toBe("pass");
    expect(specs[0]!.spec).toEqual(goodSpec);
  });

  it("loops a failing spec back to the emitter with the guidance, then passes", async () => {
    const validator = scriptedValidator([reviseAnswer("split it + add an observable criterion"), passAnswer]);
    const revisedSpec: CandidateSpec = { ...goodSpec, title: "Revised — copy link button" };
    const guidanceSeen: string[] = [];
    const { specs } = await validateEmittedSpecs({
      specs: [{ ...goodSpec, title: "Build the entire app" }],
      validator,
      reviseSpec: async ({ guidance }) => {
        guidanceSeen.push(guidance);
        return revisedSpec;
      },
    });
    // The revision guidance reached the emitter, and the revised spec was committed.
    expect(guidanceSeen).toEqual(["split it + add an observable criterion"]);
    expect(specs[0]!.revisions).toBe(1);
    expect(specs[0]!.spec).toEqual(revisedSpec);
    // The validator saw the revised spec on its second call.
    expect(validator.seen[1]).toEqual(revisedSpec);
  });

  it("escalates LOUD (PersistentlyInvalidSpecError) when the spec never passes within the budget", async () => {
    const validator = scriptedValidator([reviseAnswer("g1"), reviseAnswer("g2"), reviseAnswer("g3")]);
    await expect(
      validateEmittedSpecs({
        specs: [{ ...goodSpec, title: "Build the entire app" }],
        validator,
        reviseSpec: async () => ({ ...goodSpec, title: "still too big" }),
        maxRevisions: 2,
      }),
    ).rejects.toBeInstanceOf(PersistentlyInvalidSpecError);
  });

  it("with NO reviseSpec, a first-pass failure escalates immediately (never silently accepted)", async () => {
    const validator = scriptedValidator([reviseAnswer("needs work")]);
    await expect(validateEmittedSpecs({ specs: [goodSpec], validator })).rejects.toBeInstanceOf(
      PersistentlyInvalidSpecError,
    );
  });

  it("is fail-closed: a thrown (malformed) validator answer escalates, not a silent pass", async () => {
    const validator: SpecQualityAnswerer = {
      async validate() {
        throw new Error("schema parse failed");
      },
    };
    await expect(validateEmittedSpecs({ specs: [goodSpec], validator })).rejects.toBeInstanceOf(
      PersistentlyInvalidSpecError,
    );
  });

  it("rejects each contract dimension's failure mode (oversized / untestable / illegible / trivial)", async () => {
    const dims = ["accomplishable", "demoable", "legible", "nonTrivial"] as const;
    for (const failing of dims) {
      const answer: SpecQualityAnswer = {
        accomplishable: { pass: failing !== "accomplishable", reason: "r" },
        demoable: { pass: failing !== "demoable", reason: "r" },
        legible: { pass: failing !== "legible", reason: "r" },
        nonTrivial: { pass: failing !== "nonTrivial", reason: "r" },
        overall: "revise",
        revisionGuidance: `fix ${failing}`,
      };
      const validator = scriptedValidator([answer]);
      await expect(validateEmittedSpecs({ specs: [goodSpec], validator })).rejects.toBeInstanceOf(
        PersistentlyInvalidSpecError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3 · the prompt contract is present in the validator + the spec-emitters
// ---------------------------------------------------------------------------

describe("spec-quality prompt contract presence", () => {
  it("the validator prompt renders the contract + the spec under judgement", () => {
    const prompt = buildSpecQualityPrompt(goodSpec);
    expect(prompt).toContain(SPEC_QUALITY_CONTRACT_PROMPT);
    expect(prompt).toContain(goodSpec.title);
    expect(prompt).toContain("Spec-Quality Validator");
    expect(prompt).toContain("Return exactly one SpecQualityAnswer");
  });

  it("the issue-triage emitter prompt injects the contract", () => {
    const ctx: TriageAnswererContext = {
      candidate: { title: "t", body: "b", severity: "info", sourceKind: "issues", projectId: "p" },
      source: {
        id: "s",
        orgId: "o",
        projectId: "p",
        kind: "issues",
        name: "gh",
        detail: "",
        config: {},
        enabled: true,
        autoRoute: false,
      },
      existingSpecs: [],
    };
    expect(buildTriagePrompt(ctx)).toContain(SPEC_QUALITY_CONTRACT_PROMPT);
  });

  it("the discovery emitter prompt injects the contract", () => {
    const ctx: DiscoveryAnswererContext = {
      insight: {
        variant: "feature",
        source: "src",
        sourceLabel: "label",
        who: "who",
        when: "when",
        glyph: "◍",
        body: "body",
      },
      projectId: "p",
      existingSpecs: [],
    };
    expect(buildDiscoveryPrompt(ctx)).toContain(SPEC_QUALITY_CONTRACT_PROMPT);
  });
});

// ---------------------------------------------------------------------------
// 4 · planner/writer criteria-awareness (prompt only)
// ---------------------------------------------------------------------------

describe("planner/writer grading-criteria awareness", () => {
  it("the planner prompt names the gate + checker + auditor + demo grading bars", () => {
    const prompt = buildPlannerPrompt({
      timeoutMs: 1000,
      rejectionHistory: [],
      spec: {
        specTitle: "T",
        specDescription: "D",
        acceptanceCriteria: ["c1"],
        behaviorIds: [],
        behaviorContext: [],
      },
    });
    expect(prompt).toContain("How the resulting work is graded");
    expect(prompt).toContain("DETERMINISTIC GATE");
    expect(prompt).toContain("CHECKER");
    expect(prompt).toContain("AUDITOR");
    expect(prompt).toContain("DEMO");
  });
});
