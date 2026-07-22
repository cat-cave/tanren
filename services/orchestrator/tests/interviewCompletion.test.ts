// rv-21 — DB-free unit coverage for the deterministic interview-completion predicate.
// The route-level proof is RLS-gated (and so does not count toward coverage); these
// pure-function cases pin every required area + every invalid-reference arm.

import { describe, expect, it } from "vitest";
import { BehaviorCreateInput } from "../src/engine/entities/behaviors.js";
import { PersonaCreateInput } from "../src/engine/entities/personas.js";
import {
  emptyCapture,
  evaluateInterviewCompletion,
  InterviewCapture,
  InterviewIncompleteError,
} from "../src/engine/forge/interview/index.js";

const LIFECYCLE = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install",
  tier1: "pnpm lint",
  tier2: "pnpm test",
  tier3: "pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

/* eslint-disable unicorn/no-thenable -- Given/When/Then is the captured behavior vocabulary. */
function completeCapture(): InterviewCapture {
  return {
    ...emptyCapture(),
    identity: { slug: "acme", pitch: "a real product", repoHint: "" },
    personas: [{ name: "operator", description: "runs it", surface: "desktop" }],
    behaviors: [
      { persona: "operator", title: "see status", given: "a product", when: "they look", then: "status shows" },
    ],
    interfaces: [{ name: "dashboard", note: "" }],
    designContract: {
      domain: "saas-web",
      identity: "a clean surface",
      intent: "calm + dense",
      principles: [],
      constraints: [],
      personas: ["operator"],
      behaviors: ["operator::see status"],
      dimensions: [],
    },
    architecture: [{ layer: "web", choice: "next.js" }],
    lifecycle: LIFECYCLE,
    rulesets: [],
  };
}
/* eslint-enable unicorn/no-thenable */

describe("evaluateInterviewCompletion — the deterministic completion predicate", () => {
  it("accepts a complete capture (empty rulesets are a valid explicit result)", () => {
    const result = evaluateInterviewCompletion(completeCapture());
    expect(result).toEqual({ complete: true, missing: [], invalid: [] });
  });

  it("an empty capture is missing every required area (positive evidence required, never vacuous)", () => {
    const result = evaluateInterviewCompletion(emptyCapture());
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual([
      "identity",
      "persona",
      "behavior",
      "interface",
      "designSeed",
      "architecture",
      "lifecycle",
    ]);
  });

  it("reports the single missing area for each otherwise-complete capture", () => {
    const cases: Array<[keyof InterviewCapture, unknown, string]> = [
      ["identity", null, "identity"],
      ["interfaces", [], "interface"],
      ["designContract", null, "designSeed"],
      ["architecture", [], "architecture"],
      ["lifecycle", null, "lifecycle"],
    ];
    for (const [field, value, area] of cases) {
      const result = evaluateInterviewCompletion({ ...completeCapture(), [field]: value } as InterviewCapture);
      expect(result.complete).toBe(false);
      expect(result.missing).toEqual([area]);
    }
  });

  it("Gap 1 — whitespace-only content counts as MISSING, never present (no blank-slip)", () => {
    const blankPitch = completeCapture();
    blankPitch.identity = { slug: "acme", pitch: "   ", repoHint: "" };
    expect(evaluateInterviewCompletion(blankPitch).missing).toContain("identity");

    const blankInterface = { ...completeCapture(), interfaces: [{ name: "   ", note: "" }] };
    expect(evaluateInterviewCompletion(blankInterface).missing).toContain("interface");

    const blankArchitecture = { ...completeCapture(), architecture: [{ layer: "   ", choice: "next.js" }] };
    expect(evaluateInterviewCompletion(blankArchitecture).missing).toContain("architecture");

    const blankSeed = completeCapture();
    blankSeed.designContract = { ...blankSeed.designContract!, intent: "   " };
    expect(evaluateInterviewCompletion(blankSeed).missing).toContain("designSeed");
  });

  it("Gap 3 — a behavior with a blank Given/When/Then is INVALID (incompleteBehavior), not merely uncounted", () => {
    /* eslint-disable-next-line unicorn/no-thenable */
    const behaviors = [{ persona: "operator", title: "half-formed", given: "a product", when: "  ", then: "" }];
    const result = evaluateInterviewCompletion({ ...completeCapture(), behaviors });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("behavior");
    expect(result.invalid).toContainEqual(
      expect.objectContaining({ kind: "incompleteBehavior", ref: "operator::half-formed" }),
    );
  });

  it("proof=effect — a blank-NAME persona is REJECTED, never silently skipped (derive would persist it)", () => {
    // The predicate's validated set MUST equal derive's persist set. A blank-name persona
    // must NOT be skipped: derive would persist a junk persona row, wedging the coverage
    // assertion. So it is surfaced `blankPersona` → complete:false.
    const base = completeCapture();
    const withJunk = {
      ...base,
      personas: [...base.personas, { name: "   ", description: "junk", surface: "" }],
    };
    const result = evaluateInterviewCompletion(withJunk);
    expect(result.complete).toBe(false);
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "blankPersona" }));
  });

  it("proof=effect — a blank-TITLE behavior is REJECTED, never a coverage-eligible `persona::` key", () => {
    const base = completeCapture();
    /* eslint-disable-next-line unicorn/no-thenable */
    const junkBehavior = { persona: "operator", title: "   ", given: "g", when: "w", then: "t" };
    const withJunk = { ...base, behaviors: [...base.behaviors, junkBehavior] };
    const result = evaluateInterviewCompletion(withJunk);
    expect(result.complete).toBe(false);
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "blankBehaviorTitle" }));
  });

  it("persist-layer defense — PersonaCreateInput/BehaviorCreateInput trim-and-reject a blank name/title", () => {
    expect(() => PersonaCreateInput.parse({ scope: "project", orgId: "org_a", projectId: "p", name: "   " })).toThrow(
      /string|character|empty|small/iu,
    );
    expect(() =>
      PersonaCreateInput.parse({ scope: "project", orgId: "org_a", projectId: "p", name: "ops" }),
    ).not.toThrow();
    /* eslint-disable-next-line unicorn/no-thenable -- Given/When/Then is the behavior create-input vocabulary. */
    const blankTitle = { personaId: "persona_a", title: "   ", given: "g", when: "w", then: "t" };
    expect(() => BehaviorCreateInput.parse(blankTitle)).toThrow(/string|character|empty|small/iu);
  });

  it("a captured persona that owns no fully-formed behavior is invalid (personaWithoutBehavior)", () => {
    /* eslint-disable-next-line unicorn/no-thenable */
    const behaviors = [{ persona: "operator", title: "see status", given: "g", when: "w", then: "t" }];
    const twoPersonas = {
      ...completeCapture(),
      personas: [
        { name: "operator", description: "runs it", surface: "" },
        { name: "auditor", description: "watches", surface: "" },
      ],
      behaviors,
    };
    const result = evaluateInterviewCompletion(twoPersonas);
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "personaWithoutBehavior", ref: "auditor" }));
  });

  it("surfaces a behavior naming an uncaptured persona as invalid (no captured reference silently dropped)", () => {
    /* eslint-disable-next-line unicorn/no-thenable */
    const behaviors = [{ persona: "ghost", title: "haunt", given: "g", when: "w", then: "t" }];
    const result = evaluateInterviewCompletion({ ...completeCapture(), behaviors });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain("behavior");
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "behaviorPersona", ref: "ghost" }));
  });

  it("Gap 2 — an EMPTY design-seed MOAT does not vacuously complete (every persona + behavior must be covered)", () => {
    const base = completeCapture();
    const emptyMoat = {
      ...base,
      designContract: { ...base.designContract!, personas: [], behaviors: [] },
    };
    const result = evaluateInterviewCompletion(emptyMoat);
    expect(result.complete).toBe(false);
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "uncoveredPersona", ref: "operator" }));
    expect(result.invalid).toContainEqual(
      expect.objectContaining({ kind: "uncoveredBehavior", ref: "operator::see status" }),
    );
  });

  it("surfaces dangling design-seed persona and behavior refs (and a dimension persona ref) as invalid", () => {
    const base = completeCapture();
    const result = evaluateInterviewCompletion({
      ...base,
      designContract: {
        ...base.designContract!,
        personas: ["operator", "phantom"],
        behaviors: ["operator::see status", "operator::missing"],
        dimensions: [{ key: "k", label: "L", intent: "i", guidance: "", personas: ["nobody"] }],
      },
    });
    expect(result.complete).toBe(false);
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "designPersona", ref: "phantom" }));
    expect(result.invalid).toContainEqual(expect.objectContaining({ kind: "designPersona", ref: "nobody" }));
    expect(result.invalid).toContainEqual(
      expect.objectContaining({ kind: "designBehavior", ref: "operator::missing" }),
    );
  });

  it("BOUNDARY NORMALIZATION — InterviewCapture.parse trims every key-bearing ref ONCE at ingestion", () => {
    // The structural fix for the silent-drop root cause: a whitespace-PADDED (non-blank) ref
    // is normalized at the capture schema, so the predicate, `behaviorKey`,
    // `buildDerivationDesignPlan`, `deriveBehaviorSpec`, and the persist layer ALL see the
    // same canonical value — a padded ref can no longer pass the gate then miss a downstream
    // map lookup. Removing the schema `.trim()` flips THIS assertion red.
    /* eslint-disable unicorn/no-thenable -- Given/When/Then is the captured behavior vocabulary. */
    const parsed = InterviewCapture.parse({
      identity: { slug: "acme", pitch: "  a padded pitch  ", repoHint: "" },
      personas: [{ name: "  operator  ", description: "  runs it  ", surface: "  desktop  " }],
      behaviors: [{ persona: "  operator  ", title: "  see status  ", given: " g ", when: " w ", then: " t " }],
      interfaces: [{ name: "  dashboard  ", note: "" }],
      architecture: [{ layer: "  web  ", choice: "  next.js  " }],
      designContract: {
        domain: "  saas-web  ",
        identity: "  clean  ",
        intent: "  dense  ",
        personas: ["  operator  "],
        behaviors: ["  operator::see status  "],
      },
      lifecycle: null,
      rulesets: ["  main protected  "],
    });
    /* eslint-enable unicorn/no-thenable */
    expect(parsed.identity?.pitch).toBe("a padded pitch");
    expect(parsed.personas[0]?.name).toBe("operator");
    expect(parsed.personas[0]?.surface).toBe("desktop");
    expect(parsed.behaviors[0]?.persona).toBe("operator");
    expect(parsed.behaviors[0]?.title).toBe("see status");
    expect(parsed.behaviors[0]?.given).toBe("g");
    expect(parsed.interfaces[0]?.name).toBe("dashboard");
    expect(parsed.architecture[0]?.layer).toBe("web");
    expect(parsed.architecture[0]?.choice).toBe("next.js");
    expect(parsed.designContract?.domain).toBe("saas-web");
    expect(parsed.designContract?.personas).toEqual(["operator"]);
    expect(parsed.designContract?.behaviors).toEqual(["operator::see status"]);
    expect(parsed.rulesets).toEqual(["main protected"]);
    // The padded persona ref now matches the persona name — the predicate + derive agree.
    expect(evaluateInterviewCompletion({ ...emptyCapture(), ...parsed, lifecycle: LIFECYCLE }).invalid).toEqual([]);
  });

  it("blank-after-trim key fields are REJECTED at the capture schema (min(1) on the trimmed value)", () => {
    expect(() => InterviewCapture.parse({ personas: [{ name: "   ", description: "d" }] })).toThrow(
      /character|string|small|empty/iu,
    );
    /* eslint-disable-next-line unicorn/no-thenable -- Given/When/Then is the captured behavior vocabulary. */
    const blankTitleCapture = { behaviors: [{ persona: "op", title: "   ", given: "g", when: "w", then: "t" }] };
    expect(() => InterviewCapture.parse(blankTitleCapture)).toThrow(/character|string|small|empty/iu);
    expect(() => InterviewCapture.parse({ interfaces: [{ name: "   " }] })).toThrow(/character|string|small|empty/iu);
  });

  it("InterviewIncompleteError carries the typed missing + invalid areas in its message", () => {
    const error = new InterviewIncompleteError(
      ["designSeed"],
      [{ kind: "behaviorPersona", ref: "ghost", detail: "x" }],
    );
    expect(error.name).toBe("InterviewIncompleteError");
    expect(error.missing).toEqual(["designSeed"]);
    expect(error.message).toContain("designSeed");
    expect(error.message).toContain("behaviorPersona:ghost");
  });
});
