// AGENT SCHEMA MAPPER — DesignContract → TemplateConfig (PR-E placeholder).
//
// THIS FILE IS A SEAM CLAIM, NOT AN IMPLEMENTATION. It declares the future seam
// between the native DESIGN subsystem (DesignContract, see
// docs/roadmap/native-design-subsystem.md) and the matrix-hit composer
// (compose.ts/composeTemplate). When the operator's design pass converges on a
// project posture, that posture is mapped to a `TemplateConfig` here — if the result
// hits the registered matrix, the composer runs; otherwise the agent fallback (the
// existing template-build child run, unchanged in PR-A) takes over.
//
// THE FUTURE PR WILL:
//   - Read the persisted DesignContract from the run's design-pass output.
//   - Map (runtime preference, db preference, deploy target, examples) onto the
//     matrix enums (RuntimeId, DbId, DeployId, ExampleId).
//   - Validate the resulting TemplateConfig via the zod schema.
//   - Return either { kind: "matrix_hit", config } or { kind: "matrix_miss", reason }
//     so the caller routes to compose vs the agent fallback.
//   - On a `matrix_miss`, log the unmet preference (the next matrix-extension PR).
//
// NEVER INSTANTIATED IN PR-A. The export below throws at runtime to make accidental
// imports loud (a future commit replaces the body).

import type { TemplateConfig } from "./types.js";

/** A placeholder for the DesignContract type — the real type lives under the design
 * subsystem (PR-D). Kept opaque here so this file does not couple PR-A to the
 * not-yet-shipped design module. */
export interface DesignContract {
  // Future: the converged design-pass posture.
  readonly placeholder: true;
}

/** Result of mapping a DesignContract to a TemplateConfig — either a matrix hit (the
 * composer can run) or a miss with a reason (route to the agent fallback). */
export type SchemaMappingResult =
  | { kind: "matrix_hit"; config: TemplateConfig }
  | { kind: "matrix_miss"; reason: string };

/**
 * PR-E PLACEHOLDER. A future PR fills the body; this PR ships the SEAM only so the
 * integration point is reviewed once, in isolation, before the mapping logic lands.
 *
 * Throws on call to make accidental wiring LOUD (PR-A registers no caller — a runtime
 * throw catches a wiring mistake during the PR-E rollout).
 */
export function mapDesignContractToTemplateConfig(_contract: DesignContract): SchemaMappingResult {
  throw new Error(
    "mapDesignContractToTemplateConfig: PR-A is the seam claim only; PR-E fills the body. " +
      "If you reached this throw at runtime, the PR-E wiring is INCOMPLETE — do not catch it.",
  );
}
