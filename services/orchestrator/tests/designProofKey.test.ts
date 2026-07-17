// ds-0 — design proof-key derivation: deterministic, order-independent, fail-closed.

import { describe, expect, it } from "vitest";
import {
  DesignProofKeyInputError,
  type DesignProofKeyInput,
  deriveDesignProofKey,
} from "../src/engine/design/system/designProofKey.js";

const digest = (label: string): string =>
  `sha256:${label
    .padEnd(64, "0")
    .slice(0, 64)
    .replaceAll(/[^0-9a-f]/gu, "a")}`;

const base: DesignProofKeyInput = {
  releaseDigest: digest("release"),
  fragmentDigests: [digest("frag1"), digest("frag2")],
  adapterTarget: "web-react",
  environment: "pre_merge",
  scenarioKey: "button/primary/dark/desktop",
  artifactDigest: digest("artifact"),
};

describe("deriveDesignProofKey", () => {
  it("is deterministic and returns a sha256 key", () => {
    const key = deriveDesignProofKey(base);
    expect(key).toBe(deriveDesignProofKey(base));
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("is order-independent over the fragment set", () => {
    const reordered = { ...base, fragmentDigests: base.fragmentDigests.toReversed() };
    expect(deriveDesignProofKey(reordered)).toBe(deriveDesignProofKey(base));
  });

  it("changes when ANY of the six components changes (no stale reuse)", () => {
    const key = deriveDesignProofKey(base);
    expect(deriveDesignProofKey({ ...base, releaseDigest: digest("release2") })).not.toBe(key);
    expect(deriveDesignProofKey({ ...base, artifactDigest: digest("artifact2") })).not.toBe(key);
    expect(deriveDesignProofKey({ ...base, adapterTarget: "bevy" })).not.toBe(key);
    expect(deriveDesignProofKey({ ...base, environment: "preview" })).not.toBe(key);
    expect(deriveDesignProofKey({ ...base, scenarioKey: "button/primary/light/desktop" })).not.toBe(key);
    expect(deriveDesignProofKey({ ...base, fragmentDigests: [digest("frag3")] })).not.toBe(key);
  });

  it("NEGATIVE CONTROL — a malformed component fails closed with a typed error", () => {
    expect(() => deriveDesignProofKey({ ...base, releaseDigest: "not-a-digest" })).toThrow(DesignProofKeyInputError);
    expect(() => deriveDesignProofKey({ ...base, adapterTarget: "" })).toThrow(DesignProofKeyInputError);
    expect(() => deriveDesignProofKey({ ...base, fragmentDigests: ["nope"] })).toThrow(DesignProofKeyInputError);
  });
});
