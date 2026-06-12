// Environment management (environment-management.md §3 Layer 4 + §7 P3) — the
// content-key computation that IDENTIFIES an environment image.
//
// An environment's identity is its CONTENT HASH:
//   env_key = sha256(base_digest ‖ mise.lock [‖ flake.lock])
// where:
//   - base_digest is P2's GOLDEN-IMAGE content digest (the
//     `golden-<sha256(Dockerfile ‖ entrypoint ‖ mise.baseline.toml)>` tag's digest
//     portion — `scripts/dev/build-golden-image.sh`). It is the baseline the env
//     layers its delta on, so a golden-image refresh re-keys every env (a different
//     baseline IS a different environment). Sourced via `resolveGoldenBaseDigest`.
//   - mise.lock is the project's COMMITTED mise lockfile content (the
//     determinism + cache-key anchor — environment-management.md §3 Layer 1). In
//     P3 the per-project resolution normalizes the project's declared toolchain
//     into this slot (the deterministic lockfile counterpart available before the
//     workspace is checked out; see `engine/environments/resolveProjectEnv.ts`).
//   - flake.lock is the OPTIONAL Nix-tier lockfile (environment-management.md §3
//     escape-hatch tier). Absent for the mise tier (the ~95% case).
//
// DETERMINISTIC by construction: the inputs are NORMALIZED (trimmed, `\r\n`→`\n`)
// before hashing, and joined with an unambiguous NUL separator that the lockfile
// text + image digest can never contain — so the same toolchain content ALWAYS
// yields the same key, and a different lockfile ALWAYS yields a different key (no
// accidental collision from whitespace or a concatenation seam). This is the
// env-layer counterpart of the code-template's content identity.

import { createHash } from "node:crypto";

/** The inputs the env_key is computed over (environment-management.md §3 Layer 4). */
export interface EnvKeyInputs {
  /** P2's golden-image content digest — the baseline the env's delta layers on. */
  baseDigest: string;
  /** The project's committed `mise.lock` content (the determinism anchor). */
  miseLock: string;
  /** The OPTIONAL Nix-tier `flake.lock` content (absent for the mise tier). */
  flakeLock?: string;
}

// NUL is the unambiguous join separator: lockfile text + an image digest are
// printable, so a NUL can never appear inside an input to forge a seam collision
// (`a‖bc` vs `ab‖c`). It is the `‖` of the design's `env_key = sha256(a ‖ b ‖ c)`.
const SEPARATOR = String.fromCodePoint(0);

// Normalize a hashed input so cosmetic differences (CRLF vs LF, a trailing
// newline, surrounding whitespace) never flip the key: the SAME toolchain content
// must hash to the SAME key regardless of how a lockfile was written to disk.
function normalize(input: string): string {
  return input.replaceAll("\r\n", "\n").trim();
}

/**
 * Compute the deterministic `env_key` for an environment from its content inputs.
 *
 * Same inputs → same key; a different lockfile → a different key (the determinism
 * the registry resolution + the cache key both depend on). The `flake.lock` slot
 * is only mixed in when PRESENT — a mise-tier env (no flake) and a Nix-tier env
 * (with flake) over otherwise-identical inputs are deliberately DIFFERENT keys.
 */
export function computeEnvKey(inputs: EnvKeyInputs): string {
  const parts = [normalize(inputs.baseDigest), normalize(inputs.miseLock)];
  if (inputs.flakeLock !== undefined) {
    parts.push(normalize(inputs.flakeLock));
  }
  return createHash("sha256").update(parts.join(SEPARATOR), "utf8").digest("hex");
}
