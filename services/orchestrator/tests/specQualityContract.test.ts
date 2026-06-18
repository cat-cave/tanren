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

import {
  SpecQualityAnswer,
  SPEC_QUALITY_CONTRACT_PROMPT,
  specQualityContractPrompt,
} from "../src/engine/answerers/schemas/specQuality.js";
import {
  buildSpecQualityPrompt,
  buildSpecRevisionPrompt,
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
// `reAuthor` (the gate's BUILT-IN default re-author): when `reAuthorImpl` is supplied,
// it is the loopback the gate uses absent an emitter `reviseSpec` — proving the gate
// genuinely re-authors before escalating. Absent ⇒ no `reAuthor` (the genuine strict
// gate: no way to re-author at all).
function scriptedValidator(
  answers: SpecQualityAnswer[],
  reAuthorImpl?: (spec: CandidateSpec, guidance: string) => Promise<CandidateSpec>,
): SpecQualityAnswerer & { seen: CandidateSpec[]; reAuthorGuidance: string[] } {
  const seen: CandidateSpec[] = [];
  const reAuthorGuidance: string[] = [];
  let i = 0;
  const base = {
    seen,
    reAuthorGuidance,
    async validate(spec: CandidateSpec): Promise<SpecQualityAnswer> {
      seen.push(spec);
      const answer = answers[i++];
      if (answer === undefined) throw new Error("scriptedValidator ran out of answers");
      return answer;
    },
  };
  if (reAuthorImpl === undefined) return base;
  return {
    ...base,
    async reAuthor(spec: CandidateSpec, guidance: string): Promise<CandidateSpec> {
      reAuthorGuidance.push(guidance);
      return reAuthorImpl(spec, guidance);
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

  it("escalates LOUD (PersistentlyInvalidSpecError) at a genuine FIXED POINT — identical rejection, no progress", async () => {
    // The validator rejects the spec the IDENTICAL way every round (same failing
    // dimensions) — a fixed point with no progress, so it escalates loud (no count).
    const validator = scriptedValidator([reviseAnswer("g1"), reviseAnswer("g2"), reviseAnswer("g3")]);
    await expect(
      validateEmittedSpecs({
        specs: [{ ...goodSpec, title: "Build the entire app" }],
        validator,
        reviseSpec: async () => ({ ...goodSpec, title: "still too big" }),
      }),
    ).rejects.toBeInstanceOf(PersistentlyInvalidSpecError);
  });

  it("keeps revising UNBOUNDED while the verdict IMPROVES (the failing set shrinks), then passes", async () => {
    // Round 0: three dimensions fail. Round 1: only one fails (progress — the set
    // shrank). Round 2: passes. A fixed 2-round cap would have escalated at round 2;
    // the convergence model keeps going because each round made progress.
    const threeBad: SpecQualityAnswer = {
      accomplishable: { pass: false, reason: "too big" },
      demoable: { pass: false, reason: "no observable behavior" },
      nonTrivial: { pass: true, reason: "large enough" },
      legible: { pass: false, reason: "jargon" },
      overall: "revise",
      revisionGuidance: "split + add criteria + plain language",
    };
    const oneBad: SpecQualityAnswer = {
      accomplishable: { pass: true, reason: "bounded now" },
      demoable: { pass: false, reason: "still no observable behavior" },
      nonTrivial: { pass: true, reason: "ok" },
      legible: { pass: true, reason: "ok" },
      overall: "revise",
      revisionGuidance: "add an observable acceptance criterion",
    };
    const validator = scriptedValidator([threeBad, oneBad, passAnswer]);
    let rounds = 0;
    const { specs } = await validateEmittedSpecs({
      specs: [{ ...goodSpec, title: "Build the entire app" }],
      validator,
      reviseSpec: async () => {
        rounds += 1;
        return { ...goodSpec, title: `revision ${rounds}` };
      },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.revisions).toBe(2);
    expect(specs[0]!.answer.overall).toBe("pass");
    expect(rounds).toBe(2);
  });

  it("with NO emitter reviseSpec but a validator BUILT-IN re-author, it re-authors the failing spec (no escalate-after-0), then passes", async () => {
    // The v38 strand: a spec failing validation escalated "after 0 revision(s)" because
    // the planner/triage gate wired no emitter `reviseSpec`. The fix: the validator's
    // BUILT-IN re-author is the default loopback — so the gate GENUINELY attempts guided
    // re-authoring (feeding the validator's guidance back) BEFORE any escalation.
    const revised: CandidateSpec = { ...goodSpec, title: "Re-authored — copy link button" };
    const validator = scriptedValidator(
      [reviseAnswer("define the jargon + add criteria"), passAnswer],
      async () => revised,
    );
    const { specs } = await validateEmittedSpecs({ specs: [{ ...goodSpec, title: "opaque jargon" }], validator });
    // It re-authored with the validator's guidance (never escalated after 0) and passed.
    expect(validator.reAuthorGuidance).toEqual(["define the jargon + add criteria"]);
    expect(specs[0]!.revisions).toBe(1);
    expect(specs[0]!.spec).toEqual(revised);
    expect(specs[0]!.answer.overall).toBe("pass");
  });

  it("escalates only after REAL guided re-authoring (non-convergence), never after 0 revisions", async () => {
    // A genuinely-unfixable spec: the built-in re-author keeps producing a spec the
    // validator rejects the IDENTICAL way. It escalates LOUD — but only at a genuine
    // fixed point (≥2 data points proving no progress), NEVER "after 0 revision(s)".
    const validator = scriptedValidator([reviseAnswer("g1"), reviseAnswer("g2"), reviseAnswer("g3")], async () => ({
      ...goodSpec,
      title: "still opaque",
    }));
    await expect(validateEmittedSpecs({ specs: [{ ...goodSpec, title: "opaque" }], validator })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PersistentlyInvalidSpecError &&
        error.revisions >= 1 &&
        // A real guided re-author was attempted (at least one round) before escalation.
        validator.reAuthorGuidance.length > 0,
    );
  });

  it("with NO reviseSpec AND no built-in re-author (a validate-only fake), a first-pass failure escalates (genuine strict gate)", async () => {
    const validator = scriptedValidator([reviseAnswer("needs work")]);
    await expect(validateEmittedSpecs({ specs: [goodSpec], validator })).rejects.toBeInstanceOf(
      PersistentlyInvalidSpecError,
    );
  });

  it("a TEMPLATE-CREATION technical spec is NOT rejected for legitimate technical vocabulary (audience-scoped LEGIBLE bar)", async () => {
    // A template-build's internal spec ("scaffold / merge-tier / mutation testing /
    // template manifest") carries `audience: technical`. The validator prompt rendered
    // for it judges LEGIBILITY on the engineer bar — legitimate domain vocabulary is
    // correct, never "not plain product language" (the category error that stranded the
    // v38 template DAG). Here it passes; we assert the prompt carries the technical bar.
    const technicalSpec: CandidateSpec = {
      title: "Update the scaffold design for the complete quality workflow",
      description:
        "Wire the merge-tier checks, mutation testing gate, and the .tanren/template.yml manifest into the scaffold.",
      acceptanceCriteria: ["given the scaffold, when `just tier-3` runs, then the merge-tier checks pass"],
      audience: "technical",
    };
    const prompt = buildSpecQualityPrompt(technicalSpec);
    expect(prompt).toContain("LEGIBLE to an ENGINEER");
    expect(prompt).toContain("legitimate domain vocabulary");
    expect(prompt).not.toContain("LEGIBLE to a NON-TECHNICAL reader");
    // And the gate accepts it (the validator, judging on the technical bar, passes it).
    const validator = scriptedValidator([passAnswer]);
    const { specs } = await validateEmittedSpecs({ specs: [technicalSpec], validator });
    expect(specs[0]!.revisions).toBe(0);
    // The audience was preserved onto the validated spec (so re-validation is consistent).
    expect(specs[0]!.spec.audience).toBe("technical");
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

  it("the re-author prompt renders the contract, the failing spec, and the validator guidance", () => {
    const prompt = buildSpecRevisionPrompt(goodSpec, "define the jargon + add an observable criterion");
    expect(prompt).toContain("Spec Re-Author");
    expect(prompt).toContain(SPEC_QUALITY_CONTRACT_PROMPT);
    expect(prompt).toContain(goodSpec.title);
    expect(prompt).toContain("Validator guidance to address: define the jargon + add an observable criterion");
    expect(prompt).toContain("Return exactly one SpecRevisionAnswer");
  });

  it("the contract LEGIBLE bar is audience-scoped: product demands plain language, technical accepts domain vocab", () => {
    const product = specQualityContractPrompt("product");
    const technical = specQualityContractPrompt("technical");
    expect(product).toContain("LEGIBLE to a NON-TECHNICAL reader");
    expect(product).not.toContain("LEGIBLE to an ENGINEER");
    expect(technical).toContain("LEGIBLE to an ENGINEER");
    expect(technical).toContain("legitimate domain vocabulary");
    expect(technical).not.toContain("LEGIBLE to a NON-TECHNICAL reader");
    // The audience-independent dimensions are identical across both renders.
    expect(technical).toContain("ACCOMPLISHABLE");
    expect(technical).toContain("DEMO-ABLE");
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
