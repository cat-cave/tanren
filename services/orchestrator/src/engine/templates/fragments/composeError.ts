// TEMPLATE-COMPOSE ERROR CLASS.
//
// Mirrors the shape of `SpeculativeAssemblyError`
// (engine/dag/speculativeAssemblyError.ts): a single structured class for ALL throws
// on the compose path, with a `phase` discriminator that names the specific step
// (base / runtime / frontend / … / post-process). The classifier keys off the class
// NAME (`TemplateComposeError`), so a public failure code stays stable as new phases
// are added; the `phase` field is for internal triage + per-phase narration.
//
// FAIL-LOUD: every compose failure throws this class with the matching phase. The
// composer never SWALLOWS a fragment failure into a default tree — a half-applied
// fragment is a deterministic-build hazard, so every error class above must surface
// here.
//
// CAUSE-CHAINING: the underlying cause (a VfsCollisionError, a json parse failure,
// a fragment.apply throw) rides on `.cause` per the Error constructor's options bag,
// so a downstream logger / classifier can walk it without losing the phase context.

import type { FragmentId, FragmentKind } from "./types.js";

/** The 9 phases + the post-process group, in apply order. `post_process` is the
 * catch-all for the deps/env/justfile/ci/readme finalizers; a more specific phase
 * is preferred when the throw originates inside a single fragment's apply. */
export type TemplateComposePhase = FragmentKind | "post_process";

/** A structured compose-time failure. Carries the `phase` + the offending `fragmentId`
 * (when attributable) for triage; the public failure code reads the CLASS NAME. */
export class TemplateComposeError extends Error {
  constructor(
    readonly phase: TemplateComposePhase,
    message: string,
    readonly fragmentId?: FragmentId,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TemplateComposeError";
  }
}
