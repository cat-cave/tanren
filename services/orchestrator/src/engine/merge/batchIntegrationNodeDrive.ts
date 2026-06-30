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

import type { BatchCheckVerdict } from "../contracts/batchMergeCoordinator.js";
import type { CiConfigV1 } from "../ci/index.js";
import type { IntegrationNode } from "../contracts/integrationNodes.js";
import { memberKey } from "../contracts/integrationNodes.js";
import type { EventStore } from "../eventStore.js";
import type { LiveJjWorkspace, LiveJjWorkspaceDeps } from "../providers/liveJjWorkspace.js";
import type { IntegrationNodeUpsert } from "../dag/integrationNodesPg.js";
import type { ProofStorePort } from "../dag/integrationProofReuse.js";
import {
  type JjIntegrationMember,
  type JjLocalIntegrationInput,
  type JjLocalIntegrationResult,
  withJjLocalIntegration,
} from "../dag/jjLocalIntegration.js";
import { resolveLiveKeyComponents } from "../dag/integrationProofKey.js";
import { decideProofReuse, recordProofVerdict } from "../dag/integrationProofReuse.js";

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
  members: ReadonlyArray<JjIntegrationMember>;
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
 * The integration-node store the drive needs — UPSERT the node + read it back by
 * memberKey, plus the proof-store ports (find/record). The `PgIntegrationNodeModel`
 * satisfies this structurally; a fake satisfies it for the unit tests.
 */
export interface BatchNodeStore extends ProofStorePort {
  upsertNode(input: IntegrationNodeUpsert): Promise<string>;
  findByMemberKey(orgId: string, key: string): Promise<IntegrationNode | undefined>;
}

export interface BatchNodeDriveDeps {
  nodes: BatchNodeStore;
  eventStore: EventStore;
  /** The A1 live-jj-workspace deps (allocator/ssh/secrets/vcsProvider/minter/facts). */
  jjWorkspaceDeps: LiveJjWorkspaceDeps;
  resolveConfig: ResolveBatchGateConfig;
  gate: GateBatchWorkspace;
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
  // 2. UPSERT the node — its memberKey is the integrated-content identity the proof keys on.
  await deps.nodes.upsertNode({
    projectId: facts.projectId,
    orgId: facts.orgId,
    baseBranch: facts.baseBranch,
    baseSha: facts.baseSha,
    ref: integrated.localRef,
    purpose: "merge_batch",
    members: facts.members.map((m) => ({
      specId: m.specId,
      runId: facts.tailSpecId,
      branch: m.branch,
      headSha: integrated.memberHeadShas[m.specId] ?? "",
    })),
    headSha: integrated.headSha,
    treeHash: integrated.treeHash,
    status: "ready",
  });
  const node = await deps.nodes.findByMemberKey(facts.orgId, memberKeyForNode(facts, integrated));

  // 3. Resolve the gate config from the workspace (the gateConfigHash key component).
  const config = await deps.resolveConfig(live);

  // Fail-closed: an unreadable node OR an unreadable config ⇒ RECOMPUTE (run the gate),
  // never reuse on uncertainty. With no config there is no sound key either, so the gate
  // result is NOT recorded as a proof (a recompute with no key records nothing).
  if (node === undefined || config === undefined) {
    return (await deps.gate(live)).verdict;
  }

  // 4. PROOF REUSE (3a) — resolve the six live key components + decide (fail-closed).
  const decision = await decideProofReuse({
    orgId: facts.orgId,
    node,
    components: resolveLiveKeyComponents({
      config,
      runnerImage: facts.runnerImage,
      policyVersion: facts.policyVersion,
      ...(facts.appEnv !== undefined && { appEnv: facts.appEnv }),
      quarantineVersion: facts.quarantineVersion,
    }),
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
    return { result: "pass", integrationBranch: integrated.localRef };
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
  });
  return gated.verdict;
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
function memberKeyForNode(
  facts: BatchNodeDriveFacts,
  integration: Extract<JjLocalIntegrationResult, { outcome: "integrated" }>,
): string {
  return memberKey(
    facts.baseSha,
    facts.members.map((m) => integration.memberHeadShas[m.specId] ?? ""),
  );
}
