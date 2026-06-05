// NATIVE VERDICT PUBLICATION (the no-Actions delivery model). The native gate is
// the merge authority; this is how that verdict reaches the forge so the PR UI
// shows it like any other check. It maps a `GateOutcome` to a Tanren-native
// check-run (`tanren/gate`) and publishes it through `VcsProvider.publishCheck`.
//
// Tanren runs the gate itself and PUBLISHES its own verdict — the publication is
// informational (the merge decision is already made from `GateOutcome.passed`);
// it surfaces the native verdict on the PR. Re-published whenever the head SHA
// changes (e.g. after an auto-rebase re-gate), since a check-run is keyed on the
// commit it concerns.
//
// SECURITY: the resolved token is passed only to the publish call's auth header
// (never logged/returned). The summary carries only non-secret tier/step names.
import type { CheckConclusion, RepoRef, ResolvedVcsToken, VcsProvider } from "../../contracts/vcsProvider.js";
import type { GateOutcome } from "./runGateForWhen.js";

/** The display name of the native gate's published check-run on the forge. */
export const NATIVE_GATE_CHECK_NAME = "tanren/gate";

export interface PublishGateVerdictInput {
  vcsProvider: VcsProvider;
  repo: RepoRef;
  token: ResolvedVcsToken;
  /** The commit the verdict is about (the just-gated PR/integration head). */
  headSha: string;
  outcome: GateOutcome;
  /** Optional link out (e.g. to the run) rendered in the check detail. */
  detailsUrl?: string;
}

/**
 * Publish the native gate's verdict as a `tanren/gate` check-run on `headSha`.
 * A passed gate is `success`; a failed gate is `failure`, with the summary naming
 * the failing tier + step so the PR shows exactly what blocked. Returns nothing —
 * the publication is informational; the merge decision is `outcome.passed`.
 */
export async function publishGateVerdict(input: PublishGateVerdictInput): Promise<void> {
  const conclusion: CheckConclusion = input.outcome.passed ? "success" : "failure";
  const { title, summary } = verdictText(input.outcome);
  await input.vcsProvider.publishCheck({
    repo: input.repo,
    token: input.token,
    name: NATIVE_GATE_CHECK_NAME,
    headSha: input.headSha,
    conclusion,
    title,
    summary,
    ...(input.detailsUrl === undefined ? {} : { detailsUrl: input.detailsUrl }),
  });
}

/** The human-readable title + summary for a gate verdict (no secrets). */
function verdictText(outcome: GateOutcome): { title: string; summary: string } {
  if (outcome.passed) {
    const tiers = outcome.results.map((result) => result.tier).join(", ");
    return {
      title: "Tanren gate passed",
      summary: tiers === "" ? "The native pre-merge gate passed." : `The native pre-merge gate passed: ${tiers}.`,
    };
  }
  const failure = outcome.failure;
  return {
    title: "Tanren gate failed",
    summary: `The native pre-merge gate failed at tier \`${failure.tier}\`, step \`${failure.failedStep}\` (exit ${failure.exitCode ?? "n/a"}).`,
  };
}
