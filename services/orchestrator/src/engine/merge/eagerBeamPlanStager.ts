import { createHash, randomUUID } from "node:crypto";
import { createEagerBeamPlan, type EagerBeamPlanV1 } from "../contracts/eagerBeamPlan.js";
import type { ProofReuseKeyInput } from "../contracts/integrationNodes.js";
import { resolveLiveKeyComponents } from "../dag/integrationProofKey.js";
import { IntegrationProofUnitGraph } from "../dag/integrationProofUnits.js";
import { PgCasByteStore } from "../cas/pgProofSubstrate.js";
import { PgEventStore } from "../eventStore.js";
import { PgIntegrationProofUnitRepository } from "../repositories/integrationProofUnits.js";
import { resolveGateConfig, type ResolveGateConfigInput } from "../workflow/gate/index.js";
import type { ResolvedEagerBeamFacts } from "./eagerBeamFacts.js";
import type { EagerBeamRuntimeDeps } from "./eagerBeamRuntime.js";
import { loadFragmentEvidenceAuthority } from "./batchFragmentEvidence.js";
import { resolveEagerProofArtifacts, type EagerProofArtifacts } from "./eagerBeamProofArtifacts.js";

const PLAN_MEDIA_TYPE = "application/vnd.tanren.eager-beam-plan.v1+json";

export interface StagedEagerBeamPlan {
  readonly plan: EagerBeamPlanV1;
  readonly planDigest: string;
  readonly proofReuseInput: ProofReuseKeyInput;
  readonly proofArtifacts: EagerProofArtifacts;
}

export type { EagerProofArtifacts } from "./eagerBeamProofArtifacts.js";

interface StagePlanInput {
  readonly beamWidth: number;
  readonly rank: number;
  readonly orgId: string;
  readonly projectId: string;
  readonly frontierRunId: string;
  readonly frontierSpecId: string;
  readonly facts: ResolvedEagerBeamFacts;
  readonly gateInput: Pick<ResolveGateConfigInput, "target" | "workspacePath">;
  /** Exact materialized integration object; proof artifacts cannot read a mutable checkout. */
  readonly integration: { readonly ref: string; readonly headSha: string; readonly treeHash: string };
}

/** Freezes the exact proof coordinate before the integration node can be persisted. */
export class EagerBeamPlanStager {
  public constructor(private readonly deps: Pick<EagerBeamRuntimeDeps, "pool" | "ssh">) {}

  public async stage(input: StagePlanInput): Promise<StagedEagerBeamPlan> {
    const config = await resolveGateConfig({ ssh: this.deps.ssh, ...input.gateInput });
    const components = resolveLiveKeyComponents({
      config,
      runnerImage: input.facts.runnerImage,
      policyVersion: input.facts.policyVersion,
      appEnv: input.facts.appEnv,
      quarantineVersion: input.facts.quarantineVersion,
    });
    const proofReuseInput = exactProofReuseInput(input.facts.memberKey, components);
    const frontier = lastMember(input.facts.members);
    const proofArtifacts = await resolveEagerProofArtifacts({
      pool: this.deps.pool,
      ssh: this.deps.ssh,
      orgId: input.orgId,
      projectId: input.projectId,
      target: input.gateInput.target,
      workspacePath: input.gateInput.workspacePath,
      integration: input.integration,
    });
    const plan = createEagerBeamPlan({
      beamWidth: input.beamWidth,
      rank: input.rank,
      orgId: input.orgId,
      projectId: input.projectId,
      frontierRunId: input.frontierRunId,
      frontierSpecId: input.frontierSpecId,
      baseBranch: input.facts.baseBranch,
      baseSha: input.facts.baseSha,
      ancestorStack: input.facts.members.slice(0, -1),
      frontier,
      proofReuseInput,
      integration: input.integration,
      fragmentEvidenceDigest: proofArtifacts.fragmentEvidenceDigest,
    });
    const artifact = await new PgCasByteStore(this.deps.pool).put({
      orgId: input.orgId,
      bytes: new TextEncoder().encode(JSON.stringify(plan)),
      mediaType: PLAN_MEDIA_TYPE,
    });
    return { plan, planDigest: artifact.digest, proofReuseInput, proofArtifacts };
  }

  public async evaluateMaterialization(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly nodeId: string;
    readonly staged: StagedEagerBeamPlan;
  }) {
    const authority = await loadFragmentEvidenceAuthority(
      this.deps.pool,
      input.orgId,
      input.projectId,
      input.staged.proofArtifacts.fragmentEvidenceManifest,
    );
    if (authority === undefined) throw new Error("eager fragment evidence authority is unavailable");
    const proofUnits = new IntegrationProofUnitGraph(
      new PgIntegrationProofUnitRepository(this.deps.pool),
      new PgEventStore(this.deps.pool),
    );
    const stamp = proofStamp(input.staged.proofReuseInput, input.staged.proofArtifacts);
    const evaluation = await proofUnits.evaluate({
      orgId: input.orgId,
      projectId: input.projectId,
      nodeId: input.nodeId,
      evaluationId: `eval_eager_${randomUUID()}`,
      ...stamp,
      stampNodeProof: false,
      publishNodeEvents: false,
      units: [
        {
          key: "design_contract_binding",
          kind: "eager_design_contract_binding",
          subjectId: input.staged.proofReuseInput.memberKey,
          inputHash: input.staged.proofArtifacts.designContractDigest,
          run: async () => ({ verdict: "pass", artifactHash: input.staged.proofArtifacts.designContractDigest }),
        },
        {
          key: "behavior_manifest_binding",
          kind: "eager_behavior_manifest_binding",
          subjectId: input.staged.proofReuseInput.memberKey,
          inputHash: input.staged.proofArtifacts.behaviorManifestDigest,
          run: async () => ({ verdict: "pass", artifactHash: input.staged.proofArtifacts.behaviorManifestDigest }),
        },
        {
          key: "fragment_evidence_binding",
          kind: "eager_fragment_evidence_binding",
          subjectId: input.staged.proofReuseInput.memberKey,
          inputHash: digest([
            "tanren.eager.fragment-evidence.v1",
            input.staged.proofArtifacts.fragmentEvidenceManifest.fragment,
            authority.casDigest,
          ]),
          run: async () => ({ verdict: "pass", artifactHash: authority.casDigest }),
        },
        {
          key: "materialized_integration_binding",
          kind: "eager_materialized_integration_binding",
          subjectId: input.staged.proofReuseInput.memberKey,
          inputHash: materializedIntegrationDigest(input.staged.plan),
          run: async () => ({ verdict: "pass", artifactHash: materializedIntegrationDigest(input.staged.plan) }),
        },
        {
          key: "proof_reuse_binding",
          kind: "eager_proof_reuse_binding",
          subjectId: input.staged.proofReuseInput.memberKey,
          inputHash: eagerProofReuseDigest(input.staged.proofReuseInput),
          run: async () => ({
            verdict: "pass",
            artifactHash: eagerProofReuseDigest(input.staged.proofReuseInput),
          }),
        },
      ],
    });
    return { ...evaluation, stamp };
  }
}

function exactProofReuseInput(
  memberKey: string,
  components: ReturnType<typeof resolveLiveKeyComponents>,
): ProofReuseKeyInput {
  if (
    !components.gateConfigHash.resolved ||
    !components.policyVersion.resolved ||
    !components.runnerImage.resolved ||
    !components.appEnvHash.resolved ||
    !components.quarantineVersion.resolved
  ) {
    throw new Error("eager proof-reuse identity is unresolved");
  }
  return {
    memberKey,
    gateConfigHash: components.gateConfigHash.value,
    policyVersion: components.policyVersion.value,
    runnerImage: components.runnerImage.value,
    appEnvHash: components.appEnvHash.value,
    quarantineVersion: components.quarantineVersion.value,
  };
}

function lastMember<T>(members: ReadonlyArray<T>): T {
  const member = members.at(-1);
  if (member === undefined) throw new Error("eager beam requires a frontier member");
  return member;
}

function proofStamp(key: ProofReuseKeyInput, artifacts: EagerProofArtifacts) {
  return {
    quarantineEpoch: createHash("sha256").update(key.quarantineVersion).digest().readUInt32BE(0) & 0x7fff_ffff,
    toolchainHash: digest(["tanren.eager-beam.toolchain.v1", key.runnerImage]),
    designContractVersion: artifacts.designContractStamp,
    behaviorManifestHash: artifacts.behaviorManifestDigest,
  };
}

function materializedIntegrationDigest(plan: EagerBeamPlanV1): string {
  return digest(["tanren.eager.materialized-integration.v1", plan.integration, plan.fragmentEvidenceDigest]);
}

/** Complete exact key binding; no policy/config component may be inferred or omitted. */
export function eagerProofReuseDigest(key: ProofReuseKeyInput): string {
  return digest(["tanren.eager.proof-reuse.v1", key]);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
