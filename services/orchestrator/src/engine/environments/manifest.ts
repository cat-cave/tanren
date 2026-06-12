import { z } from "zod";

// Environment management (environment-management.md §3 Layer 4 + §5 + §7 P3) — the
// CONTRACT shapes for the `environments` registry jsonb columns (the env-layer
// counterpart of `engine/templates/manifest.ts`). The store persists these
// verbatim and re-parses them on READ — a malformed/legacy-shaped row fails LOUDLY
// (never degrades to a default), the no-silent-fallback doctrine.
//
// STACK-AGNOSTIC by construction: `EnvironmentCapabilities` describes ANY toolchain
// (a node env, a python env, a decades-old Fortran env) as a free tool→version map
// — Tanren names no stack here; the map is the project's own declared toolchain.

// ---- Channel ---------------------------------------------------------------

// The maintenance channel the environment tracks (mirrors `TemplateChannel`).
// `lts` bumps only to LTS/stable; `nightly` aggressively tracks latest (the canary).
export const EnvironmentChannel = z.enum(["lts", "nightly"]);
export type EnvironmentChannelValue = z.infer<typeof EnvironmentChannel>;

// ---- Capabilities ----------------------------------------------------------

// The TOOLCHAIN SUMMARY an environment bakes — the declared tools at their
// versions (`mise` tool-name → version-spec, e.g. `{ node: "22", python: "3.13" }`).
// Selection queries this map by tool (optionally at an exact version) so a
// never-seen toolchain is matched on what it CAN DO, never on a hardcoded stack
// name. STACK-AGNOSTIC: any tool set is valid; Tanren privileges none.
export const EnvironmentCapabilities = z
  .object({
    // tool-name → version-spec the environment provisions. May be EMPTY (the warm
    // golden-base env declares no project tools beyond the baseline).
    tools: z.record(z.string().min(1), z.string().min(1)),
  })
  .strict();
export type EnvironmentCapabilities = z.infer<typeof EnvironmentCapabilities>;

// ---- Provenance ------------------------------------------------------------

// Where the environment came from — durable evidence it is grounded, not
// hand-waved. Mirrors `TemplateProvenance` but carries the ENV-layer build inputs:
// the golden base_digest the env_key was computed over, the lockfile content hashes
// (so a re-build over the same locks is recognized), and the run that created it.
export const EnvironmentProvenance = z
  .object({
    // P2's golden-image content digest the env_key's `base_digest` slot used (the
    // baseline this env's delta layers on). A golden refresh re-keys the env.
    baseDigest: z.string().min(1),
    // sha256 of the project's committed `mise.lock` (the determinism anchor).
    miseLockHash: z.string().min(1),
    // sha256 of the Nix-tier `flake.lock`, when present (absent for the mise tier).
    flakeLockHash: z.string().min(1).optional(),
    // The Tanren run that created/registered this env (absent for a hand-seeded one).
    createdByRunId: z.string().min(1).optional(),
  })
  .strict();
export type EnvironmentProvenance = z.infer<typeof EnvironmentProvenance>;

// ---- Validation proof ------------------------------------------------------

// The per-negative-control verdict (mirrors the template `NegativeControlResult`):
// `proven` = the control genuinely caught the planted defect; `unproven` = not run;
// `"n/a"` = the env does not bake this control.
export const EnvNegativeControlResult = z.enum(["proven", "unproven", "n/a"]);
export type EnvNegativeControlResult = z.infer<typeof EnvNegativeControlResult>;

// The env-image validation proof (environment-management.md §4) — the env-layer
// counterpart of `TemplateValidationProof`, produced by P4's validation harness:
//   - POSITIVE smoke: the bootstrap + a toolchain-check (every declared tool
//     resolves to its LOCKED version) passed.
//   - NEGATIVE controls: an undeclared tool is ABSENT and a wrong/forbidden version
//     is not resolvable (proving isolation, catching golden-base leakage).
// NULL on a row means UNVALIDATED — the registry keeps the env `draft`. P3 records
// the SHAPE only; P4 produces real proofs.
export const EnvironmentValidationProof = z
  .object({
    // The positive smoke passed (bootstrap + every declared tool at its locked version).
    positiveSmokePassed: z.boolean(),
    // Negative controls proving isolation.
    negativeControls: z
      .object({
        // An undeclared tool is absent (no golden-base leakage).
        undeclaredToolAbsent: EnvNegativeControlResult,
        // A wrong/forbidden version is not resolvable.
        forbiddenVersionAbsent: EnvNegativeControlResult,
      })
      .strict(),
    // When the proof was produced (ISO-8601). The registry degrades an env whose
    // proof expires.
    validatedAt: z.string().min(1),
  })
  .strict();
export type EnvironmentValidationProof = z.infer<typeof EnvironmentValidationProof>;
