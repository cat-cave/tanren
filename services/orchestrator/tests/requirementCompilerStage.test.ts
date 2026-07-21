// in-5: the requirement-compiler ACTOR stage test. Proves the fail-closed LLM-intent
// compile (the rejected-design guard) without a DB — a fake adapter passes through
// `outputSchema.parse` (exercising the REAL parse path), and the actor re-validates
// every candidate via `parseIntegrationRequirement` (Zod + semantic rules).
//
// NEGATIVE CONTROLS (the adversarial self-audit — each is a concrete bad input that
// MUST fail-loud, never a silent fallback):
//   - a schema-invalid candidate (missing required field) → MalformedRequirementCompilerResultError
//   - a semantically-invalid candidate (wrong-plane capability) → ditto
//   - a secret-shaped value embedded in a candidate → ditto (scanSecrets)
//   - a cross-plane binding (control kind on product plane) → ditto
//   - a non-object candidate (coercion/blank-slip guard) → ditto
//   - the golden cross-plane-forbidden vector → ditto
//   - an empty `requirements` array + non-empty rationale → VALID (explicit empty set)
//   - an empty `requirements` array + empty rationale → Zod parse fails
//
// PROOF = EFFECT: the validated `IntegrationRequirementV1` returned is the EXACT
// object the store would persist (the digest is the canonical body hash), so the
// validator and the store agree on the effect coordinate.
import { describe, expect, it } from "vitest";

import type { AnswererAdapter, AnswererRunOptions } from "../src/engine/providers/types.js";
import {
  RequirementCompilerAnswer as RequirementCompilerAnswerSchema,
  REQUIREMENT_COMPILER_SCHEMA_ID,
  type RequirementCompilerAnswer,
} from "../src/engine/answerers/schemas/requirementCompiler.js";
import {
  goldenProductMessagingRequirement,
  goldenCrossPlaneForbiddenRequirement,
  integrationRequirementDigest,
  parseIntegrationRequirement,
} from "../src/engine/contracts/integrationRequirement.js";
import { parseDesignContract, type DesignContractV1 } from "../src/engine/design/designContract.js";
import {
  invokeRequirementCompiler,
  MalformedRequirementCompilerResultError,
  validateCompiledRequirements,
} from "../src/engine/workflow/requirementCompiler/requirementCompiler.js";

const PROJECT = "proj_1";
const SPEC = "spec_1";

function fakeDesignContract(): DesignContractV1 {
  return parseDesignContract({
    version: 1,
    domain: "link-shortener",
    identity: "A product that shortens URLs and celebrates milestones",
    intent: "Shorten links and notify the team on milestones",
    principles: ["observability-first"],
    constraints: ["no live credentials in the merge gate"],
    accessibilityPosture: { standard: "none", notes: "" },
    personaRefs: [],
    behaviorRefs: [],
    dimensions: [],
  });
}

function fakeAdapter(answer: RequirementCompilerAnswer): {
  adapter: AnswererAdapter<RequirementCompilerAnswer>;
  prompts: string[];
} {
  const prompts: string[] = [];
  const adapter: AnswererAdapter<RequirementCompilerAnswer> = {
    kind: "answerer",
    cli: "fake",
    authRef: "fake",
    async runAnswerer(opts: AnswererRunOptions<RequirementCompilerAnswer>) {
      prompts.push(opts.prompt);
      expect(opts.outputSchema.name).toBe(REQUIREMENT_COMPILER_SCHEMA_ID);
      // Exercise the REAL parse path — the prod adapter parses via this same schema.
      return opts.outputSchema.parse(answer);
    },
  };
  return { adapter, prompts };
}

function baseInput() {
  return {
    projectId: PROJECT,
    specId: SPEC,
    specTitle: "Celebrate 100 clicks",
    specDescription: "Post a Slack message when a short link hits 100 clicks",
    acceptanceCriteria: [
      "Given a short link with 99 clicks, when the 100th click is recorded, then a Slack message is posted",
    ],
    designContract: fakeDesignContract(),
    designContractVersion: 3,
    designContractId: "dc_003",
  };
}

describe("requirement compiler actor — invokeRequirementCompiler", () => {
  it("compiles a valid requirement set (the happy path)", async () => {
    const golden = goldenProductMessagingRequirement();
    const { adapter, prompts } = fakeAdapter({
      requirements: [golden],
      rationale: "The acceptance criterion '100th click → Slack message' implies messaging.send on the product plane.",
    });
    const result = await invokeRequirementCompiler(adapter, baseInput());
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]).toEqual(golden);
    expect(result.rationale).toMatch(/messaging\.send/u);
    expect(result.digests).toHaveLength(1);
    // PROOF = EFFECT: the digest the actor computed matches the canonical digest.
    expect(result.digests[0]).toBe(integrationRequirementDigest(golden));
    // The prompt carries the spec context + the golden example.
    expect(prompts[0]).toContain("Celebrate 100 clicks");
    expect(prompts[0]).toContain("100th click");
    expect(prompts[0]).toContain("link-shortener");
  });

  it("accepts an EXPLICIT empty set (spec needs no integrations) with a non-empty rationale", async () => {
    const { adapter } = fakeAdapter({
      requirements: [],
      rationale: "This spec is a pure refactor — no external integration is needed.",
    });
    const result = await invokeRequirementCompiler(adapter, baseInput());
    expect(result.requirements).toHaveLength(0);
    expect(result.rationale).toMatch(/refactor/u);
  });

  // ── NEGATIVE CONTROLS (fail-loud — the rejected-design guard) ───────────────

  it("THROWS on a schema-invalid candidate (missing required `capability`)", async () => {
    const broken = goldenProductMessagingRequirement();
    const { capability: _omit, ...rest } = broken;
    void _omit;
    const { adapter } = fakeAdapter({ requirements: [rest], rationale: "broken" });
    await expect(invokeRequirementCompiler(adapter, baseInput())).rejects.toThrow(
      MalformedRequirementCompilerResultError,
    );
  });

  it("THROWS on a semantically-invalid candidate (wrong-plane capability)", async () => {
    const broken: unknown = {
      ...goldenProductMessagingRequirement(),
      // control.notify capability on product plane — plane_capability_mismatch.
      capability: "control.notify",
    };
    const { adapter } = fakeAdapter({ requirements: [broken], rationale: "broken" });
    const error = await invokeRequirementCompiler(adapter, baseInput()).catch((e) => e);
    expect(error).toBeInstanceOf(MalformedRequirementCompilerResultError);
    expect((error as MalformedRequirementCompilerResultError).detail).toMatch(/plane_capability_mismatch/u);
  });

  it("THROWS on a secret-shaped value embedded in the candidate (scanSecrets)", async () => {
    const broken: unknown = {
      ...goldenProductMessagingRequirement(),
      // secret-shaped — scanSecrets rejects
      capability: "xoxb-1234567890-credential-leak",
    };
    const { adapter } = fakeAdapter({ requirements: [broken], rationale: "broken" });
    const error = await invokeRequirementCompiler(adapter, baseInput()).catch((e) => e);
    expect(error).toBeInstanceOf(MalformedRequirementCompilerResultError);
    expect((error as MalformedRequirementCompilerResultError).detail).toMatch(/secret_value_forbidden/u);
  });

  it("THROWS on the golden cross-plane-forbidden vector (control binding kind on product plane)", async () => {
    const broken = goldenCrossPlaneForbiddenRequirement();
    const { adapter } = fakeAdapter({ requirements: [broken], rationale: "broken" });
    const error = await invokeRequirementCompiler(adapter, baseInput()).catch((e) => e);
    expect(error).toBeInstanceOf(MalformedRequirementCompilerResultError);
    // Either the binding-plane mismatch or the control-credential-as-product-messaging rule fires.
    expect((error as MalformedRequirementCompilerResultError).detail).toMatch(
      /binding_plane_mismatch|control_credential_as_product_messaging/u,
    );
  });

  it("THROWS on a non-object candidate (coercion/blank-slip guard — trap #5/#10)", async () => {
    const { adapter } = fakeAdapter({
      // z.unknown() admits any JSON value, including arrays/strings — the actor
      // MUST reject a non-object candidate loudly (never coerce to a default).
      requirements: ["not-an-object", 42, null],
      rationale: "broken",
    });
    const error = await invokeRequirementCompiler(adapter, baseInput()).catch((e) => e);
    expect(error).toBeInstanceOf(MalformedRequirementCompilerResultError);
    expect((error as MalformedRequirementCompilerResultError).detail).toMatch(/not a JSON object/u);
  });

  it("THROWS when the SECOND candidate is malformed (fail-loud on the first bad entry)", async () => {
    const good = goldenProductMessagingRequirement();
    const broken: unknown = {
      ...good,
      plane: "control",
    };
    // product capability on control plane
    const { adapter } = fakeAdapter({ requirements: [good, broken], rationale: "mixed" });
    const error = await invokeRequirementCompiler(adapter, baseInput()).catch((e) => e);
    expect(error).toBeInstanceOf(MalformedRequirementCompilerResultError);
    expect((error as MalformedRequirementCompilerResultError).detail).toMatch(/requirements\[1\]/u);
  });

  it("the typed error carries projectId + specId for diagnostics", async () => {
    const broken: unknown = { ...goldenProductMessagingRequirement(), plane: "control" };
    const { adapter } = fakeAdapter({ requirements: [broken], rationale: "broken" });
    const error = await invokeRequirementCompiler(adapter, baseInput()).catch((e) => e);
    expect((error as MalformedRequirementCompilerResultError).projectId).toBe(PROJECT);
    expect((error as MalformedRequirementCompilerResultError).specId).toBe(SPEC);
  });
});

describe("requirement compiler actor — validateCompiledRequirements (pure unit)", () => {
  it("re-validates each candidate via parseIntegrationRequirement (proof = effect coordinate)", () => {
    const golden = goldenProductMessagingRequirement();
    const answer: RequirementCompilerAnswer = {
      requirements: [golden],
      rationale: "ok",
    };
    const result = validateCompiledRequirements(answer, { projectId: PROJECT, specId: SPEC });
    expect(result.requirements[0]).toEqual(golden);
    // The digest matches the canonical digest — the persisted `source_digest` column.
    expect(result.digests[0]).toBe(integrationRequirementDigest(golden));
    expect(result.digests[0]).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The returned requirement re-parses cleanly (proof = effect — same object).
    const reParsed = parseIntegrationRequirement(result.requirements[0]);
    expect(reParsed.ok).toBe(true);
  });

  it("rejects an answer whose `rationale` is empty (Zod parse fails before the actor)", () => {
    // The Zod schema has `.min(1)` on rationale — an empty rationale fails the parse,
    // so the adapter's outputSchema.parse throws BEFORE validateCompiledRequirements runs.
    expect(() => RequirementCompilerAnswerSchema.parse({ requirements: [], rationale: "" })).toThrow("rationale");
  });
});
