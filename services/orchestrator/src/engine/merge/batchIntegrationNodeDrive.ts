// BATCH INTEGRATION-NODE DRIVE (tanren-owns-the-engine.md §3), Wave-3 / Slice-3. The
// unconditional path that makes `integration_nodes` DRIVE the batch gate/CI verdict:
//
//   (3b) JJ-LOCAL INTEGRATION — assemble the prospective merged state LOCALLY over A1's
//        jj workspace (no host ref), materializing the node's headSha/treeHash. The gate
//        runs on THIS workspace (the integrated head is a local jj bookmark).
//
//   (3a) PROOF REUSE — UPSERT the integration node for the prospective merged state (its
//        `memberKey` is the integrated-content identity), resolve the six LIVE key
//        components, and decide REUSE vs RECOMPUTE (fail-closed). On a HIT with a PASSING
//        proof: SKIP the re-gate (`integration.proof.reused`) → a synthetic pass. On a
//        MISS / non-passing / unknown-key: run the gate (the caller's gate closure) +
//        `recordProof`.
//
// This module is the ONE place the batch verdict path consults the node model, so the
// batch-checker stays a thin caller. CORRECTNESS: the proof-reuse guard is the §3a safety
// invariant (all six key components match exactly, passing-only) — a reuse can NEVER let
// unproven code merge.

import type { BatchAuthorityBinding, BatchCheckVerdict } from "../contracts/batchMergeCoordinator.js";
import type { CiConfigV1 } from "../ci/index.js";
import type { IntegrationNode, IntegrationNodeMember, ProofReuseKeyInput } from "../contracts/integrationNodes.js";
import { memberKey, proofReuseKey } from "../contracts/integrationNodes.js";
import type { EventStore } from "../eventStore.js";
import type { LiveJjWorkspace, LiveJjWorkspaceDeps } from "../providers/liveJjWorkspace.js";
import type { ProofStorePort } from "../dag/integrationProofReuse.js";
import {
  type JjIntegrationMember,
  type JjLocalIntegrationInput,
  type JjLocalIntegrationResult,
  withJjLocalIntegration,
} from "../dag/jjLocalIntegration.js";
import { hashGateConfig, resolveLiveKeyComponents } from "../dag/integrationProofKey.js";
import { decideProofReuse, type LiveProofKeyComponents, recordProofVerdict } from "../dag/integrationProofReuse.js";
import type { CoverageAuthorityReadyNodeMaterializer } from "../runtimeVerification/coverageAuthorityMaterializer.js";
import { buildBatchGateProofEvidence } from "./multiMemberAuthorityEvidence.js";

/** The local bookmark name the prospective merged state materializes as (NEVER pushed). */
export function batchLocalIntegrationRef(tailSpecId: string): string {
  return `tanren-local-batch-${tailSpecId.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;
}

/** The facts the node-drive path needs (resolved by the caller — repo, base, members). */
export interface BatchNodeDriveFacts {
  orgId: string;
  projectId: string;
  baseBranch: string;
  baseSha: string;
  repoUrl: string;
  runnerImage: string;
  tailSpecId: string;
  /** The ordered members (DAG order) merged into the base. */
  members: ReadonlyArray<JjIntegrationMember & { readonly runId: string }>;
  /** The governance/config version the verdict is judged under (the policy version). */
  policyVersion: string | undefined;
  /** The quarantine (flaky-skip) set version in effect. */
  quarantineVersion: string | undefined;
  /** The dev+test app env threaded to the gate (affects the build/test). */
  appEnv?: Record<string, string>;
}

/**
 * Resolve the gate config from the OPEN jj-local workspace (the integrated head). Needed
 * for the gateConfigHash key component BEFORE the gate runs — so even a REUSE keys on the
 * exact config the proof was produced under. Returns `undefined` when the config cannot
 * be read (fail-closed: an unresolvable gateConfigHash forces a recompute).
 */
export type ResolveBatchGateConfig = (live: LiveJjWorkspace) => Promise<CiConfigV1 | undefined>;

/**
 * Run the real native gate on the OPEN jj-local workspace (the integrated head) — called
 * ONLY on a RECOMPUTE. It resolves its own CI config internally (as the fresh-runner gate
 * does today). Returns the verdict + whether it passed (the recorded proof).
 */
export type GateBatchWorkspace = (live: LiveJjWorkspace) => Promise<{ verdict: BatchCheckVerdict; passed: boolean }>;

/**
 * The jj-local integration port: open a workspace, stack the members, run the
 * continuation on the integrated workspace, release. Defaults to {@link withJjLocalIntegration}
 * (the real A1-backed integration); injected as a port so the drive's proof-reuse logic is
 * unit-testable WITHOUT a live runner.
 */
export type JjIntegratePort = typeof withJjLocalIntegration;

/**
 * The integration-node store the drive needs after the authority materializer owns the
 * ready write: read by memberKey plus proof-store ports (find/record).
 */
export interface BatchNodeStore extends ProofStorePort {
  findByMemberKey(orgId: string, key: string): Promise<IntegrationNode | undefined>;
}

export interface BatchNodeDriveDeps {
  nodes: BatchNodeStore;
  eventStore: EventStore;
  /** The A1 live-jj-workspace deps (allocator/ssh/secrets/vcsProvider/minter/facts). */
  jjWorkspaceDeps: LiveJjWorkspaceDeps;
  resolveConfig: ResolveBatchGateConfig;
  gate: GateBatchWorkspace;
  /** Sole ready-node producer: derives the exact diff + stamps the canonical graph seal. */
  materializeReadyNode: CoverageAuthorityReadyNodeMaterializer;
  /** The jj-local integration runner (defaults to the real A1-backed `withJjLocalIntegration`). */
  integrate?: JjIntegratePort;
}

/**
 * Drive the batch verdict through the integration node (jj-local integration + proof
 * reuse). FAIL-CLOSED throughout:
 *   1. JJ-LOCAL INTEGRATION (3b): stack the ordered members on the base LOCALLY. A
 *      spec-vs-spec conflict short-circuits to the SAME `conflict` verdict the server
 *      build returned (no host ref written).
 *   2. UPSERT the node (the memberKey identity + the materialized head/tree/status).
 *   3. RESOLVE the gate config from the same workspace → the gateConfigHash component.
 *   4. PROOF REUSE (3a): resolve the six live key components + decide. On REUSE: a
 *      synthetic pass (the gate is NOT run). On RECOMPUTE: run the gate on the workspace +
 *      record the proof under the (sound) key. An unreadable config OR an unreadable
 *      node ⇒ RECOMPUTE (never reuse on uncertainty).
 */
export async function driveBatchThroughNode(
  facts: BatchNodeDriveFacts,
  deps: BatchNodeDriveDeps,
): Promise<BatchCheckVerdict> {
  const localRef = batchLocalIntegrationRef(facts.tailSpecId);
  const integrate = deps.integrate ?? withJjLocalIntegration;
  const input: JjLocalIntegrationInput = {
    baseBranch: facts.baseBranch,
    repoUrl: facts.repoUrl,
    members: facts.members,
    localRef,
  };
  const result = await integrate(deps.jjWorkspaceDeps, input, (live, integrated) =>
    verdictForIntegrated(facts, deps, live, integrated),
  );
  if (result.outcome === "conflict") {
    return conflictVerdict(result, facts.baseBranch);
  }
  return result.value;
}

/** Decide + (maybe) gate for a successfully integrated node, on the still-open workspace. */
async function verdictForIntegrated(
  facts: BatchNodeDriveFacts,
  deps: BatchNodeDriveDeps,
  live: LiveJjWorkspace,
  integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }>,
): Promise<BatchCheckVerdict> {
  // The host head was read before allocation/clone. If the clone imported another base,
  // never bind its product diff or proof to the stale pre-clone identity; hold and re-drive.
  if (integrated.baseSha !== facts.baseSha) {
    return {
      result: "infra-error",
      message: `batch base moved from ${facts.baseSha} to cloned ${integrated.baseSha}; re-drive on the exact base`,
      retriable: true,
    };
  }

  // Resolve the gate config from this exact open workspace before persistence, so the ready
  // node row and its proof carry one identical policy/config identity (the MQ-2 binding).
  const config = await deps.resolveConfig(live);

  const members = membersForIntegratedNode(facts, integrated);
  // 2. Materialize ready through the sole authority producer. It derives base→head targets
  // from THIS still-open workspace and atomically stamps the canonical coverage graph. The
  // gate-config/policy identity is stamped here so the read-back node carries the exact
  // binding the MQ-2 authority evaluator consumes.
  await deps.materializeReadyNode({
    projectId: facts.projectId,
    orgId: facts.orgId,
    baseBranch: facts.baseBranch,
    baseSha: integrated.baseSha,
    ref: integrated.localRef,
    purpose: "merge_batch",
    members,
    ...(config !== undefined && { gateConfigHash: hashGateConfig(config) }),
    ...(facts.policyVersion !== undefined && { policyVersion: facts.policyVersion }),
    headSha: integrated.headSha,
    treeHash: integrated.treeHash,
    workspace: {
      ssh: deps.jjWorkspaceDeps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
    },
  });
  const node = await deps.nodes.findByMemberKey(facts.orgId, memberKeyForNode(integrated.baseSha, members));

  // Fail-closed: an unreadable node OR an unreadable config ⇒ RECOMPUTE (run the gate),
  // never reuse on uncertainty. With no config there is no sound key either, so the gate
  // result is NOT recorded as a proof (a recompute with no key records nothing).
  if (node === undefined || config === undefined) {
    return (await deps.gate(live)).verdict;
  }

  // 4. PROOF REUSE (3a) — resolve the six live key components + decide (fail-closed).
  const components = resolveLiveKeyComponents({
    config,
    runnerImage: facts.runnerImage,
    policyVersion: facts.policyVersion,
    ...(facts.appEnv !== undefined && { appEnv: facts.appEnv }),
    quarantineVersion: facts.quarantineVersion,
  });
  const decision = await decideProofReuse({
    orgId: facts.orgId,
    node,
    components,
    store: deps.nodes,
    emit: async (payload) => {
      await deps.eventStore.append({
        projectId: facts.projectId,
        specId: facts.tailSpecId,
        orgId: facts.orgId,
        eventType: "integration.proof.reused",
        payload: { ...payload, verdict: "passed" },
      });
    },
  });

  if (decision.kind === "reuse") {
    // SKIP the re-gate — the recorded passing proof short-circuits the gate. The node is
    // proven; the batch passes WITHOUT re-running the gate.
    const keyInput = resolvedKeyInput(node.memberKey, components);
    return passWithBinding({ result: "pass", integrationBranch: integrated.localRef }, node, integrated, keyInput);
  }

  // RECOMPUTE — run the real gate on the workspace, then record the proof under the key.
  const gated = await deps.gate(live);
  await recordProofVerdict({
    decision,
    store: deps.nodes,
    orgId: facts.orgId,
    projectId: facts.projectId,
    node,
    passed: gated.passed,
    ...(decision.keyInput === undefined
      ? {}
      : {
          evidence: buildBatchGateProofEvidence({
            nodeId: node.nodeId,
            headSha: integrated.headSha,
            treeHash: integrated.treeHash,
            memberSetHash: node.memberKey,
            keyInput: decision.keyInput,
            passed: gated.passed,
            ...(gated.verdict.result === "fail" ? { message: gated.verdict.message } : {}),
          }),
        }),
  });
  return passWithBinding(gated.verdict, node, integrated, decision.keyInput);
}

/** Add the exact node/proof identity only to a genuinely passing, fully-keyed verdict. */
function passWithBinding(
  verdict: BatchCheckVerdict,
  node: IntegrationNode,
  integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }>,
  keyInput: ProofReuseKeyInput | undefined,
): BatchCheckVerdict {
  if (verdict.result !== "pass" || keyInput === undefined) return verdict;
  const authorityBinding: BatchAuthorityBinding = {
    nodeId: node.nodeId,
    baseBranch: node.baseBranch,
    baseSha: node.baseSha,
    headSha: integrated.headSha,
    treeHash: integrated.treeHash,
    members: node.members,
    memberSetHash: node.memberKey,
    policyVersion: node.policyVersion,
    proof: {
      verdict: "passed",
      proofReuseKey: proofReuseKey(keyInput),
      keyInput,
    },
  };
  return { ...verdict, authorityBinding };
}

/** Mirror the frozen six-component guard without inventing defaults. */
function resolvedKeyInput(nodeMemberKey: string, components: LiveProofKeyComponents): ProofReuseKeyInput | undefined {
  if (
    !components.gateConfigHash.resolved ||
    !components.policyVersion.resolved ||
    !components.runnerImage.resolved ||
    !components.appEnvHash.resolved ||
    !components.quarantineVersion.resolved
  ) {
    return undefined;
  }
  return {
    memberKey: nodeMemberKey,
    gateConfigHash: components.gateConfigHash.value,
    policyVersion: components.policyVersion.value,
    runnerImage: components.runnerImage.value,
    appEnvHash: components.appEnvHash.value,
    quarantineVersion: components.quarantineVersion.value,
  };
}

/** Map a jj-local spec-vs-spec conflict to the batch verdict the coordinator routes. */
function conflictVerdict(
  integration: Extract<JjLocalIntegrationResult, { outcome: "conflict" }>,
  baseBranch: string,
): BatchCheckVerdict {
  const conflictsWithBase = integration.conflictBetween.otherSpecId === baseBranch;
  return {
    result: "conflict",
    message: integration.message,
    conflictsWithBase,
    conflictBetween: integration.conflictBetween,
  };
}

/**
 * The node's memberKey — recomputed from the SAME pure inputs the UPSERT used (the
 * frozen `memberKey(baseSha, ordered member headShas)`), so the read-back lookup hits
 * the row we just wrote (the UPSERT keys on `(org, member_key)`).
 */
function membersForIntegratedNode(
  facts: BatchNodeDriveFacts,
  integration: Extract<JjLocalIntegrationResult, { outcome: "integrated" }>,
): IntegrationNodeMember[] {
  return facts.members.flatMap((member) => {
    const headSha = integration.memberHeadShas[member.specId];
    // Missing means the member was proven merged-and-dropped during live assembly; its
    // content is already represented by the exact cloned baseSha, not a phantom empty SHA.
    return headSha === undefined
      ? []
      : [{ specId: member.specId, runId: facts.tailSpecId, branch: member.branch, headSha }];
  });
}

function memberKeyForNode(baseSha: string, members: ReadonlyArray<IntegrationNodeMember>): string {
  return memberKey(
    baseSha,
    members.map((member) => member.headSha),
  );
}
