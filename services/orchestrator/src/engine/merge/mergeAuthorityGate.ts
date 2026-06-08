// The LIVE merge-path adapter onto `MergeAuthority` (tanren-owns-the-engine.md §5,
// §8) — the Wave-2 / S1 cutover surface. It is the SINGLE place the live merge path
// (the in-loop `direct_merge` AND the coordinator's `native_queue` DRIVE pass, which
// flow through the SAME `MergeDispatcher.directMerge`) hands off to the guaranteed
// core: it builds the integration node from the run's PR, resolves the concrete
// land target (PR head + current main) through the `CodeHost`, gathers the
// fail-closed signals, and runs `prepareIntegration → authorizeLand → land`. ONE
// authority, never two gate authorities (§8 guardrail) — both modes route here.
//
// The OUTPUT is a typed disposition the dispatcher records with its existing event
// vocabulary (merged / blocked / needs_attention / conflict / merge_state_unknown) —
// the authority decides, the dispatcher narrates. The host land is `CodeHost.
// landAuthorizedRef` (the ff-only CAS push of the authorized commit), NOT the host's
// "merge PR" API: Tanren made the decision; the host lands what was authorized.

import { memberKey as computeMemberKey } from "../contracts/integrationNodes.js";
import { MergeAuthorityImpl, type LandFinalizer } from "./mergeAuthorityImpl.js";
import { buildAuthorizeLandInput, type MergeAuthoritySignals } from "./mergeAuthorityInputs.js";
import type { CodeHost, CodeHostRepoRef } from "../contracts/codeHost.js";
import type { Finding } from "../contracts/findings.js";
import type { AuditPosture } from "../contracts/auditPosture.js";
import type { GateOutcome } from "../workflow/gate/index.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { PullRequestMergeability } from "../contracts/vcsProvider.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
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
  /** The fail-closed signals to authorize against. */
  signals: LiveMergeSignals;
  /** The writer-backed durable finalize bound to this run's merge-stage context. */
  finalizer: LandFinalizer;
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
  const finalizer = bundle.finalizerFor({
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
    signals,
    finalizer,
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
 * Build the single-member integration node for a direct PR land. The node's `headSha`
 * is the PR branch head (the materialized landable commit); `baseSha` is the current
 * default-branch head (the CAS base). The member key hashes `baseSha + [headSha]` so
 * the same content yields the same proof identity (§3).
 */
function buildNode(input: MergeAuthorityGateInput, baseSha: string, headSha: string): IntegrationNode {
  return {
    nodeId: `land-${input.runId}`,
    baseBranch: input.intoMain,
    baseSha,
    ref: input.headBranch,
    purpose: "merge_batch",
    members: [{ specId: input.specId, runId: input.runId, branch: input.headBranch, headSha }],
    memberKey: computeMemberKey(baseSha, [headSha]),
    gateConfigHash: input.gateConfigHash,
    policyVersion: input.policyVersion,
    affectedFingerprint: "",
    headSha,
    treeHash: headSha,
    status: "ready",
  };
}

/**
 * Run the FULL guaranteed land for one PR through `MergeAuthority`:
 *   prepareIntegration (resolve the concrete commit + CAS target)
 *     → authorizeLand (the fail-closed truth table)
 *     → land (host CAS push → durable finalize, with the merge_state_unknown reconcile).
 * Returns the dispatcher's disposition. The CodeHost's `landAuthorizedRef` rejection
 * (main raced ahead) is surfaced as `cas_rejected` (a benign retryable race), kept
 * distinct from `merge_state_unknown` (the land succeeded but the record failed).
 */
export async function authorizeAndLand(input: MergeAuthorityGateInput): Promise<MergeAuthorityDisposition> {
  const { codeHost, repo } = input;
  const baseSha = await requireBranchSha(codeHost, repo, input.intoMain);
  const headSha = await requireBranchSha(codeHost, repo, input.headBranch);
  const node = buildNode(input, baseSha, headSha);

  const authority = new MergeAuthorityImpl(codeHost, input.finalizer);
  const prepared = await authority.prepareIntegration({ node, repo, intoMain: input.intoMain, baseSha });

  const authorizeInput = buildAuthorizeLandInput({
    node,
    prepared,
    ...input.signals,
  } satisfies MergeAuthoritySignals);
  const auth = await authority.authorizeLand(authorizeInput);

  if (auth.decision === "blocked") {
    return { kind: "blocked", reasons: auth.reasons.map((r) => `${r.input}: ${r.detail}`) };
  }
  if (auth.decision === "needs_attention") {
    return { kind: "needs_attention", reasons: auth.reasons.map((r) => `${r.input}: ${r.detail}`) };
  }

  // authorized: execute the transactional land. A CAS rejection (main raced ahead)
  // throws from the host land; surface it as a benign retryable race, distinct from
  // the dangerous post-land finalize failure (merge_state_unknown).
  let outcome;
  try {
    outcome = await authority.land(auth);
  } catch (error) {
    if (error instanceof Error && /stale compare-and-swap|CAS|fast forward/iu.test(error.message)) {
      return { kind: "cas_rejected", reason: error.message };
    }
    throw error;
  }
  if (outcome.kind === "landed") {
    return { kind: "merged", mainSha: outcome.mainSha };
  }
  return { kind: "merge_state_unknown", reason: outcome.reason, reconcileToken: outcome.reconcileToken };
}
