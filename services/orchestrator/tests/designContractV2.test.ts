// ds-0 — DesignContractV2 lossless-migration + parse/round-trip + fail-closed.

import { describe, expect, it } from "vitest";
import { normalizeDesignContract } from "../src/engine/design/designContract.js";
import {
  DESIGN_CONTRACT_V2_VERSION,
  DesignContractV2CorruptError,
  canonicalDesignContractV2Json,
  deriveDesiredSurfaces,
  designContractV2Digest,
  migrateDesignContractV1ToV2,
  parseDesignContractV2,
  withDerivedDesiredSurfaces,
} from "../src/engine/design/system/designContractV2.js";

const v1 = normalizeDesignContract({
  version: 1,
  domain: "saas-web",
  identity: "calm, dense, trustworthy ops console",
  intent: "an operator dashboard that never surprises",
  principles: ["no AI-slop gradients"],
  constraints: ["accessibility AA"],
  personaRefs: ["persona_admin"],
  behaviorRefs: ["behavior_login"],
  dimensions: [
    {
      key: "tokens",
      label: "Design tokens",
      intent: "restrained palette",
      guidance: "",
      personaRefs: ["persona_admin"],
    },
  ],
});

describe("DesignContractV2", () => {
  it("migrates a V1 contract losslessly (every V1 field preserved, V2 fields empty)", () => {
    const v2 = migrateDesignContractV1ToV2(v1);
    expect(v2.version).toBe(DESIGN_CONTRACT_V2_VERSION);
    expect(v2.domain).toBe(v1.domain);
    expect(v2.identity).toBe(v1.identity);
    expect(v2.intent).toBe(v1.intent);
    expect(v2.principles).toEqual(v1.principles);
    expect(v2.constraints).toEqual(v1.constraints);
    expect(v2.personaRefs).toEqual(v1.personaRefs);
    expect(v2.behaviorRefs).toEqual(v1.behaviorRefs);
    expect(v2.dimensions).toEqual(v1.dimensions);
    // V2 additions default to their empty-but-valid state.
    expect(v2.desiredSurfaces).toEqual([]);
    expect(v2.targetProfiles).toEqual([]);
    // A V1 with NO declared a11y bar carries an honest advisory `none` (the V1 default),
    // NOT a value hardcoded at migration time.
    expect(v2.accessibilityPosture).toEqual({ standard: "none", notes: "" });
    expect(v2.exportRequirements).toEqual([]);
    expect(v2.acceptanceIntent).toBe("");
  });

  it("CARRIES a real V1 accessibility posture through the migration (not re-defaulted to none)", () => {
    // The design agent inferred a real WCAG bar and it was persisted on V1 — the
    // migration must surface the REAL value so the ds-4 render gate enforces it.
    const v1WithPosture = normalizeDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "a public link console",
      intent: "shorten + track links",
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "public consumer surface" },
    });
    const v2 = migrateDesignContractV1ToV2(v1WithPosture);
    expect(v2.accessibilityPosture).toEqual({ standard: "wcag-2.2-aa", notes: "public consumer surface" });
  });

  it("round-trips a full V2 contract through JSON identically", () => {
    const migrated = migrateDesignContractV1ToV2(v1);
    const full = {
      ...migrated,
      desiredSurfaces: [
        {
          key: "dashboard",
          label: "Dashboard",
          intent: "at-a-glance health",
          personaRefs: ["persona_admin"],
          behaviorRefs: ["behavior_login"],
        },
      ],
      targetProfiles: [{ target: "web-react", capabilities: ["tokens", "components"], required: true }],
      accessibilityPosture: { standard: "wcag-2.2-aa", notes: "keyboard-first" },
      exportRequirements: ["css", "tailwind"],
      acceptanceIntent: "the console feels calm under load",
    };
    const json = canonicalDesignContractV2Json(full);
    const reparsed = parseDesignContractV2(JSON.parse(json));
    expect(canonicalDesignContractV2Json(reparsed)).toBe(json);
  });

  it("digest is deterministic and sensitive to a field change", () => {
    const a = migrateDesignContractV1ToV2(v1);
    expect(designContractV2Digest(a)).toBe(designContractV2Digest(a));
    expect(designContractV2Digest(a)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const b = { ...a, acceptanceIntent: "changed" };
    expect(designContractV2Digest(b)).not.toBe(designContractV2Digest(a));
  });

  it("deriveDesiredSurfaces — projects each authored dimension into a persona/behavior-bound surface", () => {
    const v2 = migrateDesignContractV1ToV2(v1);
    const surfaces = deriveDesiredSurfaces(v2);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]?.key).toBe("tokens");
    expect(surfaces[0]?.label).toBe("Design tokens");
    // The dimension's own persona scope is carried; the contract's behaviors bind.
    expect(surfaces[0]?.personaRefs).toEqual(["persona_admin"]);
    expect(surfaces[0]?.behaviorRefs).toEqual(["behavior_login"]);
  });

  it("deriveDesiredSurfaces — a dimension with no persona scope inherits the contract's persona set", () => {
    const v2 = migrateDesignContractV1ToV2(
      normalizeDesignContract({
        version: 1,
        domain: "saas-web",
        identity: "id",
        intent: "intent",
        personaRefs: ["persona_a", "persona_b"],
        dimensions: [{ key: "layout", label: "Layout", intent: "grid", guidance: "", personaRefs: [] }],
      }),
    );
    expect(deriveDesiredSurfaces(v2)[0]?.personaRefs).toEqual(["persona_a", "persona_b"]);
    // No dimensions ⇒ no surfaces (a real empty state, never a fabricated stub).
    expect(deriveDesiredSurfaces(migrateDesignContractV1ToV2({ ...v1, dimensions: [] }))).toEqual([]);
  });

  it("withDerivedDesiredSurfaces — the composer's V2 carries real surfaces + the web target profile", () => {
    const composed = withDerivedDesiredSurfaces(migrateDesignContractV1ToV2(v1));
    expect(composed.desiredSurfaces.map((s) => s.key)).toEqual(["tokens"]);
    expect(composed.targetProfiles).toEqual([{ target: "web-react", capabilities: [], required: true }]);
    // Re-parses clean (round-trips through the strict schema).
    expect(() => parseDesignContractV2(composed)).not.toThrow();
  });

  it("NEGATIVE CONTROL — a corrupt contract fails closed with a typed error", () => {
    expect(() => parseDesignContractV2({ version: 2, domain: "x" })).toThrow(DesignContractV2CorruptError);
    // wrong version literal
    expect(() => parseDesignContractV2({ ...migrateDesignContractV1ToV2(v1), version: 1 })).toThrow(
      DesignContractV2CorruptError,
    );
    // unknown key (strict())
    expect(() => parseDesignContractV2({ ...migrateDesignContractV1ToV2(v1), rogue: true })).toThrow(
      DesignContractV2CorruptError,
    );
  });
});
