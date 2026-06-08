// BEST-EFFORT FORGE PUBLICATION of an already-decided gate verdict. The native
// gate is the merge authority; publishing the verdict to the forge only MIRRORS
// that decision onto the PR (visibility + branch-protection). A publish failure
// (403/404/5xx/network) must therefore be NON-fatal: it is recorded as a
// `gate.publish_failed` warning on the run timeline, and the run PROCEEDS to merge
// on its internal `gate.verdict`.
//
// HOW it is non-fatal (tanren-owns-the-engine.md §0, §6): the verdict is published
// through the `SafeVisibilityProjection` seam — the gate status is the canonical
// best-effort UI mirror. `safe.publishGate` returns a `ProjectionOutcome` and CAN
// NEVER REJECT (a forge throw is captured as `failed`), so a publish hiccup is
// STRUCTURALLY incapable of propagating to the merge path. A `failed`/`skipped`
// outcome is reported via `emit`; a `projected` one is silent. The merge decision is
// made elsewhere from `outcome.passed` and is byte-identical whether this projection
// succeeds or fails.
//
// IMPORTANT: this only ever notes a failed PUBLISH of a verdict. A FAILED gate is
// never laundered here. SECURITY: the token never appears in the emitted reason (it
// carries only the projection's captured error message — an HTTP status / error class).
import type { CiWhen } from "../../ci/index.js";
import { harden } from "../../contracts/visibilityProjection.js";
import { VcsProviderVisibilityProjection } from "../../providers/vcsProviderVisibilityProjection.js";
import type { PublishGateVerdictInput } from "./publishGateVerdict.js";

/** The forge-neutral `owner/name` the projection seam carries (parsed back by the impl). */
function repoFullName(repo: PublishGateVerdictInput["repo"]): string {
  return `${repo.owner}/${repo.name}`;
}

/** The human-readable, length-bounded summary the gate status carries (no secrets). */
function gateSummary(outcome: PublishGateVerdictInput["outcome"]): string {
  if (outcome.passed) {
    const tiers = outcome.results.map((result) => result.tier).join(", ");
    return tiers === "" ? "Native pre-merge gate passed." : `Native pre-merge gate passed: ${tiers}.`;
  }
  const failure = outcome.failure;
  return `Native pre-merge gate failed at tier ${failure.tier}, step ${failure.failedStep} (exit ${failure.exitCode ?? "n/a"}).`;
}

/** How a `gate.publish_failed` warning is recorded — a thin seam over the call site's event store. */
export type EmitPublishFailed = (input: {
  when: CiWhen;
  headSha: string;
  passed: boolean;
  reason: string;
}) => Promise<void>;

/**
 * Publish the gate verdict to the forge through the `SafeVisibilityProjection` seam,
 * tolerating a publish failure. On a `projected` outcome nothing else happens. On a
 * `failed`/`skipped` outcome the captured reason is reported via `emit` as a
 * `gate.publish_failed` warning, and this resolves normally so the caller proceeds to
 * merge on the internal verdict. Never re-throws — the safe seam can't reject.
 */
export async function publishGateVerdictBestEffort(
  publishInput: PublishGateVerdictInput,
  when: CiWhen,
  passed: boolean,
  emit: EmitPublishFailed,
): Promise<void> {
  const safe = harden(new VcsProviderVisibilityProjection(publishInput.vcsProvider, async () => publishInput.token));
  const outcome = await safe.publishGate({
    repoFullName: repoFullName(publishInput.repo),
    headSha: publishInput.headSha,
    verdict: publishInput.outcome.passed ? "passed" : "failed",
    summary: gateSummary(publishInput.outcome),
  });
  if (outcome.kind === "projected") {
    return;
  }
  await emit({
    when,
    headSha: publishInput.headSha,
    passed,
    reason: outcome.kind === "failed" ? outcome.error : "gate projection skipped (no publishGate method)",
  });
}
