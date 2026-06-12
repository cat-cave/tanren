// Environment management (environment-management.md §3 Layer 3 + §7 P3) — the
// GOLDEN-BASE digest source + the no-match fallback image.
//
// The env_key (envKey.ts) is computed over P2's golden-image CONTENT DIGEST as its
// `base_digest` — a golden-base refresh re-keys every environment, because a
// different baseline IS a different environment. This module is the single, clean
// SOURCE of that digest, and of the warm-baseline image P3 falls back to on a
// registry no-match.
//
// base_digest SOURCE — derived from the golden image's own tag, never invented.
// P2 tags the golden base `golden-<digest>` where `<digest>` is the sha256 over the
// image-DEFINING inputs (Dockerfile ‖ entrypoint ‖ mise.baseline.toml —
// `scripts/dev/build-golden-image.sh`). So the digest is a FACT carried IN the
// image ref the project already resolves to: `goldenBaseDigestFrom(imageRef)`
// extracts the `golden-<digest>` portion. A non-golden ref (a project that pinned a
// custom image) has no derivable golden digest — it returns `undefined`, and env
// resolution then SKIPS the registry (a pinned image is the project's explicit
// override, not an env-keyed lookup). No `process.env.X ?? default` silent
// fallback: the digest is the image's own content identity or it is loudly absent.

import { CANONICAL_RUNNER_IMAGE } from "../config/shared.js";

/**
 * The warm golden BASE image P3 seeds from when env resolution finds no validated
 * registry match (or the project committed no lockfile — a fresh greenfield first
 * boot). It is P2's baseline, covering the empirically-common toolchains, so a
 * project with no keyed env still boots fast. P4 replaces this fallback with a JIT
 * build of the keyed image; in P3 it is the never-stall default.
 *
 * This IS the single canonical runner image (`CANONICAL_RUNNER_IMAGE`) — the golden
 * base and the canonical default are one image. Re-exported under an env-layer name
 * so the resolution seam reads intent-first ("fall back to the golden base").
 */
export const GOLDEN_BASE_IMAGE: string = CANONICAL_RUNNER_IMAGE;

// A golden tag looks like `golden-<hexdigest>` (the digest is `[0:16]` of a sha256
// in P2, but this matcher accepts any hex run so a future full-length digest still
// parses). Anchored to the END of the ref so a `registry/name:golden-<digest>` ref
// yields just the digest.
const GOLDEN_TAG = /(?::|^)golden-(?<digest>[0-9a-f]+)$/u;

/**
 * Extract the golden-base CONTENT DIGEST from an image ref, or `undefined` when the
 * ref is not a `golden-<digest>`-tagged image (a project-pinned custom image — its
 * env is not registry-keyed). The digest is the `base_digest` the env_key is
 * computed over; deriving it from the ref keeps base_digest a FACT of the image,
 * never a separately-configured value that could silently drift from the image.
 *
 * @example goldenBaseDigestFrom("ghcr.io/cat-cave/tanren-runner:golden-deadbeef")
 *          // => "deadbeef"
 */
export function goldenBaseDigestFrom(imageRef: string): string | undefined {
  return GOLDEN_TAG.exec(imageRef.trim())?.groups?.["digest"];
}

/**
 * The base_digest of the WARM GOLDEN BASE the project would fall back to —
 * `goldenBaseDigestFrom(GOLDEN_BASE_IMAGE)`, or the canonical image ref itself when
 * the canonical image is not yet golden-tagged (the `:v0` placeholder pre-P2-cutover).
 * The env_key is stable against THIS baseline: a golden refresh that re-tags the
 * canonical image re-keys every env, exactly as the design requires.
 */
export function resolveGoldenBaseDigest(): string {
  // Falls back to the full canonical ref (not a magic constant) when the image has
  // no golden tag yet — so the env_key is still deterministic + image-derived, and
  // re-tagging the canonical image to a real `golden-<digest>` re-keys envs.
  return goldenBaseDigestFrom(GOLDEN_BASE_IMAGE) ?? GOLDEN_BASE_IMAGE;
}
