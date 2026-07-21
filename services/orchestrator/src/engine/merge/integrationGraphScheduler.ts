// MQ-9's sole batch-candidate selector. It classifies real diffs into conservative
// semantic partitions, then proposes (never claims or lands) a dependency-closed batch.

import { createHash } from "node:crypto";
import { formBatch, type BatchFormation } from "../contracts/batchMergeCoordinator.js";
import {
  INTEGRATION_SCHEDULE_PLAN_VERSION,
  parseIntegrationSchedulePlanV1,
  type IntegrationSchedulePlanV1,
  type SemanticPartitionClass,
} from "../contracts/integrationSchedulePlan.js";
import type { MergeQueueEntry, MergeQueueSnapshot } from "../contracts/mergeCoordinator.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SERIAL_CLASSES = new Set<SemanticPartitionClass>(["all_scopes", "migration", "shared", "api"]);

export interface ScheduleMemberFacts {
  readonly queueId: string;
  readonly runId: string;
  readonly specId: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Undefined, blank, or malformed diff input becomes the all-scopes barrier. */
  readonly diff: unknown;
  /** A current node with this exact base + singleton head identity; never authority. */
  readonly reusableProofNode: boolean;
}

export interface ActivePartitionLeaseFacts {
  readonly partitionId: string;
  readonly leaseOwner: string;
  readonly leaseEpoch: number;
  readonly generation: number;
  readonly fingerprint: string;
}

export type ScheduleFactsResolution =
  | {
      readonly kind: "resolved";
      readonly baseSha: string;
      readonly members: ReadonlyArray<ScheduleMemberFacts>;
      readonly activeLeases: ReadonlyArray<ActivePartitionLeaseFacts>;
    }
  | { readonly kind: "stale"; readonly reason: string };

/** Production facts include current RLS queue rows, CodeHost heads/diffs, leases, and proof nodes. */
export interface IntegrationScheduleFactsResolver {
  resolve(snapshot: MergeQueueSnapshot, candidates: ReadonlyArray<MergeQueueEntry>): Promise<ScheduleFactsResolution>;
}

export interface IntegrationGraphSchedulerDeps {
  readonly facts: IntegrationScheduleFactsResolver;
  readonly resolveMaximumBatchSize: (projectId: string) => Promise<number>;
}

export interface IntegrationScheduleResult {
  readonly formation: BatchFormation;
  readonly plan: IntegrationSchedulePlanV1;
}

interface CanonicalPartition {
  readonly fingerprint: string;
  readonly classes: ReadonlyArray<SemanticPartitionClass>;
  readonly scopes: ReadonlyArray<string>;
  readonly conservative: boolean;
}

/**
 * The active production entrypoint. It returns one proposal for the supplied fresh
 * snapshot; no scheduler path owns a queue lease, invokes a gate, or reaches land.
 */
export class IntegrationGraphScheduler {
  public constructor(private readonly deps: IntegrationGraphSchedulerDeps) {}

  public async schedule(snapshot: MergeQueueSnapshot): Promise<IntegrationScheduleResult> {
    const configuredMaximum = await this.deps.resolveMaximumBatchSize(snapshot.projectId);
    const maximum = policyMaximum(snapshot.entries, configuredMaximum);
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error(`integration scheduler maximum batch size must be a positive integer, got ${maximum}`);
    }
    const allEligible = formBatch(snapshot, Math.max(1, snapshot.entries.length));
    if (allEligible.batch.length === 0) {
      return this.empty(snapshot, maximum, snapshot.mergingInFlight ? "serialized" : "no_eligible_candidate");
    }

    const facts = await this.deps.facts.resolve(snapshot, allEligible.batch);
    if (facts.kind === "stale") return this.empty(snapshot, maximum, facts.reason);
    if (!isFullSha(facts.baseSha) || !sameCandidateFacts(allEligible.batch, facts.members, facts.baseSha)) {
      return this.empty(snapshot, maximum, "stale_or_incomplete_snapshot_facts");
    }
    if (!validLeases(facts.activeLeases)) return this.empty(snapshot, maximum, "ambiguous_partition_lease");

    const byRun = new Map(facts.members.map((member) => [member.runId, member] as const));
    const partitions = new Map<string, CanonicalPartition>();
    for (const entry of allEligible.batch) {
      const member = byRun.get(entry.runId);
      if (member === undefined) return this.empty(snapshot, maximum, "missing_member_facts");
      partitions.set(entry.runId, classifySemanticPartition(member.diff));
    }

    const capacity = dynamicCapacity(maximum, allEligible.batch, facts);
    const selected: MergeQueueEntry[] = [];
    const selectedSpecIds = new Set<string>();
    const selectedPartitions: CanonicalPartition[] = [];
    const blockers: string[] = [];
    for (const entry of allEligible.batch) {
      if (selected.length >= capacity.target) {
        blockers.push(`capacity:${entry.specId}`);
        continue;
      }
      if (
        !entry.dependsOn.every(
          (dependency) => snapshot.mergedSpecIds.has(dependency) || selectedSpecIds.has(dependency),
        )
      ) {
        blockers.push(`dependency:${entry.specId}`);
        continue;
      }
      const partition = partitions.get(entry.runId);
      if (partition === undefined) return this.empty(snapshot, maximum, "missing_canonical_partition");
      if (selectedPartitions.some((selectedPartition) => partitionsConflict(selectedPartition, partition))) {
        blockers.push(`semantic_conflict:${entry.specId}`);
        continue;
      }
      if (facts.activeLeases.some((lease) => partitionsConflict(decodeFingerprint(lease.fingerprint), partition))) {
        blockers.push(`leased_partition:${entry.specId}`);
        continue;
      }
      selected.push(entry);
      selectedSpecIds.add(entry.specId);
      selectedPartitions.push(partition);
    }

    const formation: BatchFormation = {
      batch: selected,
      capped: selected.length < allEligible.eligibleCount,
      eligibleCount: allEligible.eligibleCount,
    };
    const conservativeReason = selectedPartitions.some((partition) => partition.conservative)
      ? "unreadable_or_ambiguous_diff_is_all_scopes"
      : blockers.some((blocker) => blocker.startsWith("leased_partition:"))
        ? "active_partition_lease"
        : undefined;
    return {
      formation,
      plan: planFor(snapshot, facts, partitions, selected, capacity, unique(blockers), conservativeReason),
    };
  }

  private empty(snapshot: MergeQueueSnapshot, maximum: number, reason: string): IntegrationScheduleResult {
    const formation = { batch: [], capped: false, eligibleCount: 0 } satisfies BatchFormation;
    return {
      formation,
      plan: parseIntegrationSchedulePlanV1({
        schemaVersion: INTEGRATION_SCHEDULE_PLAN_VERSION,
        snapshot: { projectId: snapshot.projectId, identity: snapshotIdentity(snapshot), members: [] },
        proposedRunIds: [],
        semanticPartitions: [],
        activeLeases: [],
        dynamicCapacity: {
          minimum: 1,
          maximum,
          selected: 0,
          queueAgeUnits: queueAgeUnits(snapshot.entries),
          availableCapacity: 0,
          reusableProofNodeCount: 0,
        },
        blockers: [reason],
        conservativeReason: reason,
      }),
    };
  }
}

/** Route snapshots may only reduce the governed project maximum, never expand it. */
function policyMaximum(entries: ReadonlyArray<MergeQueueEntry>, configuredMaximum: number): number {
  const routeLimits = entries
    .map((entry) => entry.policyBatchLimit)
    .filter((limit): limit is number => limit !== undefined);
  return routeLimits.length === 0 ? configuredMaximum : Math.min(configuredMaximum, ...routeLimits);
}

/** Deterministic, conservative diff classification. Unknown input is intentionally global. */
export function classifySemanticPartition(diff: unknown): CanonicalPartition {
  const paths = changedPaths(diff);
  if (paths === undefined || paths.length === 0) return allScopes();
  const tokens = new Set<string>();
  for (const path of paths) {
    const classified = classifyPath(path);
    if (classified === undefined) return allScopes();
    for (const token of classified) tokens.add(token);
  }
  if (tokens.size === 0) return allScopes();
  const ordered = [...tokens].sort();
  const classes = classesForScopes(ordered);
  if (classes === undefined) return allScopes();
  return {
    fingerprint: `semantic:v1:${ordered.map((scope) => encodeURIComponent(scope)).join("|")}`,
    classes,
    scopes: ordered,
    conservative: classes.some((value) => SERIAL_CLASSES.has(value)),
  };
}

/** Decode only our exact persisted coordinate; any old/corrupt value becomes global. */
export function decodeFingerprint(fingerprint: unknown): CanonicalPartition {
  if (typeof fingerprint !== "string" || !fingerprint.startsWith("semantic:v1:")) return allScopes();
  const encoded = fingerprint.slice("semantic:v1:".length);
  if (encoded === "all_scopes") return allScopes();
  if (encoded.trim() === "") return allScopes();
  try {
    const scopes = encoded.split("|").map((part) => decodeURIComponent(part));
    const canonicalScopes = unique(scopes).sort();
    if (
      scopes.length === 0 ||
      scopes.some((scope) => !validScope(scope)) ||
      scopes.length !== canonicalScopes.length ||
      !scopes.every((scope, index) => scope === canonicalScopes[index]) ||
      fingerprint !== `semantic:v1:${canonicalScopes.map((scope) => encodeURIComponent(scope)).join("|")}`
    ) {
      return allScopes();
    }
    const classes = classesForScopes(canonicalScopes);
    if (classes === undefined) return allScopes();
    return {
      fingerprint,
      classes,
      scopes: canonicalScopes,
      conservative: classes.some((value) => SERIAL_CLASSES.has(value)),
    };
  } catch {
    return allScopes();
  }
}

/** Two semantic partitions can share a batch only when neither is a serial barrier and scopes differ. */
export function partitionsConflict(left: CanonicalPartition, right: CanonicalPartition): boolean {
  if (left.conservative || right.conservative) return true;
  const rightScopes = new Set(right.scopes);
  return left.scopes.some((scope) => rightScopes.has(scope));
}

export function snapshotIdentity(snapshot: MergeQueueSnapshot): string {
  const value = {
    projectId: snapshot.projectId,
    mergingInFlight: snapshot.mergingInFlight,
    merged: [...snapshot.mergedSpecIds].sort(),
    entries: [...snapshot.entries]
      .sort((left, right) => left.queueId.localeCompare(right.queueId))
      .map((entry) => ({
        queueId: entry.queueId,
        runId: entry.runId,
        specId: entry.specId,
        priority: entry.priority,
        orderKey: entry.orderKey,
        dependsOn: [...entry.dependsOn].sort(),
        partitionId: entry.partitionId ?? null,
        scopeFingerprint: entry.scopeFingerprint ?? null,
        policyBatchLimit: entry.policyBatchLimit ?? null,
      })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function planFor(
  snapshot: MergeQueueSnapshot,
  facts: Extract<ScheduleFactsResolution, { kind: "resolved" }>,
  partitions: ReadonlyMap<string, CanonicalPartition>,
  selected: ReadonlyArray<MergeQueueEntry>,
  capacity: ReturnType<typeof dynamicCapacity>,
  blockers: string[],
  conservativeReason: string | undefined,
): IntegrationSchedulePlanV1 {
  const byRun = new Map(facts.members.map((member) => [member.runId, member] as const));
  const members = [...partitions.keys()]
    .map((runId) => byRun.get(runId))
    .filter((member): member is ScheduleMemberFacts => member !== undefined)
    .sort((left, right) => left.runId.localeCompare(right.runId));
  return parseIntegrationSchedulePlanV1({
    schemaVersion: INTEGRATION_SCHEDULE_PLAN_VERSION,
    snapshot: {
      projectId: snapshot.projectId,
      identity: snapshotIdentity(snapshot),
      members: members.map((member) => ({
        queueId: member.queueId,
        runId: member.runId,
        specId: member.specId,
        baseSha: member.baseSha,
        headSha: member.headSha,
      })),
    },
    proposedRunIds: selected.map((entry) => entry.runId),
    semanticPartitions: members.map((member) => {
      const partition = partitions.get(member.runId);
      if (partition === undefined) throw new Error(`missing partition for ${member.runId}`);
      return {
        queueId: member.queueId,
        runId: member.runId,
        specId: member.specId,
        fingerprint: partition.fingerprint,
        classes: [...partition.classes],
        scopes: [...partition.scopes],
        conservative: partition.conservative,
      };
    }),
    activeLeases: facts.activeLeases.map((lease) => ({ ...lease })),
    dynamicCapacity: {
      minimum: 1,
      maximum: capacity.maximum,
      selected: selected.length,
      queueAgeUnits: capacity.queueAgeUnits,
      availableCapacity: capacity.availableCapacity,
      reusableProofNodeCount: capacity.reusableProofNodeCount,
    },
    blockers,
    ...(conservativeReason === undefined ? {} : { conservativeReason }),
  });
}

function dynamicCapacity(
  maximum: number,
  candidates: ReadonlyArray<MergeQueueEntry>,
  facts: Extract<ScheduleFactsResolution, { kind: "resolved" }>,
) {
  const queueAge = queueAgeUnits(candidates);
  const reusableProofNodeCount = facts.members.filter((member) => member.reusableProofNode).length;
  const availableCapacity = Math.max(0, candidates.length - facts.activeLeases.length);
  // Queue age is an ordinal, not a wall-clock deadline: each additional durable
  // queue position can unlock one more bounded slot, up to project capacity.
  const ageBoost = Math.min(Math.max(0, queueAge - 1), Math.max(0, maximum - 1));
  const proofBoost = reusableProofNodeCount > 0 ? 1 : 0;
  const leaseBound = Math.max(1, availableCapacity);
  return {
    maximum,
    queueAgeUnits: queueAge,
    availableCapacity,
    reusableProofNodeCount,
    target: Math.min(maximum, leaseBound, 1 + ageBoost + proofBoost),
  };
}

function queueAgeUnits(entries: ReadonlyArray<MergeQueueEntry>): number {
  if (entries.length === 0) return 0;
  const orderKeys = entries.map((entry) => entry.orderKey);
  return Math.max(...orderKeys) - Math.min(...orderKeys) + 1;
}

function sameCandidateFacts(
  candidates: ReadonlyArray<MergeQueueEntry>,
  members: ReadonlyArray<ScheduleMemberFacts>,
  baseSha: string,
): boolean {
  if (candidates.length !== members.length) return false;
  const factsByRun = new Map(members.map((member) => [member.runId, member] as const));
  if (factsByRun.size !== candidates.length) return false;
  return candidates.every((entry) => {
    const member = factsByRun.get(entry.runId);
    return (
      member !== undefined &&
      member.queueId === entry.queueId &&
      member.specId === entry.specId &&
      nonBlank(member.branch) &&
      isFullSha(member.baseSha) &&
      member.baseSha === baseSha &&
      isFullSha(member.headSha)
    );
  });
}

function validLeases(leases: ReadonlyArray<ActivePartitionLeaseFacts>): boolean {
  return leases.every(
    (lease) =>
      nonBlank(lease.partitionId) &&
      nonBlank(lease.leaseOwner) &&
      Number.isInteger(lease.leaseEpoch) &&
      lease.leaseEpoch > 0 &&
      Number.isInteger(lease.generation) &&
      lease.generation >= 0 &&
      nonBlank(lease.fingerprint),
  );
}

function changedPaths(diff: unknown): string[] | undefined {
  if (typeof diff !== "string" || diff.trim() === "") return undefined;
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = /^\+\+\+ b\/(.+)$/u.exec(line);
    if (match?.[1] !== undefined) paths.add(match[1]);
  }
  return paths.size === 0 ? undefined : [...paths].sort();
}

function classifyPath(path: string): string[] | undefined {
  if (path.trim() === "" || path.includes("..") || path.startsWith("/")) return undefined;
  if (path.startsWith("db/migrations/")) return ["migration:database"];
  if (path === "db/src/schema.ts" || path.startsWith("db/src/schema")) return ["shared:database_schema"];
  if (
    path.startsWith("services/orchestrator/src/routes/") ||
    path.startsWith("services/dashboard/src/api/") ||
    path.includes("/contracts/") ||
    path.includes("/public-api/")
  ) {
    return ["shared:api_surface"];
  }
  if (path.includes("/api/")) return [`api:${semanticRoot(path)}`];
  if (path.includes("behavior") || path.includes("acceptance")) return [`behavior:${semanticRoot(path)}`];
  if (path.includes("design") || path.includes("render")) return [`design:${semanticRoot(path)}`];
  return [`path:${semanticRoot(path)}`];
}

function semanticRoot(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, Math.min(3, segments.length)).join("/");
}

function allScopes(): CanonicalPartition {
  return {
    fingerprint: "semantic:v1:all_scopes",
    classes: ["all_scopes"],
    scopes: ["all_scopes:repository"],
    conservative: true,
  };
}

function validScope(scope: string): boolean {
  return /^(?:path|api|behavior|design|migration|shared|all_scopes):[A-Za-z0-9._/@-]+$/u.test(scope);
}

function isClass(value: string): value is SemanticPartitionClass {
  return ["path", "api", "behavior", "design", "migration", "shared", "all_scopes"].includes(value);
}

function classesForScopes(scopes: ReadonlyArray<string>): SemanticPartitionClass[] | undefined {
  const classes: SemanticPartitionClass[] = [];
  for (const scope of scopes) {
    const value = scope.slice(0, scope.indexOf(":"));
    if (!isClass(value)) return undefined;
    if (!classes.includes(value)) classes.push(value);
  }
  return classes;
}

function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

function nonBlank(value: string): boolean {
  return value.trim() !== "";
}

function unique<T>(values: ReadonlyArray<T>): T[] {
  return [...new Set(values)];
}
