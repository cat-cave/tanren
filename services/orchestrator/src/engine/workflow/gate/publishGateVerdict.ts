// NATIVE VERDICT PUBLICATION (the no-Actions delivery model). The native gate is
// the merge authority; this is how that verdict reaches the forge so the PR UI
// shows it like any other check. It maps a `GateOutcome` to a Tanren-native
// COMMIT STATUS (`tanren/gate`) and publishes it through the best-effort
// `SafeVisibilityProjection.publishGate` seam (tanren-owns-the-engine.md §0, §6) —
// the canonical forge-UI mirror. The projection is severed by `harden()`, so a
// publish failure surfaces as a `ProjectionOutcome` and CAN NEVER reject.
//
// WHY A STATUS, NOT A CHECK-RUN: the GitHub Checks API (`POST /check-runs`) can
// ONLY be called by a GitHub APP token — a PAT / OAuth user token gets HTTP 403.
// Token-connected orgs (the common case) would therefore ALWAYS fail to publish a
// check-run. A commit STATUS (`POST /statuses/{sha}`) works for BOTH tokens and
// Apps and is sufficient for branch protection + the PR surface, so it is the
// universal, correct primitive for publishing the verdict — and that is exactly
// what `GitHubVisibilityProjection.publishGate` issues under the seam.
//
// Tanren runs the gate itself and PUBLISHES its own verdict — the publication is
// INFORMATIONAL (the merge decision is already made from `GateOutcome.passed`,
// gated internally by the run, NOT by reading this status back). It surfaces the
// native verdict on the PR. Re-published whenever the head SHA changes (e.g. after
// an auto-rebase re-gate), since a status is keyed on the commit it concerns.
//
// SECURITY: the resolved token never appears here — the projection seam holds its
// own token supplier and passes it only to the publish call's auth header (never
// logged/returned). The summary carries only non-secret tier/step names.
import type { ProjectionOutcome, SafeVisibilityProjection } from "../../contracts/visibilityProjection.js";
import type { GateOutcome } from "./runGateForWhen.js";

// The forge context label of the published gate status (`tanren/gate`) is owned by the
// projection impl (`GitHubVisibilityProjection.GATE_PROJECTION_CONTEXT`) now that the
// publish routes through the `SafeVisibilityProjection.publishGate` seam — not a
// publisher-side constant any longer.

/** GitHub caps a commit-status `description` at 140 chars; keep summaries inside it. */
const STATUS_DESCRIPTION_MAX = 140;

export interface PublishGateVerdictInput {
  /** The best-effort forge-UI mirror the engine holds (hardened — never rejects). */
  visibility: SafeVisibilityProjection;
  /** The forge-neutral `owner/name` the projection seam carries (parsed by the impl). */
  repoFullName: string;
  /** The commit the verdict is about (the just-gated PR/integration head). */
  headSha: string;
  outcome: GateOutcome;
}

/**
 * Publish the native gate's verdict as a `tanren/gate` COMMIT STATUS on `headSha`,
 * through the best-effort {@link SafeVisibilityProjection.publishGate} seam. A passed
 * gate is `success`; a failed gate is `failure`, with the summary naming the failing
 * tier + step so the PR shows exactly what blocked. Returns the projection outcome
 * (`projected` / `failed` / `skipped`) — the publication is informational; the merge
 * decision is `outcome.passed`, never read back from the status.
 *
 * A commit status is used (not a check-run) because it is the only publish primitive
 * a token credential can issue — check-runs require a GitHub App. Status satisfies
 * branch protection, so it is the simplest correct design for both token and App.
 */
export async function publishGateVerdict(input: PublishGateVerdictInput): Promise<ProjectionOutcome<void>> {
  return input.visibility.publishGate({
    repoFullName: input.repoFullName,
    headSha: input.headSha,
    verdict: input.outcome.passed ? "passed" : "failed",
    summary: verdictDescription(input.outcome),
  });
}

/** The human-readable, length-bounded status description for a gate verdict (no secrets). */
function verdictDescription(outcome: GateOutcome): string {
  if (outcome.passed) {
    const tiers = outcome.results.map((result) => result.tier).join(", ");
    return clamp(tiers === "" ? "Native pre-merge gate passed." : `Native pre-merge gate passed: ${tiers}.`);
  }
  const failure = outcome.failure;
  return clamp(
    `Native pre-merge gate failed at tier ${failure.tier}, step ${failure.failedStep} (exit ${failure.exitCode ?? "n/a"}).`,
  );
}

/** Clamp a description to GitHub's commit-status limit (no secrets in the text). */
function clamp(text: string): string {
  return text.length <= STATUS_DESCRIPTION_MAX ? text : `${text.slice(0, STATUS_DESCRIPTION_MAX - 1)}…`;
}
