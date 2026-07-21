// JJ-local integration materializes the prospective head, evaluates the native gate via
// immutable proof units, and is the sole batch-verdict consultation of integration nodes.

import { createHash, randomUUID } from "node:crypto";
import type { BatchAuthorityBinding, BatchCheckVerdict } from "../contracts/batchMergeCoordinator.js";
import type { CiConfigV1 } from "../ci/index.js";
import type { IntegrationNode, IntegrationNodeMember, ProofReuseKeyInput } from "../contracts/integrationNodes.js";
import { memberKey, proofReuseKey } from "../contracts/integrationNodes.js";
import type { EventStore } from "../eventStore.js";
import type { LiveJjWorkspace, LiveJjWorkspaceDeps } from "../providers/liveJjWorkspace.js";
import {
  type JjIntegrationMember,
  type JjLocalIntegrationInput,
  type JjLocalIntegrationResult,
  withJjLocalIntegration,
} from "../dag/jjLocalIntegration.js";
import { hashGateConfig, resolveLiveKeyComponents } from "../dag/integrationProofKey.js";
import type { LiveProofKeyComponents } from "../dag/integrationProofReuse.js";
import type { IntegrationProofUnitGraph } from "../dag/integrationProofUnits.js";
import type { CoverageAuthorityReadyNodeMaterializer } from "../runtimeVerification/coverageAuthorityMaterializer.js";
import type { NativeCiGateObservation, GateProofBundleSealer } from "./gateProofBundleTypes.js";
export { batchFragmentEvidenceWiring } from "./batchFragmentEvidenceWiring.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { FragmentEvidenceResolution } from "../templates/fragments/resolveFragmentEvidenceForBatch.js";

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
export interface GateBatchResult {
  readonly verdict: BatchCheckVerdict;
  readonly passed: boolean;
  /** Present only when the real native gate ran and observed its actual evidence. */
  readonly nativeCi?: NativeCiGateObservation;
}

export type GateBatchWorkspace = (live: LiveJjWorkspace) => Promise<GateBatchResult>;

/** The production F2 evidence lookup runs immediately before proof-graph evaluation. */
export interface BatchFragmentEvidenceRequest {
  readonly orgId: string;
  readonly projectId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly treeHash: string;
  readonly memberSetHash: string;
  readonly localRef: string;
  readonly ssh: CommandSubstrate;
}

export type ResolveBatchFragmentEvidence = (
  live: LiveJjWorkspace,
  request: BatchFragmentEvidenceRequest,
) => Promise<FragmentEvidenceResolution>;

/** Best-effort evidence capture after a passing full gate; never a merge authority. */
export type CaptureBatchFragmentEvidence = (
  live: LiveJjWorkspace,
  request: BatchFragmentEvidenceRequest,
) => Promise<void>;

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
export interface BatchNodeStore {
  findByMemberKey(orgId: string, key: string): Promise<IntegrationNode | undefined>;
}

export interface BatchNodeDriveDeps {
  nodes: BatchNodeStore;
  /** The durable per-unit proof graph; this is the live gate's reuse authority. */
  proofUnits: IntegrationProofUnitGraph;
  /** The sole decisive V2 merge-evidence store. */
  gateBundles: GateProofBundleSealer;
  eventStore: EventStore;
  /** The A1 live-jj-workspace deps (allocator/ssh/secrets/vcsProvider/minter/facts). */
  jjWorkspaceDeps: LiveJjWorkspaceDeps;
  resolveConfig: ResolveBatchGateConfig;
  gate: GateBatchWorkspace;
  /** Optional only for direct unit seams; production PgBatchChecker always wires it. */
  resolveFragmentEvidence?: ResolveBatchFragmentEvidence;
  captureFragmentEvidence?: CaptureBatchFragmentEvidence;
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
 *   4. PROOF-UNIT REUSE (MQ-6): resolve the six live key components and evaluate the
 *      native pre-merge gate as a stamped proof unit. A matching unit short-circuits the
 *      gate; a miss runs the gate inside that unit, records it, and composes the Merkle root.
 *      The legacy whole-node proof is retained only as merge-authority evidence, never as
 *      the gate's pre-graph short-circuit. An unreadable config OR node ⇒ RECOMPUTE.
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

  // 4. PROOF-UNIT REUSE (MQ-6) — resolve the live identity before evaluating the
  // pre-merge gate. A partially-known identity remains fail-closed and runs the gate
  // directly; it cannot be recorded or reused as a proof unit.
  const components = resolveLiveKeyComponents({
    config,
    runnerImage: facts.runnerImage,
    policyVersion: facts.policyVersion,
    ...(facts.appEnv !== undefined && { appEnv: facts.appEnv }),
    quarantineVersion: facts.quarantineVersion,
  });
  const keyInput = resolvedKeyInput(node.memberKey, components);
  if (keyInput === undefined) return (await deps.gate(live)).verdict;

  // The selector is strictly declarative. A malformed, absent, stale, or
  // unmatched contract produces `fallback` and leaves the native pre-merge gate
  // as the sole authority; it never becomes a command or a pass on its own.
  let fragmentEvidence: FragmentEvidenceResolution = { kind: "fallback", reason: "manifest_absent" };
  const evidenceRequest: BatchFragmentEvidenceRequest = {
    orgId: facts.orgId,
    projectId: facts.projectId,
    baseSha: integrated.baseSha,
    headSha: integrated.headSha,
    treeHash: integrated.treeHash,
    memberSetHash: node.memberKey,
    localRef: integrated.localRef,
    ssh: deps.jjWorkspaceDeps.ssh,
  };
  if (deps.resolveFragmentEvidence !== undefined) {
    try {
      fragmentEvidence = await deps.resolveFragmentEvidence(live, evidenceRequest);
    } catch {
      // The evidence surface is advisory to proof selection, never to merge
      // authority. An unobservable state therefore fails closed to the full gate.
      fragmentEvidence = { kind: "fallback", reason: "manifest_unreadable" };
    }
  }

  const stamp = proofUnitStamp(keyInput, fragmentEvidence);
  let gated: Awaited<ReturnType<GateBatchWorkspace>> | undefined;
  const evaluation = await deps.proofUnits.evaluate({
    orgId: facts.orgId,
    projectId: facts.projectId,
    nodeId: node.nodeId,
    evaluationId: `eval_batch_${randomUUID()}`,
    ...stamp,
    units: [
      {
        // Immutable observation of the selector decision. A failed observation
        // means "use full gate", not "batch failed"; `pre_merge` remains the
        // parent authority and still runs/reuses under its normal exact key.
        key: "fragment_evidence",
        kind: "artifact_provenance",
        subjectId:
          fragmentEvidence.kind === "selected"
            ? "fragment_evidence:selected"
            : `fragment_evidence:fallback:${fragmentEvidence.reason}`,
        inputHash:
          fragmentEvidence.kind === "selected"
            ? fragmentEvidence.inputHash
            : digest(["tanren.fragment-evidence-fallback.v1", proofReuseKey(keyInput), fragmentEvidence.reason]),
        run: async () => ({
          verdict: fragmentEvidence.kind === "selected" ? "pass" : "fail",
          ...(fragmentEvidence.kind === "selected" ? { artifactHash: fragmentEvidence.artifactDigest } : {}),
        }),
      },
      {
        key: "pre_merge",
        kind: "native_ci_tier",
        subjectId: "pre_merge",
        inputHash: batchGateUnitInputHash(keyInput, fragmentEvidence),
        dependsOn: ["fragment_evidence"],
        run: async () => {
          gated = await deps.gate(live);
          if (gated.passed && deps.captureFragmentEvidence !== undefined) {
            try {
              await deps.captureFragmentEvidence(live, evidenceRequest);
            } catch {
              // A capture failure leaves the authoritative native-gate verdict
              // intact and prevents future selector reuse by leaving no artifact.
            }
          }
          return {
            verdict: gated.passed ? "pass" : "fail",
            ...(fragmentEvidence.kind === "selected" ? { artifactHash: fragmentEvidence.artifactDigest } : {}),
          };
        },
      },
    ],
  });
  const proofUnit = evaluation.units.find((unit) => unit.kind === "native_ci_tier" && unit.subjectId === "pre_merge");
  if (proofUnit === undefined) throw new Error("batch gate proof-unit evaluation produced no pre_merge unit");

  // A reused proof-unit means work did not run, so it cannot itself provide native
  // section evidence. It is useful only when the same exact sealed V2 bundle exists.
  // Otherwise rerun the real producer; a legacy proof-unit can never authorize land.
  let gateResult = gated ?? reusedGateResult(proofUnit.verdict, integrated.localRef);
  let bundle =
    gateResult.nativeCi === undefined
      ? await deps.gateBundles.findExact(gateBundleInput(facts, node, integrated, keyInput))
      : undefined;
  if (gateResult.passed && gateResult.nativeCi === undefined && bundle === undefined) {
    gateResult = await deps.gate(live);
  }
  if (gateResult.nativeCi !== undefined) {
    bundle = await deps.gateBundles.seal({
      ...gateBundleInput(facts, node, integrated, keyInput),
      nativeCi: gateResult.nativeCi,
    });
  }
  if (!gateResult.passed) return gateResult.verdict;
  if (bundle === undefined || bundle.gateVerdict !== "passed") {
    return { result: "fail", message: "native gate passed but its exact V2 gate proof bundle is incomplete" };
  }
  return passWithBinding(gateResult.verdict, node, integrated, bundle);
}

function reusedGateResult(
  verdict: "pass" | "fail" | "skipped",
  integrationBranch: string,
): Awaited<ReturnType<GateBatchWorkspace>> {
  if (verdict === "pass") return { verdict: { result: "pass", integrationBranch }, passed: true };
  return {
    verdict: { result: "fail", message: `reused non-passing pre_merge proof unit (${verdict})` },
    passed: false,
  };
}

/** Stamp every persisted proof root with the exact live gate identity. */
function proofUnitStamp(
  keyInput: ProofReuseKeyInput,
  evidence: FragmentEvidenceResolution,
): {
  quarantineEpoch: number;
  toolchainHash: string;
  designContractVersion: string;
  behaviorManifestHash: string;
} {
  return {
    quarantineEpoch: quarantineEpochForVersion(keyInput.quarantineVersion),
    toolchainHash: digest(["tanren.batch-toolchain.v1", keyInput.runnerImage]),
    designContractVersion: keyInput.policyVersion,
    behaviorManifestHash: digest([
      "tanren.batch-behavior-manifest.v1",
      keyInput.gateConfigHash,
      keyInput.appEnvHash,
      keyInput.quarantineVersion,
      evidence.kind === "selected" ? evidence.inputHash : "full_native_pre_merge",
    ]),
  };
}

/** The raw work input still includes the full integrated-content + gate identity. */
function batchGateUnitInputHash(keyInput: ProofReuseKeyInput, evidence: FragmentEvidenceResolution): string {
  return digest([
    "tanren.batch-pre-merge-unit.v1",
    proofReuseKey(keyInput),
    evidence.kind === "selected" ? evidence.inputHash : "full_native_pre_merge",
  ]);
}

/** Active quarantine currently has a content version, so derive its stable integer epoch. */
function quarantineEpochForVersion(version: string): number {
  return createHash("sha256").update(version).digest().readUInt32BE(0) & 0x7fff_ffff;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Add the exact node/proof identity only to a genuinely passing, fully-keyed verdict. */
function passWithBinding(
  verdict: BatchCheckVerdict,
  node: IntegrationNode,
  integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }>,
  bundle: Awaited<ReturnType<GateProofBundleSealer["seal"]>>,
): BatchCheckVerdict {
  if (verdict.result !== "pass" || bundle.gateVerdict !== "passed") return verdict;
  const authorityBinding: BatchAuthorityBinding = {
    nodeId: node.nodeId,
    baseBranch: node.baseBranch,
    baseSha: node.baseSha,
    headSha: integrated.headSha,
    treeHash: integrated.treeHash,
    members: node.members,
    memberSetHash: node.memberKey,
    gateConfigHash: node.gateConfigHash,
    policyVersion: node.policyVersion,
    proof: {
      verdict: "passed",
      gateProofBundleId: bundle.gateProofBundleId,
      proofBundleDigest: bundle.proofBundleDigest,
      proofRoot: bundle.proofRoot,
    },
  };
  return { ...verdict, authorityBinding };
}

function gateBundleInput(
  facts: BatchNodeDriveFacts,
  node: IntegrationNode,
  integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }>,
  keyInput: ProofReuseKeyInput,
) {
  return {
    orgId: facts.orgId,
    projectId: facts.projectId,
    nodeId: node.nodeId,
    baseSha: integrated.baseSha,
    headSha: integrated.headSha,
    treeHash: integrated.treeHash,
    memberSetHash: node.memberKey,
    members: node.members,
    gateConfigHash: keyInput.gateConfigHash,
    policyVersion: keyInput.policyVersion,
  };
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
      : [{ specId: member.specId, runId: member.runId, branch: member.branch, headSha }];
  });
}

function memberKeyForNode(baseSha: string, members: ReadonlyArray<IntegrationNodeMember>): string {
  return memberKey(
    baseSha,
    members.map((member) => member.headSha),
  );
}
