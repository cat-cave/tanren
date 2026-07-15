// The LIVE merge-path adapter onto `MergeAuthority` (tanren-owns-the-engine.md §5,
// §8) — the Wave-2 / S1 cutover surface. It is the SINGLE place the live merge path
// (the in-loop `direct_merge` AND the coordinator's `native_queue` DRIVE pass, which
// flow through the SAME `MergeDispatcher.directMerge`) hands off to the guaranteed
// core: it builds the integration node from the run's PR, resolves the concrete
// land target (PR head + current main) through the `CodeHost`, gathers the
// fail-closed signals, builds the binding envelope, and runs `authorizeLand → land`. ONE
// authority, never two gate authorities (§8 guardrail) — both modes route here.
//
// The OUTPUT is a typed disposition the dispatcher records with its existing event
// vocabulary (merged / blocked / needs_attention / conflict / merge_state_unknown) —
// the authority decides, the dispatcher narrates. The host land is `CodeHost.
// landAuthorizedRef` (the ff-only CAS push of the authorized commit), NOT the host's
// "merge PR" API: Tanren made the decision; the host lands what was authorized.

import { createHash } from "node:crypto";
import { memberKey as computeMemberKey } from "../contracts/integrationNodes.js";
import { MergeAuthorityV2Impl, SubjectEqualityRevalidator, type AuthorityLandStore } from "./mergeAuthorityV2Impl.js";
import { buildAuthorizeLandInput, type MergeAuthoritySignals } from "./mergeAuthorityInputs.js";
import { LandCasRejectedError } from "../providers/githubCodeHost.js";
import { parseDigest } from "../contracts/cas.js";
import type { CodeHost, CodeHostRepoRef } from "../contracts/codeHost.js";
import type { Finding } from "../contracts/findings.js";
import type { AuditPosture } from "../contracts/auditPosture.js";
import type { GateOutcome } from "../workflow/gate/index.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { PullRequestMergeability } from "../contracts/codeHostTypes.js";
import type { Digest } from "../contracts/cas.js";
import type { LandBindingEnvelope, LandSubject } from "../contracts/mergeAuthority.js";
import type { RawBudgetScope, RawDemoVerification, RawHitlSignoff } from "./mergeAuthorityInputs.js";
import type { AuditEnvelope } from "../events/schemas/audit.js";
import type { MergeAuthorityBundle } from "../workflow/reviewMerge/mergeDispatchTypes.js";

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
  /** The fail-closed signals to authorize against. */
  signals: LiveMergeSignals;
  /** The writer-backed durable 4-step land store bound to this run's merge-stage context. */
  store: AuthorityLandStore;
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
  const store = bundle.landStoreFor({
    orgId: bundle.orgId,
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    taskId: context.taskId,
    prUrl: context.prUrl,
    prNumber: context.prNumber,
    integration: input.integration,
    auditEnvelope: input.auditEnvelope,
  });
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
    signals,
    store,
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

/** A stable `sha256:<hex>` {@link Digest} over the canonical JSON of `body`. */
function contentDigest(body: unknown): Digest {
  return parseDigest(`sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`);
}

/**
 * Build the V2 land binding envelope for a direct single-member PR land. `headSha` is
 * the PR branch head (the materialized landable commit); `expectedMainSha` is the
 * current default-branch head (the CAS base). `memberSetHash` is the frozen
 * integrationNodes bare-hex member key over `baseSha + [headSha]`. `artifactDigest` +
 * `proofRoot` are genuine content digests of the binding (an SP-3/SP-7 producer replaces
 * them with the sealed bundle digests when the runtime/mergequeue consumers wire them).
 */
function buildEnvelope(
  input: MergeAuthorityGateInput,
  subject: LandSubject,
  baseSha: string,
  headSha: string,
): LandBindingEnvelope {
  const memberSetHash = computeMemberKey(baseSha, [headSha]);
  return {
    subject,
    members: [{ specId: input.specId, runId: input.runId, branch: input.headBranch, headSha, disposition: "admit" }],
    headSha,
    expectedMainSha: baseSha,
    artifactDigest: contentDigest({ repo: input.repo, intoMain: input.intoMain, headSha }),
    proofRoot: contentDigest({
      memberSetHash,
      gateConfigHash: input.gateConfigHash,
      policyVersion: input.policyVersion,
      headSha,
    }),
    memberSetHash,
    policyVersion: input.policyVersion,
    target: { repo: input.repo, intoMain: input.intoMain },
  };
}

/**
 * Run the FULL guaranteed land for one PR through `MergeAuthorityV2`:
 *   authorizeLand (re-validate the binding + the fail-closed truth table)
 *     → land (persist decision + intent → host CAS land → record receipt, with the
 *       merge_state_unknown reconcile).
 * Returns the dispatcher's disposition. The CodeHost's `landAuthorizedIntegration`
 * rejection (main raced ahead) is surfaced as `cas_rejected` (a benign retryable race),
 * kept distinct from `merge_state_unknown` (the land succeeded but the record failed).
 */
export async function authorizeAndLand(input: MergeAuthorityGateInput): Promise<MergeAuthorityDisposition> {
  const { codeHost, repo } = input;
  const baseSha = await requireBranchSha(codeHost, repo, input.intoMain);
  const headSha = await requireBranchSha(codeHost, repo, input.headBranch);
  const subject: LandSubject = { kind: "integration_node", id: `land-${input.runId}` };
  const envelope = buildEnvelope(input, subject, baseSha, headSha);

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
  const reviewApproved = input.signals.reviewVerdict === "approved";
  if (
    reviewApproved &&
    input.reviewedHeadSha !== undefined &&
    input.reviewedHeadSha.toLowerCase() !== headSha.toLowerCase()
  ) {
    return {
      kind: "blocked",
      reasons: [
        `reviewVerdict: forge review receipt is for a different commit than the one being landed ` +
          `(reviewed '${input.reviewedHeadSha}' != landing '${headSha}') — fail closed (re-review the current head)`,
      ],
    };
  }

  const authority = new MergeAuthorityV2Impl(codeHost, new SubjectEqualityRevalidator(), input.store);

  const authorizeInput = buildAuthorizeLandInput({
    subject,
    ...input.signals,
  } satisfies MergeAuthoritySignals);
  const auth = await authority.authorizeLand(authorizeInput, envelope);

  if (auth.decision === "blocked") {
    return { kind: "blocked", reasons: auth.reasons.map((r) => `${r.input}: ${r.detail}`) };
  }
  if (auth.decision === "needs_attention") {
    return { kind: "needs_attention", reasons: auth.reasons.map((r) => `${r.input}: ${r.detail}`) };
  }

  // authorized: execute the transactional land. A CAS rejection (main raced ahead)
  // throws from the host land; surface it as a benign retryable race, distinct from
  // the dangerous post-land finalize failure (merge_state_unknown). The classification
  // is TYPED (`instanceof LandCasRejectedError`), NOT a message regex: the old
  // `/...|CAS|.../iu` matched any "case"/"cascade"/"showcase" substring in an unrelated
  // failure message and mis-mapped a genuine fault into a benign retry.
  let outcome;
  try {
    outcome = await authority.land(auth);
  } catch (error) {
    if (error instanceof LandCasRejectedError) {
      return { kind: "cas_rejected", reason: error.message };
    }
    throw error;
  }
  if (outcome.kind === "landed") {
    return { kind: "merged", mainSha: outcome.mainSha };
  }
  return { kind: "merge_state_unknown", reason: outcome.reason, reconcileToken: outcome.reconcileToken };
}
