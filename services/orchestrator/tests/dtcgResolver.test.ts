import { describe, expect, it } from "vitest";
import {
  composePlainDtcgTokens,
  DtcgMalformedPointerError,
  DtcgReferenceCycleError,
  DtcgReferenceTypeMismatchError,
  DtcgUnresolvedReferenceError,
  resolveDtcgTokens,
} from "../src/engine/design/system/dtcgResolver.js";
import type { DesignSystemCoreEvent } from "../src/engine/design/system/designSystemCoreEvents.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

describe("DTCG base/plain resolver", () => {
  it("resolves a complete-token curly-brace alias", () => {
    const resolved = resolveDtcgTokens({
      colors: { blue: { $type: "color", $value: "#0057ff" } },
      semantic: { primary: { $type: "color", $value: "{colors.blue}" } },
    });

    expect(resolved.mode).toBe("base/plain");
    expect(resolved.tokenAt("semantic.primary")?.value).toBe("#0057ff");
    expect(resolved.tokenAt("semantic.primary")?.type).toBe("color");
  });

  it("resolves chained curly-brace aliases and JSON Pointer aliases", () => {
    const resolved = resolveDtcgTokens({
      palette: { base: { $type: "color", $value: "#0057ff" } },
      semantic: {
        primary: { $type: "color", $value: "{palette.base}" },
        action: { $type: "color", $ref: "#/semantic/primary" },
      },
    });

    expect(resolved.tokenAt("semantic.action")?.value).toBe("#0057ff");
  });

  it("fails loudly and deterministically for an alias cycle", () => {
    expect(() =>
      resolveDtcgTokens({
        a: { $type: "number", $value: "{b}" },
        b: { $type: "number", $value: "{c}" },
        c: { $type: "number", $value: "{a}" },
      }),
    ).toThrow(DtcgReferenceCycleError);
  });

  it("rejects an alias whose declared type mismatches its target", () => {
    expect(() =>
      resolveDtcgTokens({
        palette: { blue: { $type: "color", $value: "#0057ff" } },
        space: { compact: { $type: "dimension", $value: "{palette.blue}" } },
      }),
    ).toThrow(DtcgReferenceTypeMismatchError);
  });

  it("rejects a missing reference", () => {
    expect(() => resolveDtcgTokens({ semantic: { primary: { $type: "color", $value: "{palette.missing}" } } })).toThrow(
      DtcgUnresolvedReferenceError,
    );
  });

  it("rejects a malformed RFC 6901 JSON Pointer", () => {
    expect(() => resolveDtcgTokens({ semantic: { primary: { $type: "color", $ref: "#/palette/~2blue" } } })).toThrow(
      DtcgMalformedPointerError,
    );
  });

  it("emits the frozen base-composed event only after a successful composition", () => {
    const events: DesignSystemCoreEvent[] = [];
    composePlainDtcgTokens({
      document: { color: { primary: { $type: "color", $value: "#0057ff" } } },
      event: {
        curationId: "curation_1",
        plainArtifactDigest: digest("a"),
        catalogBuildDigest: digest("b"),
        tokenResolutionDigest: digest("c"),
      },
      eventEmitter: { emit: (event) => events.push(event) },
    });

    expect(events).toEqual([
      {
        type: "designSystem.base.composed",
        payload: expect.objectContaining({ curationId: "curation_1" }),
      },
    ]);
  });
});
