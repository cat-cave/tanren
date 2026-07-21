// ds-7 — DB-free boundary coverage for deterministic token resolution. These
// paths are used by every framework adapter before it emits an artifact, so a
// malformed alias or value must be rejected instead of projecting a substitute.

import { describe, expect, it } from "vitest";
import {
  DtcgDocumentError,
  DtcgMalformedPointerError,
  DtcgUnresolvedReferenceError,
  resolveDtcgTokens,
} from "../src/engine/design/system/dtcgResolver.js";

describe("DTCG resolver — deterministic boundary cases", () => {
  it("resolves nested object and array aliases without exposing a mutable cached token", () => {
    const resolved = resolveDtcgTokens({
      color: { base: { $type: "color", $value: "#155eef" } },
      composite: {
        $type: "custom",
        $value: {
          foreground: "{color.base}",
          fallbacks: ["{color.base}", "#ffffff"],
          metadata: { usage: "action" },
        },
      },
      firstFallback: { $ref: "#/composite/$value/fallbacks/0" },
    });

    expect(resolved.tokenAt("composite")?.value).toEqual({
      fallbacks: ["#155eef", "#ffffff"],
      foreground: "#155eef",
      metadata: { usage: "action" },
    });
    expect(resolved.tokenAt("firstFallback")?.value).toBe("#155eef");

    const copied = resolved.tokenAt("composite");
    expect(copied).toBeDefined();
    if (
      copied !== undefined &&
      typeof copied.value === "object" &&
      copied.value !== null &&
      !Array.isArray(copied.value)
    ) {
      (copied.value as { foreground: string }).foreground = "forged";
    }
    expect(resolved.tokenAt("composite")?.value).toMatchObject({ foreground: "#155eef" });
  });

  it("inherits a group type through $root and resolves the root token by JSON pointer", () => {
    const resolved = resolveDtcgTokens({
      palette: {
        $type: "color",
        $root: { $value: "#101828" },
        accent: { $value: "#155eef" },
      },
      semantic: { surface: { $ref: "#/palette/$root/$value" } },
    });

    expect(resolved.tokenAt("palette")?.type).toBe("color");
    expect(resolved.tokenAt("palette")?.value).toBe("#101828");
    expect(resolved.tokenAt("semantic.surface")?.value).toBe("#101828");
  });

  it("rejects structural invalidity rather than manufacturing a token set", () => {
    const invalidDocuments = [
      {},
      { $value: "#155eef" },
      { palette: { $unexpected: true, base: { $value: "#155eef" } } },
      { palette: { base: { $value: "#155eef", $ref: "#/palette/base" } } },
      { palette: { base: { $value: Number.POSITIVE_INFINITY } } },
    ];

    for (const document of invalidDocuments) {
      expect(() => resolveDtcgTokens(document)).toThrow(DtcgDocumentError);
    }
  });

  it("rejects malformed aliases and invalid array pointer segments fail-closed", () => {
    expect(() => resolveDtcgTokens({ alias: { $value: "{palette" } })).toThrow(DtcgMalformedPointerError);
    expect(() =>
      resolveDtcgTokens({
        composite: { $value: ["#155eef"] },
        alias: { $ref: "#/composite/$value/not-an-index" },
      }),
    ).toThrow(DtcgUnresolvedReferenceError);
  });
});
