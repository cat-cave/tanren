// The LIVE merge-path adapter onto `MergeAuthority` (tanren-owns-the-engine.md §5,
// §8) — the Wave-2 / S1 cutover surface. It is the SINGLE place the live merge path
// preserves the pre-authorize TOCTOU guards for a legacy per-run dispatch attempt.
// Automatic land itself is queue-only: `CanonicalQueueAuthorityDrive` receives the
// persisted node/proof binding emitted by the batch checker and calls V2 through the
// durable group store. This file must never recreate that binding from a raw PR.
//
// The OUTPUT is a typed disposition the dispatcher records with its existing event
// vocabulary (merged / blocked / needs_attention / conflict / merge_state_unknown) —
// the authority decides, the dispatcher narrates. The host land is `CodeHost.
// landAuthorizedRef` (the ff-only CAS push of the authorized commit), NOT the host's
// "merge PR" API: Tanren made the decision; the host lands what was authorized.

import type { CodeHost, CodeHostRepoRef } from "../contracts/codeHost.js";
import type { Finding } from "../contracts/findings.js";
import type { AuditPosture } from "../contracts/auditPosture.js";
import type { GateOutcome } from "../workflow/gate/index.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { PullRequestMergeability } from "../contracts/codeHostTypes.js";
import type { RawBudgetScope, RawDemoVerification, RawHitlSignoff } from "./mergeAuthorityInputs.js";
import type { BehaviorLandGate } from "./behaviorLandGate.js";
import type { DesignRenderGate } from "./designRenderLandGate.js";
import type { AuditEnvelope } from "../events/schemas/audit.js";
import type { MergeAuthorityBundle } from "../workflow/reviewMerge/mergeDispatchTypes.js";
import { evaluateExactReviewReceiptHead } from "./landSignals.js";
import { evaluateReviewRules, type GovernanceReviewGate } from "../governance/reviewRules.js";

/**
 * The fail-closed signals the dispatcher gathers for ONE land authorization, in
 * their RAW upstream forms. The dispatcher resolves mergeability + conflict state
 * itself (it already owns the probe); the rest are threaded from the run loop /
 * coordinator (the gate outcome, review verdict, posture + findings, budget, demo,
 * HITL). Any signal the live path could not resolve is passed as its ABSENT form so
 * the mapping in `mergeAuthorityInputs` BLOCKS — never a synthesized passing value.
 */
export interface LiveMergeSignals {
  gateOutcome: GateOutcome | undefined;
  findings: ReadonlyArray<Finding>;
  auditPosture: AuditPosture;
  reviewVerdict: ReviewVerdict | undefined;
  mergeability: PullRequestMergeability | undefined;
  budget: RawBudgetScope;
  demo: RawDemoVerification | undefined;
  hitlSignoff: RawHitlSignoff | undefined;
  conflictsResolved: boolean;
}

/** Everything the gate needs to build the node + resolve the concrete land target. */
export interface MergeAuthorityGateInput {
  codeHost: CodeHost;
  repo: CodeHostRepoRef;
  /** The default branch the land advances (e.g. `main`). */
  intoMain: string;
  /** The PR head branch whose head sha is the authorized commit. */
  headBranch: string;
  runId: string;
  specId: string;
  gateConfigHash: string;
  policyVersion: string;
  /**
   * The sha the latest passed `pre_merge` gate verdict was FOR. The land authorizes
   * ONLY when this EQUALS the head being landed (the gate↔land TOCTOU guard). A
   * head-advance after the gate but before the land makes them differ → BLOCK.
   * `undefined` ⇒ no recorded verdict (the gate input already blocks).
   */
  gatedHeadSha: string | undefined;
  /**
   * The sha the latest terminal review forge receipt was FOR (gv-2). When present
   * (strict simulated review), the land authorizes ONLY when this EQUALS the head
   * being landed — event existence alone never authorizes a drifted head.
   * `undefined` for human/auto paths without a forge receipt.
   */
  reviewedHeadSha: string | undefined;
  /** Simulated policy fails closed when the receipt tuple is absent or malformed. */
  requiresExactReviewReceipt: boolean;
  /** Immutable review requirements and their durable, actor-bound evidence. */
  reviewGate: GovernanceReviewGate;
  /** The fail-closed signals to authorize against. */
  signals: LiveMergeSignals;
  /**
   * rv-gate — the run's runtime BEHAVIOR-acceptance outcome. Held as a SIBLING of `signals`
   * (NOT inside the frozen `AuthorizeLandInput`, per mergeAuthority.ts reconciliation rule 2:
   * SP-5 EMITS evidence, it never bolts a field onto the decision input). It is enforced as a
   * PRE-AUTHORIZE guard here (mirroring the gate↔land / review↔land commit-binding guards):
   * `not_applicable` never blocks; `failed`/`inconclusive` fail closed.
   */
  behaviorGate: BehaviorLandGate;
  /**
   * ds-4 — the run's DESIGN-RENDER (a11y) acceptance outcome. Held as a SIBLING of `signals`
   * (NOT inside the frozen `AuthorizeLandInput`, per mergeAuthority.ts reconciliation rule 2:
   * SP-5 EMITS evidence, it never bolts a field onto the decision input). Enforced as a
   * PRE-AUTHORIZE guard here (mirroring the behavior / gate↔land / review↔land guards):
   * `not_applicable` never blocks; `failed`/`inconclusive` fail closed.
   */
  designRenderGate: DesignRenderGate;
  /** Native-queue claim/policy fence invoked after proof and immediately before host CAS. */
  confirmBeforeAuthorityCas?: () => Promise<boolean>;
}

/**
 * The gate's disposition — the authority's verdict translated into what the
 * dispatcher does next. `merged` carries the landed main sha; `blocked` /
 * `needs_attention` carry the reasons (named failing inputs); `merge_state_unknown`
 * is the §5 reconcile state (the host advanced `main` but the durable record failed);
 * `cas_rejected` is a benign race (main moved underneath) the dispatcher retries.
 */
export type MergeAuthorityDisposition =
  | { kind: "merged"; mainSha: string }
  | { kind: "blocked"; reasons: ReadonlyArray<string> }
  | { kind: "needs_attention"; reasons: ReadonlyArray<string> }
  | { kind: "merge_state_unknown"; reason: string; reconcileToken: string }
  | { kind: "cas_rejected"; reason: string };

/** The run-stage identity the live land needs from the dispatcher's context. */
export interface LiveLandContext {
  repo: CodeHostRepoRef;
  intoMain: string;
  runId: string;
  specId: string;
  projectId: string;
  taskId: string;
  prUrl: string;
  prNumber: number;
}

/**
 * The §5 live land: gather the dispatcher-owned signals (the mergeability + conflict
 * state) with the bundle's fail-closed inputs, bind the run's durable finalizer, and
 * run `prepareIntegration → authorizeLand → land`. Returns the disposition the
 * dispatcher maps onto the merge stage's event vocabulary. A missing PR head branch is
 * surfaced as `blocked` (no land target — fail-closed, recoverable).
 */
export async function runAuthorityLand(input: {
  bundle: MergeAuthorityBundle;
  mergeability: PullRequestMergeability;
  context: LiveLandContext;
  integration: "direct_merge" | "native_queue";
  auditEnvelope: AuditEnvelope;
  /** Existing claim confirmation, composed with the QueuePolicyController final recheck. */
  confirmBeforeAuthorityCas?: () => Promise<boolean>;
}): Promise<MergeAuthorityDisposition> {
  const { bundle, mergeability, context } = input;
  if (mergeability.headBranch === "") {
    return { kind: "blocked", reasons: ["cannot resolve PR head branch for the authorized land"] };
  }
  const signals: LiveMergeSignals = {
    gateOutcome: bundle.gateOutcome,
    findings: bundle.findings,
    auditPosture: bundle.auditPosture,
    reviewVerdict: bundle.reviewVerdict,
    mergeability,
    budget: bundle.budget,
    demo: bundle.demo,
    hitlSignoff: bundle.hitlSignoff,
    conflictsResolved: mergeability.state !== "dirty",
  };
  return authorizeAndLand({
    codeHost: bundle.codeHost,
    repo: context.repo,
    intoMain: context.intoMain,
    headBranch: mergeability.headBranch,
    runId: context.runId,
    specId: context.specId,
    gateConfigHash: bundle.gateConfigHash,
    policyVersion: bundle.policyVersion,
    gatedHeadSha: bundle.gatedHeadSha,
    reviewedHeadSha: bundle.reviewedHeadSha,
    requiresExactReviewReceipt: bundle.requiresExactReviewReceipt,
    reviewGate: bundle.reviewGate,
    signals,
    behaviorGate: bundle.behaviorGate,
    designRenderGate: bundle.designRenderGate,
    ...(input.confirmBeforeAuthorityCas === undefined
      ? {}
      : { confirmBeforeAuthorityCas: input.confirmBeforeAuthorityCas }),
  });
}

/** Resolve a branch ref's head sha through the CodeHost, or throw if it is absent. */
async function requireBranchSha(codeHost: CodeHost, repo: CodeHostRepoRef, branch: string): Promise<string> {
  const sha = await codeHost.fetchRef({ repo, remoteBranch: branch });
  if (sha === undefined) {
    throw new Error(`cannot resolve land target: branch '${branch}' has no head sha on ${repo.owner}/${repo.name}`);
  }
  return sha;
}

/**
 * Preserve the live TOCTOU and governance guards for a legacy dispatch attempt, but
 * never manufacture an integration-node subject or digest for it. The only automatic
 * land route is the canonical queue path, which begins at `driveBatchThroughNode`.
 */
export async function authorizeAndLand(input: MergeAuthorityGateInput): Promise<MergeAuthorityDisposition> {
  const { codeHost, repo } = input;
  const headSha = await requireBranchSha(codeHost, repo, input.headBranch);

  // COMMIT-BINDING (the gate↔land TOCTOU guard, §5): the gate verdict must be FOR
  // EXACTLY the commit being landed. A passing gate is honored ONLY when its
  // gated-sha equals the head being landed (`headSha`, resolved fresh above). If the
  // head advanced AFTER the gate but BEFORE the land (eager base-shift / concurrent
  // rebase / any push), the verdict is fresh-in-time yet for a DIFFERENT commit →
  // BLOCK (a fresh re-gate on the new head is then required). When the gate did not
  // pass (`gateOutcome === undefined`) the gate input already blocks, so the
  // commit-binding only adds a block when a PASSING verdict is for the wrong sha.
  const gatePassing = input.signals.gateOutcome?.passed === true;
  if (gatePassing && input.gatedHeadSha !== headSha) {
    return {
      kind: "blocked",
      reasons: [
        `gateVerdict: gate verdict is for a different commit than the one being landed ` +
          `(gated '${input.gatedHeadSha ?? "unknown"}' != landing '${headSha}') — fail closed (re-gate the current head)`,
      ],
    };
  }

  // COMMIT-BINDING (the review↔land TOCTOU guard, gv-2): when the terminal
  // review event carries a forge receipt headSha (strict simulated publication),
  // that receipt must be FOR EXACTLY the commit being landed. Merely observing
  // `review.approved` is not enough — a head-advance after publication fails
  // closed until the advanced head is re-reviewed / re-gated. Human/auto paths
  // omit the receipt (`reviewedHeadSha === undefined`) and skip this bind.
  const reviewReceiptGuard = evaluateExactReviewReceiptHead({
    reviewVerdict: input.signals.reviewVerdict,
    reviewedHeadSha: input.reviewedHeadSha,
    landingHeadSha: headSha,
    receiptRequired: input.requiresExactReviewReceipt,
  });
  if (reviewReceiptGuard.kind === "blocked") {
    return {
      kind: "blocked",
      reasons: [`reviewVerdict: ${reviewReceiptGuard.reason} — fail closed (re-review the current head)`],
    };
  }

  // GV-12 REVIEW RULES: a generic `review.approved` event is insufficient when
  // governance requires a particular reviewer, approval count, forge receipt, or
  // exact-head freshness. The durable evidence is interpreted HERE, immediately
  // before the sole MergeAuthority, so missing/unreadable/unresolved review proof
  // blocks rather than becoming an auto-pass.
  const reviewRules = evaluateReviewRules({
    gate: input.reviewGate,
    latestVerdict: input.signals.reviewVerdict ?? "unread",
    landingHeadSha: headSha,
  });
  if (reviewRules.kind === "blocked") {
    return { kind: "blocked", reasons: [`reviewRules: ${reviewRules.reason} — fail closed`] };
  }

  // BEHAVIOR-VERDICT GATE (rv-gate): when a run REQUIRED behavior acceptance (a pre-merge
  // behavior verification produced a blocking, non-quarantined verdict), that behavior must
  // be a decisive PASS. Fail-closed: a decisive product/visual/contract failure OR an
  // inconclusive/absent/still-running required verdict NEVER authorizes (inconclusive ≠
  // passed). `not_applicable` (no behavior verification was required — most runs) NEVER
  // blocks: the behavior section only gates when there is a required behavior to gate on,
  // mirroring how the native CI gate only applies when CI ran. A quarantined behavior was
  // already excluded-from-green upstream, so it neither passes nor blocks here.
  const behavior = input.behaviorGate;
  if (behavior.kind === "failed") {
    return {
      kind: "blocked",
      reasons: [
        `runtimeBehavior: required behavior '${behavior.behaviorRevisionId}' recorded '${behavior.outcome}' ` +
          `on the live surface — fail closed (a required product-behavior failure never authorizes)`,
      ],
    };
  }
  if (behavior.kind === "inconclusive") {
    return {
      kind: "blocked",
      reasons: [
        `runtimeBehavior: ${behavior.reason} — fail closed ` +
          `(a required-but-not-green behavior verdict never authorizes; inconclusive ≠ passed)`,
      ],
    };
  }

  // DESIGN-RENDER GATE (ds-4): when a run REQUIRED design-render acceptance (its project has a
  // composed design system with a real, non-"none" accessibility posture), that render/a11y
  // verification must be a decisive PASS. Fail-closed: a `failed` (real axe violation at/above
  // the posture bar) OR an `inconclusive`/required-but-absent verdict NEVER authorizes
  // (inconclusive ≠ passed). `not_applicable` (no design system / posture "none" — most runs)
  // NEVER blocks: the design_render section only gates when there is a required design to gate on.
  const designRender = input.designRenderGate;
  if (designRender.kind === "failed") {
    return {
      kind: "blocked",
      reasons: [
        `design_render: required design scenario '${designRender.failingScenarioKey}' failed accessibility ` +
          `(${designRender.failingRuleIds.join(", ") || "a11y violation"}) — fail closed ` +
          `(a required design-render failure never authorizes)`,
      ],
    };
  }
  if (designRender.kind === "inconclusive_infrastructure") {
    return {
      kind: "blocked",
      reasons: [
        `design_render: ${designRender.reason} — fail closed ` +
          `(a required-but-not-green design-render verdict never authorizes; inconclusive ≠ passed)`,
      ],
    };
  }

  // The final irreversible authority boundary. Native-queue callers compose the
  // durable owner/epoch renewal with QueuePolicyController.apply(claim), so a
  // freeze or blackout inserted after proof but before this point turns the row
  // into held_policy and prevents the host CAS. The direct path has no queue
  // claim, so it intentionally does not supply this callback.
  if (input.confirmBeforeAuthorityCas !== undefined && !(await input.confirmBeforeAuthorityCas())) {
    return { kind: "blocked", reasons: ["native queue claim or policy fence could not be confirmed before host CAS"] };
  }

  return {
    kind: "blocked",
    reasons: [
      "canonical queue authority is required: no persisted ready integration node and matching passed proof were supplied",
    ],
  };
}
