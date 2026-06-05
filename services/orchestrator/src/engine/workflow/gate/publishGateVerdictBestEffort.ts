// BEST-EFFORT FORGE PUBLICATION of an already-decided gate verdict. The native
// gate is the merge authority; publishing the verdict to the forge only MIRRORS
// that decision onto the PR (visibility + branch-protection). A publish failure
// (403/404/5xx/network) must therefore be NON-fatal: it is caught, recorded as a
// `gate.publish_failed` warning on the run timeline, and the run PROCEEDS to merge
// on its internal `gate.verdict`.
//
// This wraps `publishGateVerdict` so every call site (the planner-loop pre_merge
// gate, the planner re-gate, and the merge-coordinator drive re-gate) gets the
// same non-fatal behavior — instead of a 403 halting a fully-passing run.
//
// IMPORTANT: this only ever swallows a failed PUBLISH of a verdict. The decision to
// merge is made elsewhere from `outcome.passed`; a FAILED gate is never laundered
// here. SECURITY: the token never appears in the emitted reason (it carries only the
// caught error's message — an HTTP status / error class).
import type { CiWhen } from "../../ci/index.js";
import { publishGateVerdict, type PublishGateVerdictInput } from "./publishGateVerdict.js";

/** How a `gate.publish_failed` warning is recorded — a thin seam over the call site's event store. */
export type EmitPublishFailed = (input: {
  when: CiWhen;
  headSha: string;
  passed: boolean;
  reason: string;
}) => Promise<void>;

/**
 * Publish the gate verdict to the forge, tolerating a publish failure. On success,
 * nothing else happens. On ANY thrown publish error the error is caught and reported
 * via `emit` as a `gate.publish_failed` warning, and this resolves normally so the
 * caller proceeds to merge on the internal verdict. Never re-throws.
 */
export async function publishGateVerdictBestEffort(
  publishInput: PublishGateVerdictInput,
  when: CiWhen,
  passed: boolean,
  emit: EmitPublishFailed,
): Promise<void> {
  try {
    await publishGateVerdict(publishInput);
  } catch (error) {
    await emit({
      when,
      headSha: publishInput.headSha,
      passed,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
