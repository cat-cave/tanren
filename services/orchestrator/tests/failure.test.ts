import { describe, expect, it } from "vitest";
import { assertFailureKind, defineFailure } from "../src/engine/failure.js";

describe("failure contract", () => {
  it("accepts declared failure kinds", () => {
    expect(defineFailure({ kind: "provider_failed", provider: "fake", message: "failed" })).toEqual({
      kind: "provider_failed",
      provider: "fake",
      message: "failed"
    });
  });

  it("rejects host-prefixed failure kinds", () => {
    const badKind = `${"host"}_${"exec_failed"}`;

    expect(() => assertFailureKind(badKind)).toThrow("forbidden failure kind");
  });
});
