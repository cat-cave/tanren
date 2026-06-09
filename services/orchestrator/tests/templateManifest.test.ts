import { describe, expect, it } from "vitest";
import {
  TemplateManifestV1,
  TemplateManifestValidationError,
  TemplateManifestYamlParseError,
  manifestToJson,
  parseTemplateManifest,
} from "../src/engine/templates/index.js";

// A fully-validated `.tanren/template.yml` (a validated ts-pnpm template), inside
// the dependency-free YAML parser's supported subset (nested maps + scalar
// sequences). Round-trips through parse → manifestToJson → re-parse identically.
const VALIDATED = `version: 1
stack: "ts-pnpm-next"
capabilities:
  runtime: "node"
  packageManager: "pnpm"
  framework: "next"
  deployTarget: "vercel"
  gates:
    - "tier-1"
    - "tier-2"
    - "tier-3"
  bdd: true
  mutation: true
  junit: true
channel: "lts"
templateVersion: "1.4.0"
provenance:
  researchSources:
    - "https://nextjs.org/docs"
    - "https://pnpm.io"
  createdByRunId: "run_abc123"
validationProof:
  positiveControlsPassed: true
  negativeControls:
    typecheck: "proven"
    lint: "proven"
    test: "proven"
    mutation: "proven"
  auditorClean: true
  validatedAt: "2026-06-09T00:00:00.000Z"
  validatedSha: "deadbeefcafebabe"
`;

// A never-seen, non-code stack (a Russian-novel translation): no framework/deploy
// target, gates are spellcheck/consistency, no bdd/mutation/junit, unvalidated
// (validationProof null). Proves the manifest is STACK-AGNOSTIC.
const NOVEL_DRAFT = `version: 1
stack: "novel-ru-en"
capabilities:
  runtime: "prose"
  packageManager: "aspell"
  gates:
    - "spellcheck"
    - "consistency"
  bdd: false
  mutation: false
  junit: false
channel: "nightly"
templateVersion: "0.1.0"
provenance:
  researchSources:
    - "hand-seeded from the canonical aspell pipeline"
validationProof: null
`;

describe("template manifest schema", () => {
  it("parses + validates a full validated manifest", () => {
    const m = parseTemplateManifest(VALIDATED);
    expect(m.stack).toBe("ts-pnpm-next");
    expect(m.channel).toBe("lts");
    expect(m.capabilities.framework).toBe("next");
    expect(m.capabilities.gates).toEqual(["tier-1", "tier-2", "tier-3"]);
    expect(m.capabilities.bdd).toBe(true);
    expect(m.provenance.researchSources).toHaveLength(2);
    expect(m.provenance.createdByRunId).toBe("run_abc123");
    expect(m.validationProof).not.toBeNull();
    expect(m.validationProof?.negativeControls.mutation).toBe("proven");
    expect(m.validationProof?.positiveControlsPassed).toBe(true);
  });

  it("parses a stack-agnostic non-code draft (no framework/deploy, null proof)", () => {
    const m = parseTemplateManifest(NOVEL_DRAFT);
    expect(m.stack).toBe("novel-ru-en");
    expect(m.capabilities.runtime).toBe("prose");
    expect(m.capabilities.framework).toBeUndefined();
    expect(m.capabilities.deployTarget).toBeUndefined();
    expect(m.channel).toBe("nightly");
    expect(m.validationProof).toBeNull();
  });

  it("round-trips through manifestToJson identically", () => {
    const m = parseTemplateManifest(VALIDATED);
    const json = manifestToJson(m);
    const reparsed = TemplateManifestV1.parse(json);
    expect(reparsed).toEqual(m);
  });

  it("rejects an unknown channel (schema violation)", () => {
    const bad = VALIDATED.replace('channel: "lts"', 'channel: "stable"');
    expect(() => parseTemplateManifest(bad)).toThrow(TemplateManifestValidationError);
  });

  it("rejects a missing required capability (no runtime)", () => {
    const bad = NOVEL_DRAFT.replace('  runtime: "prose"\n', "");
    expect(() => parseTemplateManifest(bad)).toThrow(TemplateManifestValidationError);
  });

  it("rejects an unknown top-level key (strict schema)", () => {
    const bad = `${VALIDATED}extraneous: "nope"\n`;
    expect(() => parseTemplateManifest(bad)).toThrow(TemplateManifestValidationError);
  });

  it("rejects an invalid negative-control verdict", () => {
    const bad = VALIDATED.replace('typecheck: "proven"', 'typecheck: "maybe"');
    expect(() => parseTemplateManifest(bad)).toThrow(TemplateManifestValidationError);
  });

  it("rejects a wrong version literal", () => {
    const bad = VALIDATED.replace("version: 1", "version: 2");
    expect(() => parseTemplateManifest(bad)).toThrow(TemplateManifestValidationError);
  });

  it("raises a YAML parse error on tab indentation (loud, not a silent default)", () => {
    const bad = "version: 1\n\tstack: x\n";
    expect(() => parseTemplateManifest(bad)).toThrow(TemplateManifestYamlParseError);
  });
});
