// ds-0 — DesignContractV2 lossless-migration + parse/round-trip + fail-closed.

import { describe, expect, it } from "vitest";
import { normalizeDesignContract } from "../src/engine/design/designContract.js";
import {
  DESIGN_CONTRACT_V2_VERSION,
  DesignContractV2CorruptError,
  canonicalDesignContractV2Json,
  designContractV2Digest,
  migrateDesignContractV1ToV2,
  parseDesignContractV2,
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
    expect(v2.accessibilityPosture).toEqual({ standard: "none", notes: "" });
    expect(v2.exportRequirements).toEqual([]);
    expect(v2.acceptanceIntent).toBe("");
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
