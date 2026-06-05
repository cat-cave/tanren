// external-push governance posture. The `governancePosture` enum on
// the project config (strict | open | audit_only) already exists; this module
// turns it into actual behavior at the merge decision point.
//
// The posture governs how Tanren coexists with non-Tanren contributors on a
// repo. The decision has two inputs: the configured posture and whether the PR
// carries *external* (non-Tanren) commits.
//
//   strict     — Tanren only operates on its own changes. An external commit on
//                the PR blocks the merge and requires explicit operator
//                approval (a typed `merge.blocked` outcome the operator clears).
//   open       — coexist freely. Tanren proceeds alongside external
//                contributors; external commits never block.
//   audit_only — Tanren observes/reports on external changes but does not
//                auto-merge them. An external commit converts the merge into an
//                observed hand-off (no merge call), recorded via `merge.blocked`
//                with `mode: "audit_only"`. A clean (Tanren-only) PR proceeds.
//
// External-change detection is injected as a `ContributorProbe` so the merge
// stage can mock it in tests and resolve it through GitHub in production
// without this module reaching into the provider surface directly.

import type { GovernancePosture } from "../../config/shared.js";

/** The set of GitHub logins Tanren considers to be itself on a repo. */
export interface TanrenIdentity {
  /** Logins (lower-cased) that represent Tanren's own pushes — bot + executor. */
  logins: ReadonlySet<string>;
}

/** Distinct author/committer logins observed on a PR's commits. */
export interface PullRequestContributors {
  /** Lower-cased distinct logins across the PR's commit authors + committers. */
  logins: ReadonlyArray<string>;
}

/**
 * Injectable contributor lookup. Production resolves this through GitHub (the
 * PR commits listing); tests supply a fake. Kept as a probe so this governance
 * module — and the merge stage — never import the provider HTTP surface.
 */
export interface ContributorProbe {
  listContributors(): Promise<PullRequestContributors>;
}

/** The result of external-change detection against a PR. */
export interface ExternalChangeAssessment {
  /** True when the PR carries at least one commit from a non-Tanren login. */
  hasExternalChange: boolean;
  /** The external (non-Tanren) logins observed, lower-cased + de-duplicated. */
  externalLogins: ReadonlyArray<string>;
}

// GitHub platform commit authors that are never an external human contributor.
// `web-flow` authors the squash/merge commit GitHub creates via the merge API — so
// Tanren's OWN merge of an ancestor PR stamps a `web-flow` commit that then shows up
// in a retargeted dependent PR's history. Not a human push; must not block. A human
// cannot forge a `web-flow`-attributed commit via git push (GitHub only attributes its
// own API/web-created commits to it), so excluding it doesn't weaken real detection.
const GITHUB_PLATFORM_LOGINS: ReadonlySet<string> = new Set(["web-flow"]);

/**
 * Detect whether a PR carries external (non-Tanren) commits. External = not in the
 * Tanren identity set AND not a GitHub platform author. An empty/unknown login is
 * external (an unattributed commit is not provably Tanren's).
 */
export function assessExternalChange(
  contributors: PullRequestContributors,
  identity: TanrenIdentity,
): ExternalChangeAssessment {
  const external: string[] = [];
  const seen = new Set<string>();
  for (const raw of contributors.logins) {
    const login = raw.trim().toLowerCase();
    const isTanren = login !== "" && identity.logins.has(login);
    if (isTanren || GITHUB_PLATFORM_LOGINS.has(login)) {
      continue;
    }
    const key = login === "" ? "<unknown>" : login;
    if (!seen.has(key)) {
      seen.add(key);
      external.push(key);
    }
  }
  return { hasExternalChange: external.length > 0, externalLogins: external };
}

/** Normalize a list of Tanren logins into a lower-cased identity set. */
export function tanrenIdentity(logins: ReadonlyArray<string>): TanrenIdentity {
  const set = new Set<string>();
  for (const login of logins) {
    const normalized = login.trim().toLowerCase();
    if (normalized !== "") {
      set.add(normalized);
    }
  }
  return { logins: set };
}

/** What the posture gate decided the merge stage should do. */
export type PostureDecisionKind = "proceed" | "block" | "observe";

export interface PostureDecision {
  kind: PostureDecisionKind;
  posture: GovernancePosture;
  /** True when the gate ran against a PR with external (non-Tanren) commits. */
  external: boolean;
  /** The external logins that drove a block/observe; empty when proceeding. */
  externalLogins: ReadonlyArray<string>;
  /** Operator-facing reason string for the emitted event / result message. */
  reason: string;
}

/**
 * MERGE-HARDENING (GAP #3): the autonomous-tier auto-approve context. On an AUTONOMOUS
 * tier (reviewPolicy `auto`/`simulated` driving `native_queue`) a `strict`/`lenient`
 * posture BLOCK whose external committers are ALL configured platform / known-automation
 * logins is AUTO-APPROVED instead of stranding a done-run spec into a 3×-churn→park. The
 * built-in `web-flow` is already filtered as non-external in `assessExternalChange`; this
 * extends that to a per-project CONFIGURABLE known-bot set, but only for the autonomous
 * tiers. On the `human` tier (`autonomousTier: false`) the block STILL stands — a human
 * makes the real decision. Absent ⇒ today's behavior (block) is byte-identical.
 */
export interface AutonomousAutoApprove {
  /** True only for the autonomous merge tiers (reviewPolicy auto/simulated + native_queue). */
  autonomousTier: boolean;
  /** The configured platform / known-automation logins (lower-cased), additive to `web-flow`. */
  platformLogins: ReadonlySet<string>;
}

/**
 * The core posture gate. Given the configured posture and an external-change
 * assessment, decide whether the merge stage may proceed, must block pending
 * operator approval, or should observe-only (hand off without merging).
 *
 *   open                          → always proceed
 *   strict + no external change   → proceed (Tanren's own work)
 *   strict + external change      → block (needs operator approval)
 *                                   UNLESS GAP #3 auto-approves (autonomous tier +
 *                                   every external login is a configured known-bot)
 *   audit_only + no external      → proceed
 *   audit_only + external change  → observe (report, do not auto-merge)
 *   lenient                       → same as strict for external coexistence
 *                                   (its gate-advisory relaxation is in-loop only)
 */
export function decidePosture(
  posture: GovernancePosture,
  assessment: ExternalChangeAssessment,
  autoApprove?: AutonomousAutoApprove,
): PostureDecision {
  const externalLogins = assessment.externalLogins;
  const base = { posture, external: assessment.hasExternalChange, externalLogins };
  if (posture === "open" || !assessment.hasExternalChange) {
    return {
      ...base,
      kind: "proceed",
      reason: proceedReason(posture, assessment.hasExternalChange),
    };
  }
  if (posture === "audit_only") {
    return {
      ...base,
      kind: "observe",
      reason: `audit_only posture: external change from ${formatLogins(externalLogins)} observed; not auto-merging`,
    };
  }
  // GAP #3: an AUTONOMOUS-tier block whose external committers are ALL configured
  // platform/known-automation logins auto-approves (the obvious-continue, never a strand
  // → 3×-churn → park). `<unknown>` (an unattributed commit) is NEVER a known-bot, so a
  // genuinely-external human still blocks. The `human` tier (autonomousTier false) skips
  // this and blocks — a real human decision.
  if (
    autoApprove?.autonomousTier === true &&
    externalLogins.length > 0 &&
    externalLogins.every((login) => autoApprove.platformLogins.has(login))
  ) {
    return {
      ...base,
      kind: "proceed",
      reason: `${posture} posture: external commits are all known-automation logins (${formatLogins(externalLogins)}); auto-approved on the autonomous tier`,
    };
  }
  // strict (and lenient, which mirrors strict for external-contributor
  // coexistence) block an external change pending operator approval.
  return {
    ...base,
    kind: "block",
    reason: `${posture} posture: external change from ${formatLogins(externalLogins)} blocks auto-merge; operator approval required`,
  };
}

function proceedReason(posture: GovernancePosture, external: boolean): string {
  if (posture === "open") {
    return external ? "open posture: coexisting with external contributors" : "open posture";
  }
  return `${posture} posture: no external change detected`;
}

function formatLogins(logins: ReadonlyArray<string>): string {
  return logins.length === 0 ? "an unknown contributor" : logins.join(", ");
}
