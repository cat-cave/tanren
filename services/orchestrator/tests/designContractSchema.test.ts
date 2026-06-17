// Native design subsystem (WS-D1) — the domain-general `DesignContract` schema.
// Proves: (a) the contract shape ADAPTS to the project domain (a SaaS app, a
// mobile game, and a novel translation each declare their OWN dimensions — the
// web design-system is NOT baked in as THE schema); (b) the required core fails
// LOUD on a missing/empty field (no silent default); (c) `strict()` rejects an
// unknown key; (d) the parser round-trips a persisted blob.

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  DESIGN_CONTRACT_VERSION,
  DesignContractV1,
  designContractToJson,
  parseDesignContract,
} from "../src/engine/design/designContract.js";

const saasContract = {
  version: 1 as const,
  domain: "saas-web",
  identity: "a calm, dense, trustworthy ops console",
  intent: "an information-dense control surface an operator trusts at a glance",
  principles: ["two accent colors max", "no AI-slop gradients"],
  constraints: ["WCAG AA"],
  dimensions: [
    { key: "tokens", label: "Design tokens", intent: "a restrained palette + a dense type scale", guidance: "" },
    { key: "components", label: "Components", intent: "consistent, legible primitives", guidance: "" },
    { key: "layout", label: "Layout", intent: "a scannable grid", guidance: "" },
  ],
};

describe("DesignContract schema — domain-general, not web-baked", () => {
  it("parses a SaaS-web contract with token/component/layout dimensions", () => {
    const parsed = parseDesignContract(saasContract);
    expect(parsed.domain).toBe("saas-web");
    expect(parsed.dimensions.map((d) => d.key)).toEqual(["tokens", "components", "layout"]);
  });

  it("parses a mobile-GAME contract whose dimensions are art-direction/ui/game-feel (NOT web sections)", () => {
    const game = parseDesignContract({
      version: 1,
      domain: "mobile-game",
      identity: "a warm, hand-drawn cozy farming game",
      intent: "a tactile, unhurried world that rewards return visits",
      principles: ["never punish the player for stepping away"],
      constraints: ["60fps on mid-tier hardware"],
      dimensions: [
        { key: "art-direction", label: "Art direction", intent: "hand-drawn, warm, cozy", guidance: "" },
        { key: "ui", label: "UI", intent: "diegetic, minimal HUD", guidance: "" },
        { key: "game-feel", label: "Game feel", intent: "soft, springy, satisfying", guidance: "" },
      ],
    });
    expect(game.domain).toBe("mobile-game");
    // The SHAPE adapted to the domain — none of the web token/component sections.
    expect(game.dimensions.map((d) => d.key)).toEqual(["art-direction", "ui", "game-feel"]);
  });

  it("parses a NOVEL-translation contract whose dimensions are typography/voice/layout/cover", () => {
    const novel = parseDesignContract({
      version: 1,
      domain: "novel-translation",
      identity: "an austere literary classic in English",
      intent: "preserve the source register while reading naturally to a modern English reader",
      principles: ["keep the translator's voice consistent across chapters"],
      constraints: ["match the source's chapter structure"],
      dimensions: [
        { key: "typography", label: "Typography", intent: "a classic serif, generous leading", guidance: "" },
        { key: "voice", label: "Voice", intent: "formal but not stilted", guidance: "" },
        { key: "layout", label: "Layout", intent: "a print-faithful page", guidance: "" },
        { key: "cover", label: "Cover", intent: "restrained, literary", guidance: "" },
      ],
    });
    expect(novel.dimensions.map((d) => d.key)).toEqual(["typography", "voice", "layout", "cover"]);
  });

  it("accepts an EMPTY dimension set — the core alone is a valid contract (the design phase enriches it)", () => {
    const coreOnly = parseDesignContract({
      version: 1,
      domain: "cli-tool",
      identity: "a terse, fast developer CLI",
      intent: "minimal, predictable output an expert can pipe",
    });
    expect(coreOnly.dimensions).toEqual([]);
    expect(coreOnly.principles).toEqual([]);
    expect(coreOnly.constraints).toEqual([]);
  });
});

describe("DesignContract schema — the MOAT: first-class persona + behavior links", () => {
  it("carries persona + behavior id refs bound to the project's typed entity graph", () => {
    const parsed = parseDesignContract({
      ...saasContract,
      personaRefs: ["persona_a", "persona_b"],
      behaviorRefs: ["behavior_1", "behavior_2"],
      dimensions: [
        // A persona-SCOPED dimension: this persona's view of this surface.
        { key: "layout", label: "Layout", intent: "a dense grid", guidance: "", personaRefs: ["persona_a"] },
      ],
    });
    expect(parsed.personaRefs).toEqual(["persona_a", "persona_b"]);
    expect(parsed.behaviorRefs).toEqual(["behavior_1", "behavior_2"]);
    expect(parsed.dimensions[0]?.personaRefs).toEqual(["persona_a"]);
  });

  it("defaults the link fields to empty (none bound yet is a real empty state)", () => {
    const parsed = parseDesignContract({
      version: 1,
      domain: "saas-web",
      identity: "x",
      intent: "y",
    });
    expect(parsed.personaRefs).toEqual([]);
    expect(parsed.behaviorRefs).toEqual([]);
  });

  it("the links are domain-general — a novel translation binds reader/editor personas + behaviors too", () => {
    const novel = parseDesignContract({
      version: 1,
      domain: "novel-translation",
      identity: "an austere literary classic",
      intent: "preserve the source register",
      personaRefs: ["persona_reader", "persona_editor"],
      behaviorRefs: ["behavior_reads_naturally"],
      dimensions: [{ key: "voice", label: "Voice", intent: "formal but not stilted" }],
    });
    expect(novel.personaRefs).toHaveLength(2);
    expect(novel.behaviorRefs).toEqual(["behavior_reads_naturally"]);
  });
});

describe("DesignContract schema — loud on missing / malformed (no silent default)", () => {
  it("FAILS LOUD on a missing required `intent`", () => {
    expect(() => parseDesignContract({ version: 1, domain: "saas-web", identity: "x" })).toThrow(ZodError);
  });

  it("FAILS LOUD on an empty `identity` (a contract with no identity carries no signal)", () => {
    expect(() => parseDesignContract({ ...saasContract, identity: "" })).toThrow(ZodError);
  });

  it("FAILS LOUD on an empty `domain`", () => {
    expect(() => parseDesignContract({ ...saasContract, domain: "" })).toThrow(ZodError);
  });

  it("FAILS LOUD on a dimension with an empty `intent`", () => {
    expect(() =>
      parseDesignContract({
        ...saasContract,
        dimensions: [{ key: "tokens", label: "Design tokens", intent: "" }],
      }),
    ).toThrow(ZodError);
  });

  it("FAILS LOUD on the wrong version (the literal pins the shape)", () => {
    expect(() => parseDesignContract({ ...saasContract, version: 2 })).toThrow(ZodError);
  });

  it("FAILS LOUD on an unknown key (strict)", () => {
    expect(() => parseDesignContract({ ...saasContract, palette: "#fff" })).toThrow(ZodError);
  });

  it("FAILS LOUD on a non-object", () => {
    expect(() => parseDesignContract("not a contract")).toThrow(ZodError);
    expect(() => parseDesignContract(null)).toThrow(ZodError);
  });
});

describe("DesignContract schema — round-trip + defaults", () => {
  it("round-trips a contract through designContractToJson → parse (identity)", () => {
    const json = designContractToJson(DesignContractV1.parse(saasContract));
    expect(parseDesignContract(json)).toEqual(DesignContractV1.parse(saasContract));
  });

  it("defaults the optional list/string fields when omitted", () => {
    const parsed = parseDesignContract({
      version: DESIGN_CONTRACT_VERSION,
      domain: "saas-web",
      identity: "x",
      intent: "y",
      dimensions: [{ key: "tokens", label: "Design tokens", intent: "a restrained palette" }],
    });
    expect(parsed.principles).toEqual([]);
    expect(parsed.constraints).toEqual([]);
    expect(parsed.dimensions[0]?.guidance).toBe("");
  });
});
