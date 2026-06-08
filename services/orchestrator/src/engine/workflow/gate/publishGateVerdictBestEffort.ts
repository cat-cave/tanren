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
// STRUCTURALLY NON-THROWING (the real never-blocks guarantee): the projection is only
// HALF the surface — the `gate.publish_failed` NOTE the failure path `emit`s is itself
// an awaited write that could reject (a transient event-store failure). A best-effort
// WARNING must never fail the gate, so the ENTIRE body — the projection call AND the
// failure-note emit — is wrapped so ANY throw is swallowed (logged) and the function
// ALWAYS resolves. Callers (the merge gate / re-gate paths) await this; it must be
// IMPOSSIBLE for a passing gate to be halted by the best-effort failure-reporting path.
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
 * merge on the internal verdict.
 *
 * STRUCTURALLY NON-THROWING: this function ALWAYS resolves, NEVER rejects. The whole
 * body is wrapped so a throw from ANY source — the projection (already severed by the
 * safe seam) OR the failure-note `emit` (an awaited event-store write that could
 * reject) — is swallowed + logged, not propagated. A best-effort warning can't be
 * allowed to halt a passing gate.
 */
export async function publishGateVerdictBestEffort(
  publishInput: PublishGateVerdictInput,
  when: CiWhen,
  passed: boolean,
  emit: EmitPublishFailed,
): Promise<void> {
  try {
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
    await emitFailureNote(emit, {
      when,
      headSha: publishInput.headSha,
      passed,
      reason: outcome.kind === "failed" ? outcome.error : "gate projection skipped (no publishGate method)",
    });
  } catch (error) {
    // Last-resort severance: NOTHING in the best-effort publish path may reject to the
    // caller (the merge gate awaits this). Swallow + log; the gate stands on its verdict.
    console.warn(
      `[gate] verdict publish (best-effort) threw and was swallowed (merge stands on internal verdict): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Record the `gate.publish_failed` warning, swallowing a failing `emit`. The note is
 * itself best-effort: if the event-store write rejects, a passing gate must NOT be
 * failed by the failure-reporting path — so the rejection is logged, never propagated.
 */
async function emitFailureNote(
  emit: EmitPublishFailed,
  input: { when: CiWhen; headSha: string; passed: boolean; reason: string },
): Promise<void> {
  try {
    await emit(input);
  } catch (error) {
    console.warn(
      `[gate] gate.publish_failed note write threw and was swallowed (merge stands on internal verdict): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
