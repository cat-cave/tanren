// Audit round-2 H1 — the designOracle prompt is MODE-AWARE (mirrors PR #708's
// checker/auditor lift). PR #708 wired specMode through checker + auditor so a
// `specialize_seed` spec scopes those answerers off the pre-existing seed surfaces;
// the designOracle was left blind. A mode-blind oracle on a seeded scaffold can
// emit P1 findings citing the seed-shipped skeleton (e.g. "behavior X has no
// covering surface" against a component the spec wasn't tasked with adding) —
// lower risk than the checker/auditor (oracle findings flow through the same
// triage gate) but still half-coverage. The fix appends a seeded-mode tail block
// when `specMode === "specialize_seed"` so all four answerers (writer + checker +
// auditor + designOracle) agree on what is in-scope. The block is ABSENT for
// `from_scratch` (the default) so brownfield/legacy specs see the byte-identical
// legacy oracle prompt.
//
// "then" in the fixture rows is the BDD Given/When/Then behavior vocabulary, not
// a thenable — the awaitable-object lint does not apply here.
/* eslint-disable unicorn/no-thenable */
import { describe, expect, it } from "vitest";

import { buildDesignOraclePrompt } from "../src/engine/workflow/designOracle/designOraclePrompt.js";

const baselineSha = "a".repeat(40);

const SHARED = {
  domain: "saas-web",
  identity: "calm dense trustworthy ops console",
  intent: "an ops console that feels effortless under load",
  principles: ["no AI-slop gradients"],
  constraints: ["WCAG AA"],
  dimensions: [],
  personas: [{ id: "persona_admin", name: "Admin", description: "runs the org" }],
  behaviors: [
    {
      id: "behavior_invite",
      personaId: "persona_admin",
      title: "Invite a teammate",
      given: "an admin on the members page",
      when: "they submit an email",
      then: "an invite is sent and shown pending",
    },
  ],
  baselineSha,
};

describe("buildDesignOraclePrompt — seeded-mode tail block (audit round-2 H1)", () => {
  // The DEFAULT (no specMode) — byte-identical to the legacy oracle prompt
  // brownfield/legacy specs already see. A regression here would mean the
  // mode-aware tail block leaked into every oracle prompt.
  it("specMode absent → NO seeded-mode tail block (byte-identical to the legacy prompt)", () => {
    const prompt = buildDesignOraclePrompt(SHARED);
    expect(prompt).not.toContain("SPECIALIZE-SEED mode");
    expect(prompt).not.toContain("composed seed is PRE-EXISTING");
    expect(prompt).not.toContain("Do NOT cite design-contract gaps that");
  });

  // `from_scratch` is the explicit default; byte-identical to absent. Asserts the
  // two paths render the same prompt, so a future caller that explicitly passes
  // `from_scratch` doesn't silently diverge from one that omits it.
  it("specMode='from_scratch' → NO seeded-mode tail block (byte-identical to absent)", () => {
    const explicit = buildDesignOraclePrompt({ ...SHARED, specMode: "from_scratch" });
    const absent = buildDesignOraclePrompt(SHARED);
    expect(explicit).toBe(absent);
    expect(explicit).not.toContain("SPECIALIZE-SEED mode");
  });

  // The actual fix — `specialize_seed` mode emits the tail block. Pins the key
  // phrases the prompt MUST carry so the oracle reads "pre-existing seed surfaces
  // are NOT design-contract gaps this spec was asked to fill; only PRODUCT-SPECIFIC
  // gaps are."
  it("specMode='specialize_seed' → emits the seeded-mode tail block (scopes off seed surfaces)", () => {
    const prompt = buildDesignOraclePrompt({ ...SHARED, specMode: "specialize_seed" });
    // The banner + pre-existing + proven-green framing — mirrors checker/auditor.
    expect(prompt).toContain("SPECIALIZE-SEED mode");
    expect(prompt).toContain("composed seed is PRE-EXISTING and PROVEN GREEN");
    // The enumerated pre-existing surfaces the oracle MUST NOT cite as findings.
    expect(prompt).toContain("manifest, lockfile, tsconfig, lint/test/build configs");
    // The block is line-wrapped ("contract" ends one line, "files (justfile + …)"
    // starts the next). Assert each half.
    expect(prompt).toMatch(/contract\s+files \(justfile \+ \.tanren\/ci\.yml\)/u);
    expect(prompt).toContain("source skeleton, and demo");
    // The oracle-specific framing — design-contract gaps that are properties of
    // the pre-existing seed surface are NOT findings; only product-specific gaps
    // this spec was asked to deliver are. The concrete false-finding example named
    // is "behavior X has no covering surface" against a seed-owned skeleton.
    expect(prompt).toContain("Do NOT cite design-contract gaps that");
    expect(prompt).toContain("PRE-EXISTING SEED SURFACE");
    expect(prompt).toContain("PRODUCT-SPECIFIC");
    expect(prompt).toContain('"behavior X has no covering surface"');
    // The re-elaboration gap (behaviors added AFTER design) is STILL surfaced —
    // those are loud structural gaps the seed cannot have shipped, so they remain
    // valid findings even in seeded mode (the moat's never-silent-fallback floor).
    expect(prompt).toContain("Re-elaboration");
    expect(prompt).toContain("loud structural gaps the seed cannot have shipped");
  });

  // The seeded-mode block goes at the END of the prompt — after the "==== HOW TO
  // ANSWER ====" output instructions. That mirrors the writer + checker + auditor
  // placement: the last block the agent reads is the strongest signal on a
  // re-iteration (the v64 reordering doctrine, defensive). PR #708 calls this
  // "last-position strongest-signal placement"; the oracle inherits the same shape.
  it("places the seeded-mode block AFTER the answer instructions (last-position strongest-signal)", () => {
    const prompt = buildDesignOraclePrompt({ ...SHARED, specMode: "specialize_seed" });
    const contractIndex = prompt.indexOf("==== THE DESIGN CONTRACT");
    const checklistIndex = prompt.indexOf("==== BEHAVIOR-COVERAGE CHECKLIST");
    const answerIndex = prompt.indexOf("==== HOW TO ANSWER");
    const seededIndex = prompt.indexOf("SPECIALIZE-SEED mode");
    expect(contractIndex).toBeGreaterThan(0);
    expect(checklistIndex).toBeGreaterThan(contractIndex);
    expect(answerIndex).toBeGreaterThan(checklistIndex);
    expect(seededIndex).toBeGreaterThan(answerIndex);
  });

  // Domain-general: the seeded-mode block applies to the SAME shape regardless of
  // domain — a non-web (novel-translation) seeded scaffold gets the same scope-off
  // for its pre-existing seed surfaces (the prose/typography skeleton the seed
  // shipped). Pins the cross-domain coverage doctrine.
  it("is domain-general — the seeded-mode block applies to a non-web (novel-translation) contract", () => {
    const novelPrompt = buildDesignOraclePrompt({
      domain: "novel-translation",
      identity: "austere literary classic",
      intent: "preserve the source register",
      principles: [],
      constraints: [],
      dimensions: [{ key: "typography", label: "Typography", intent: "classic serif", guidance: "", personaRefs: [] }],
      personas: [{ id: "persona_reader", name: "Reader", description: "reads the translation" }],
      behaviors: [
        {
          id: "behavior_chapter",
          personaId: "persona_reader",
          title: "Read a chapter",
          given: "a reader opens chapter 1",
          when: "they read a translated passage",
          then: "the voice matches the source register",
        },
      ],
      baselineSha,
      specMode: "specialize_seed",
    });
    expect(novelPrompt).toContain("The design domain is: novel-translation");
    // The same seeded-mode block lands in the non-web prompt — the scope-off rule
    // is domain-general (not "manifest+lockfile only matters for web").
    expect(novelPrompt).toContain("SPECIALIZE-SEED mode");
    expect(novelPrompt).toContain("composed seed is PRE-EXISTING and PROVEN GREEN");
    expect(novelPrompt).toContain("PRODUCT-SPECIFIC");
  });
});
