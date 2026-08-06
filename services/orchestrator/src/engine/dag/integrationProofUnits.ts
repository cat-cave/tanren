// MQ-6 proof-unit evaluation: immutable evidence, exact per-unit reuse, and Merkle DAG roots.

import { createHash } from "node:crypto";
import type { EventStore } from "../eventStore.js";
import { proofUnitReuseInputHash } from "../repositories/integrationProofUnits.js";
import type {
  IntegrationProofEdge,
  IntegrationProofUnit,
  IntegrationProofUnitRepository,
  ProofUnitVerdict,
} from "../repositories/integrationProofUnits.js";

export interface ProofUnitWork {
  readonly key: string;
  readonly kind: string;
  readonly subjectId: string;
  /** Digest of every input this precise unit declares it depends on. */
  readonly inputHash: string;
  /** This proof-unit depends on these unit keys; an edge is recorded for each. */
  readonly dependsOn?: readonly string[];
  run(): Promise<{ verdict: ProofUnitVerdict; artifactHash?: string; expiresAt?: Date }>;
}

export interface ProofUnitEvaluationInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly nodeId: string;
  readonly evaluationId: string;
  readonly quarantineEpoch: number;
  readonly toolchainHash: string;
  readonly designContractVersion: string;
  readonly behaviorManifestHash: string;
  /** Eager beams atomically stamp only at their exact ready transition. */
  readonly stampNodeProof?: boolean;
  /** Eager beams publish node-level proof facts only with their ready CAS. */
  readonly publishNodeEvents?: boolean;
  readonly units: readonly ProofUnitWork[];
}

export interface ProofUnitEvaluationResult {
  readonly proofRoot: string;
  readonly units: ReadonlyArray<IntegrationProofUnit & { readonly reused: boolean }>;
}

/**
 * The granular extension to `integrationProofReuse`: only a matching declared unit
 * input, proof stamps, and quarantine epoch can avoid its work closure. All rows
 * remain append-only; a changed identity gets fresh rows and a fresh root.
 */
export class IntegrationProofUnitGraph {
  constructor(
    private readonly repository: IntegrationProofUnitRepository,
    private readonly events: EventStore,
  ) {}

  async evaluate(input: ProofUnitEvaluationInput): Promise<ProofUnitEvaluationResult> {
    const prior = await this.repository.nodeProofState(input);
    if (
      input.publishNodeEvents !== false &&
      prior?.proofRoot !== undefined &&
      (prior.quarantineEpoch !== input.quarantineEpoch ||
        prior.toolchainHash !== input.toolchainHash ||
        prior.designContractVersion !== input.designContractVersion ||
        prior.behaviorManifestHash !== input.behaviorManifestHash)
    ) {
      await this.events.append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "integration.proof.invalidated",
        payload: { reason: "policy_changed", projectId: input.projectId, proofUnitDigest: prior.proofRoot },
      });
    }

    const byKey = new Map<string, IntegrationProofUnit & { reused: boolean }>();
    for (const work of input.units) {
      if (byKey.has(work.key)) throw new Error(`duplicate proof-unit work key: ${work.key}`);
      const reuseIdentity = {
        inputHash: work.inputHash,
        quarantineEpoch: input.quarantineEpoch,
        toolchainHash: input.toolchainHash,
        designContractVersion: input.designContractVersion,
        behaviorManifestHash: input.behaviorManifestHash,
      };
      const reuseInputHash = proofUnitReuseInputHash(reuseIdentity);
      const found = await this.repository.findReusable({
        orgId: input.orgId,
        projectId: input.projectId,
        kind: work.kind,
        subjectId: work.subjectId,
        ...reuseIdentity,
      });
      // A failed observation is immutable evidence but never a shortcut: re-run it to
      // distinguish a deterministic failure from a transient gate fault.
      if (found?.verdict === "pass") {
        const reused = { ...found, reused: true };
        byKey.set(work.key, reused);
        await this.events.append({
          orgId: input.orgId,
          projectId: input.projectId,
          eventType: "integration.proof_unit.reused",
          payload: {
            projectId: input.projectId,
            proofUnitId: found.proofUnitId,
            ...(found.sourceNodeId !== undefined && { sourceNodeId: found.sourceNodeId }),
            inputHash: found.inputHash,
            quarantineEpoch: found.quarantineEpoch,
          },
        });
        continue;
      }
      const result = await work.run();
      const recorded = await this.repository.record({
        orgId: input.orgId,
        projectId: input.projectId,
        kind: work.kind,
        subjectId: work.subjectId,
        inputHash: reuseInputHash,
        verdict: result.verdict,
        ...(result.artifactHash !== undefined && { artifactHash: result.artifactHash }),
        sourceNodeId: input.nodeId,
        quarantineEpoch: input.quarantineEpoch,
        ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt }),
      });
      byKey.set(work.key, { ...recorded, reused: false });
      await this.events.append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "integration.proof_unit.recorded",
        payload: {
          projectId: input.projectId,
          proofUnitId: recorded.proofUnitId,
          kind: recorded.kind,
          subjectId: recorded.subjectId,
          inputHash: recorded.inputHash,
          ...(recorded.artifactHash !== undefined && { artifactHash: recorded.artifactHash }),
          quarantineEpoch: recorded.quarantineEpoch,
        },
      });
    }

    const edges = edgesFor(input.units, byKey);
    const units = [...byKey.values()];
    await this.repository.attachEvaluation({
      orgId: input.orgId,
      projectId: input.projectId,
      evaluationId: input.evaluationId,
      proofUnitIds: units.map((unit) => unit.proofUnitId),
    });
    await this.repository.recordEdges({ orgId: input.orgId, projectId: input.projectId, edges });
    const proofRoot = composeProofRoot(units, edges);
    if (input.stampNodeProof !== false) {
      await this.repository.stampNodeProof({
        orgId: input.orgId,
        projectId: input.projectId,
        nodeId: input.nodeId,
        proofRoot,
        quarantineEpoch: input.quarantineEpoch,
        toolchainHash: input.toolchainHash,
        designContractVersion: input.designContractVersion,
        behaviorManifestHash: input.behaviorManifestHash,
      });
    }
    if (input.publishNodeEvents !== false) {
      await this.events.append({
        orgId: input.orgId,
        projectId: input.projectId,
        eventType: "integration.proof_root.composed",
        payload: {
          projectId: input.projectId,
          integrationNodeId: input.nodeId,
          proofRoot,
          proofUnitIds: units.map((unit) => unit.proofUnitId).sort(),
        },
      });
    }
    return { proofRoot, units };
  }
}

/** Deterministically compose every unit and edge; cycles and dangling edges fail closed. */
export function composeProofRoot(
  units: readonly IntegrationProofUnit[],
  edges: readonly IntegrationProofEdge[],
): string {
  if (units.length === 0) return digest(["tanren.integration-proof-root.v1", []]);
  const byId = new Map(units.map((unit) => [unit.proofUnitId, unit]));
  const children = new Map<string, string[]>();
  const childIds = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.parentUnitId) || !byId.has(edge.childUnitId))
      throw new Error("proof graph edge references a unit outside the evaluation");
    const list = children.get(edge.parentUnitId) ?? [];
    if (!list.includes(edge.childUnitId)) list.push(edge.childUnitId);
    children.set(edge.parentUnitId, list);
    childIds.add(edge.childUnitId);
  }
  const roots = [...byId.keys()].filter((id) => !childIds.has(id)).sort();
  if (roots.length === 0) throw new Error("proof graph has no root (cycle detected)");
  const visiting = new Set<string>();
  const memo = new Map<string, string>();
  const branch = (id: string): string => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error("proof graph contains a cycle");
    visiting.add(id);
    const unit = byId.get(id);
    if (unit === undefined) throw new Error(`missing proof unit ${id}`);
    const value = digest([
      "tanren.integration-proof-unit.v1",
      [unit.kind, unit.subjectId, unit.inputHash, unit.verdict, unit.artifactHash ?? null, unit.quarantineEpoch],
      (children.get(id) ?? []).sort().map((childId) => branch(childId)),
    ]);
    visiting.delete(id);
    memo.set(id, value);
    return value;
  };
  const root = digest(["tanren.integration-proof-root.v1", roots.map((rootId) => branch(rootId))]);
  if (memo.size !== byId.size) throw new Error("proof graph contains a disconnected cycle");
  return root;
}

function edgesFor(
  work: readonly ProofUnitWork[],
  byKey: ReadonlyMap<string, IntegrationProofUnit & { reused: boolean }>,
): IntegrationProofEdge[] {
  const edges: IntegrationProofEdge[] = [];
  for (const unit of work) {
    const parent = byKey.get(unit.key);
    if (parent === undefined) throw new Error(`proof unit ${unit.key} was not evaluated`);
    for (const dependencyKey of unit.dependsOn ?? []) {
      const child = byKey.get(dependencyKey);
      if (child === undefined) throw new Error(`proof unit ${unit.key} depends on unknown ${dependencyKey}`);
      edges.push({ parentUnitId: parent.proofUnitId, childUnitId: child.proofUnitId });
    }
  }
  return edges;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
