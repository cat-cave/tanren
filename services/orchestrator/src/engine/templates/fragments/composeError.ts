// TEMPLATE-COMPOSE ERROR CLASS.
//
// Mirrors the shape of `SpeculativeAssemblyError`
// (engine/dag/speculativeAssemblyError.ts): a single structured class for ALL throws
// on the compose path, with a `phase` discriminator that names the specific step
// (base / runtime / frontend / … / post-process / dependency_runtime_mismatch). The
// classifier keys off the class NAME (`TemplateComposeError`), so a public failure
// code stays stable as new phases are added; the `phase` field is for internal
// triage + per-phase narration.
//
// FAIL-LOUD: every compose failure throws this class with the matching phase. The
// composer never SWALLOWS a fragment failure into a default tree — a half-applied
// fragment is a deterministic-build hazard, so every error class above must surface
// here.
//
// CAUSE-CHAINING: the underlying cause (a VfsCollisionError, a json parse failure,
// a fragment.apply throw) rides on `.cause` per the Error constructor's options bag,
// so a downstream logger / classifier can walk it without losing the phase context.
//
// STRUCTURED PAYLOAD: a `dependency_runtime_mismatch` throw additionally carries a
// `payload` naming the conflicting fragment + the required vs. active runtime. The
// composer's pre-flight runs this check BEFORE any fragment phase runs, so the
// error fires deterministically and never inside a partially-composed VFS.

import type { FragmentId, FragmentKind } from "./types.js";

/** The 9 phases + the post-process group + the pre-flight dependency check, in apply
 * order. `post_process` is the catch-all for the deps/env/justfile/ci/readme
 * finalizers; a more specific phase is preferred when the throw originates inside a
 * single fragment's apply. `dependency_runtime_mismatch` is the pre-flight check
 * that fires BEFORE any phase runs, when a non-runtime fragment's `dependsOn` lists
 * a runtime fragment that is NOT the active runtime. */
export type TemplateComposePhase = FragmentKind | "post_process" | "dependency_runtime_mismatch";

/** Structured payload attached to a `dependency_runtime_mismatch` throw — names the
 * offending fragment + the runtime it requires + the runtime that was active. Carried
 * so downstream callers (registry routing, the matrix-coverage harness, a future
 * UX surface) can branch on the structured data without parsing the message. */
export interface DependencyRuntimeMismatchPayload {
  readonly fragmentId: FragmentId;
  readonly requiredRuntime: FragmentId;
  readonly activeRuntime: FragmentId;
}

/** A structured compose-time failure. Carries the `phase` + the offending `fragmentId`
 * (when attributable) for triage; the public failure code reads the CLASS NAME.
 * For `phase === "dependency_runtime_mismatch"`, `payload` carries the structured
 * mismatch (fragmentId + requiredRuntime + activeRuntime). */
export class TemplateComposeError extends Error {
  readonly payload?: DependencyRuntimeMismatchPayload;
  constructor(
    readonly phase: TemplateComposePhase,
    message: string,
    readonly fragmentId?: FragmentId,
    options?: { cause?: unknown; payload?: DependencyRuntimeMismatchPayload },
  ) {
    super(message, options);
    this.name = "TemplateComposeError";
    if (options?.payload !== undefined) this.payload = options.payload;
  }
}
