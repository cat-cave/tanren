// NATIVE VERDICT PUBLICATION (the no-Actions delivery model). The native gate is
// the merge authority; this is how that verdict reaches the forge so the PR UI
// shows it like any other check. It maps a `GateOutcome` to a Tanren-native
// COMMIT STATUS (`tanren/gate`) and publishes it through `VcsProvider.publishStatus`.
//
// WHY A STATUS, NOT A CHECK-RUN: the GitHub Checks API (`POST /check-runs`) can
// ONLY be called by a GitHub APP token — a PAT / OAuth user token gets HTTP 403.
// Token-connected orgs (the common case) would therefore ALWAYS fail to publish a
// check-run. A commit STATUS (`POST /statuses/{sha}`) works for BOTH tokens and
// Apps and is sufficient for branch protection + the PR surface, so it is the
// universal, correct primitive for publishing the verdict.
//
// Tanren runs the gate itself and PUBLISHES its own verdict — the publication is
// INFORMATIONAL (the merge decision is already made from `GateOutcome.passed`,
// gated internally by the run, NOT by reading this status back). It surfaces the
// native verdict on the PR. Re-published whenever the head SHA changes (e.g. after
// an auto-rebase re-gate), since a status is keyed on the commit it concerns.
//
// SECURITY: the resolved token is passed only to the publish call's auth header
// (never logged/returned). The summary carries only non-secret tier/step names.
import type { RepoRef, ResolvedVcsToken, StatusState, VcsProvider } from "../../contracts/vcsProvider.js";
import type { GateOutcome } from "./runGateForWhen.js";

/** The context label of the native gate's published commit status on the forge. */
export const NATIVE_GATE_CHECK_NAME = "tanren/gate";

/** GitHub caps a commit-status `description` at 140 chars; keep summaries inside it. */
const STATUS_DESCRIPTION_MAX = 140;

export interface PublishGateVerdictInput {
  vcsProvider: VcsProvider;
  repo: RepoRef;
  token: ResolvedVcsToken;
  /** The commit the verdict is about (the just-gated PR/integration head). */
  headSha: string;
  outcome: GateOutcome;
  /** Optional link out (e.g. to the run) rendered in the status detail. */
  detailsUrl?: string;
}

/**
 * Publish the native gate's verdict as a `tanren/gate` COMMIT STATUS on `headSha`.
 * A passed gate is `success`; a failed gate is `failure`, with the description naming
 * the failing tier + step so the PR shows exactly what blocked. Returns nothing —
 * the publication is informational; the merge decision is `outcome.passed`.
 *
 * A commit status is used (not a check-run) because it is the only publish primitive
 * a token credential can issue — check-runs require a GitHub App. Status satisfies
 * branch protection, so it is the simplest correct design for both token and App.
 */
export async function publishGateVerdict(input: PublishGateVerdictInput): Promise<void> {
  const state: StatusState = input.outcome.passed ? "success" : "failure";
  const description = verdictDescription(input.outcome);
  await input.vcsProvider.publishStatus({
    repo: input.repo,
    token: input.token,
    headSha: input.headSha,
    context: NATIVE_GATE_CHECK_NAME,
    state,
    description,
    ...(input.detailsUrl === undefined ? {} : { targetUrl: input.detailsUrl }),
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
