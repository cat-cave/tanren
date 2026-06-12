import { describe, expect, it } from "vitest";
import {
  computeEnvKey,
  GOLDEN_BASE_IMAGE,
  goldenBaseDigestFrom,
  resolveGoldenBaseDigest,
} from "../src/engine/environments/index.js";

// Environment management (environment-management.md §3 Layer 4 + §7 P3) — the
// CONTENT KEY computation + the golden-base digest source. Proves the env_key is
// DETERMINISTIC (same inputs → same key; a different lockfile → a different key)
// and that the golden base_digest is DERIVED from the image ref, never invented.

const BASE = "golden-deadbeefcafe1234";
const MISE_LOCK_A = `[tools]\nnode = "22"\npython = "3.13"\n`;
const MISE_LOCK_B = `[tools]\nnode = "20"\npython = "3.13"\n`;

describe("computeEnvKey — deterministic content identity", () => {
  it("is a stable 64-hex sha256 over the inputs", () => {
    const key = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A });
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("the SAME inputs always yield the SAME key", () => {
    const a = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A });
    const b = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A });
    expect(a).toBe(b);
  });

  it("a DIFFERENT lockfile yields a DIFFERENT key", () => {
    const a = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A });
    const b = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_B });
    expect(a).not.toBe(b);
  });

  it("a DIFFERENT base_digest (a golden refresh) re-keys the env", () => {
    const a = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A });
    const b = computeEnvKey({ baseDigest: "golden-99990000", miseLock: MISE_LOCK_A });
    expect(a).not.toBe(b);
  });

  it("normalizes cosmetic differences (CRLF, trailing whitespace) to the same key", () => {
    const lf = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A });
    const crlf = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A.replaceAll("\n", "\r\n") });
    const trailing = computeEnvKey({ baseDigest: BASE, miseLock: `${MISE_LOCK_A}\n\n  ` });
    expect(crlf).toBe(lf);
    expect(trailing).toBe(lf);
  });

  it("mixing in a flake.lock yields a DIFFERENT key than the mise-only env", () => {
    const miseOnly = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A });
    const withFlake = computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A, flakeLock: '{ "nodes": {} }' });
    expect(withFlake).not.toBe(miseOnly);
    // Deterministic with the flake too.
    expect(withFlake).toBe(computeEnvKey({ baseDigest: BASE, miseLock: MISE_LOCK_A, flakeLock: '{ "nodes": {} }' }));
  });

  it("the NUL join separator prevents a concatenation-seam collision", () => {
    // Without an unambiguous separator, ("ab", "c") and ("a", "bc") could collide.
    const split1 = computeEnvKey({ baseDigest: "ab", miseLock: "c" });
    const split2 = computeEnvKey({ baseDigest: "a", miseLock: "bc" });
    expect(split1).not.toBe(split2);
  });
});

describe("goldenBaseDigestFrom — base_digest derived from the image ref", () => {
  it("extracts the digest from a golden-tagged ref", () => {
    expect(goldenBaseDigestFrom("ghcr.io/cat-cave/tanren-runner:golden-deadbeef")).toBe("deadbeef");
    expect(goldenBaseDigestFrom("registry:5000/tanren-env:golden-0123abcd")).toBe("0123abcd");
  });

  it("returns undefined for a non-golden (project-pinned) ref", () => {
    expect(goldenBaseDigestFrom("ghcr.io/cat-cave/tanren-runner:v0")).toBeUndefined();
    expect(goldenBaseDigestFrom("some/custom-image:latest")).toBeUndefined();
  });

  it("resolveGoldenBaseDigest returns a deterministic, non-empty digest", () => {
    const d = resolveGoldenBaseDigest();
    expect(d.length).toBeGreaterThan(0);
    // It is image-derived: either the golden tag's digest, or the canonical ref
    // itself when the canonical image is not yet golden-tagged.
    expect(d === goldenBaseDigestFrom(GOLDEN_BASE_IMAGE) || d === GOLDEN_BASE_IMAGE).toBe(true);
  });
});
