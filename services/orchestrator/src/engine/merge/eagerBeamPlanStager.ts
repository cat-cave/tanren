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

const PLAN_MEDIA_TYPE = "application/vnd.tanren.eager-beam-plan.v1+json";

export interface StagedEagerBeamPlan {
  readonly plan: EagerBeamPlanV1;
  readonly planDigest: string;
  readonly proofReuseInput: ProofReuseKeyInput;
}

interface StagePlanInput {
  readonly beamWidth: number;
  readonly rank: number;
  readonly orgId: string;
  readonly projectId: string;
  readonly frontierRunId: string;
  readonly frontierSpecId: string;
  readonly facts: ResolvedEagerBeamFacts;
  readonly gateInput: Pick<ResolveGateConfigInput, "target" | "workspacePath">;
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
      frontier: lastMember(input.facts.members),
      proofReuseInput,
    });
    const artifact = await new PgCasByteStore(this.deps.pool).put({
      orgId: input.orgId,
      bytes: new TextEncoder().encode(JSON.stringify(plan)),
      mediaType: PLAN_MEDIA_TYPE,
    });
    return { plan, planDigest: artifact.digest, proofReuseInput };
  }

  public async evaluateMaterialization(input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly nodeId: string;
    readonly staged: StagedEagerBeamPlan;
  }): Promise<void> {
    const proofUnits = new IntegrationProofUnitGraph(
      new PgIntegrationProofUnitRepository(this.deps.pool),
      new PgEventStore(this.deps.pool),
    );
    await proofUnits.evaluate({
      orgId: input.orgId,
      projectId: input.projectId,
      nodeId: input.nodeId,
      evaluationId: `eval_eager_${randomUUID()}`,
      ...proofStamp(input.staged.proofReuseInput),
      units: [
        {
          key: "eager_materialization",
          kind: "eager_materialization",
          subjectId: input.staged.proofReuseInput.memberKey,
          inputHash: digest(["tanren.eager-beam.materialization.v1", input.staged.proofReuseInput]),
          run: async () => ({ verdict: "pass", artifactHash: input.staged.planDigest }),
        },
      ],
    });
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

function proofStamp(key: ProofReuseKeyInput) {
  return {
    quarantineEpoch: createHash("sha256").update(key.quarantineVersion).digest().readUInt32BE(0) & 0x7fff_ffff,
    toolchainHash: digest(["tanren.eager-beam.toolchain.v1", key.runnerImage]),
    designContractVersion: key.policyVersion,
    behaviorManifestHash: digest(["tanren.eager-beam.behavior-manifest.v1", key.gateConfigHash, key.appEnvHash]),
  };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
