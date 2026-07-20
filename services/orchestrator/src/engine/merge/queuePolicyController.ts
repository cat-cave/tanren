// The native queue's policy/control seam. It decides only whether a queue row
// may be admitted or remain eligible; it has no MergeAuthority or CodeHost input.
import { randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import { PgEventStore } from "../eventStore.js";
import { QueueCommandV1Schema, QueuePolicyV1Schema, matchesQueueMatcher, type QueueCommandV1 } from "./queuePolicy.js";

type ScopedClient = pg.PoolClient;
type HoldReason =
  | "missing_policy"
  | "malformed_policy"
  | "route_unmatched"
  | "window_closed"
  | "blackout"
  | "partition_not_active"
  | "policy_revised";

interface PolicyRow {
  id: string;
  body: unknown;
  active: boolean;
}

interface QueueRow {
  queue_id: string;
  project_id: string;
  target_branch: string | null;
  policy_snapshot: unknown;
  route_snapshot: unknown;
  priority_snapshot: unknown;
  priority_override: unknown;
  lease_owner: string | null;
  lease_epoch: number;
  partition_state: string | null;
}

export type QueuePolicyDecision =
  | {
      kind: "admit";
      policyId: string;
      route: string;
      priority: string;
      aging: { enabled: boolean; step: number };
      mode: "serial" | "scoped" | "isolated";
      capacity: number;
      batchLimit: number;
      deployGroupLimit: number;
    }
  | { kind: "hold"; reason: HoldReason };

export interface QueuePolicyAdmission {
  kind: "admission";
  orgId: string;
  projectId: string;
  targetBranch: string;
}

export interface QueuePolicyCoordinate {
  kind: "coordinate";
  orgId: string;
  projectId: string;
}

export interface QueuePolicyClaim {
  kind: "claim";
  orgId: string;
  projectId: string;
  queueId: string;
  leaseOwner: string;
  leaseEpoch: number;
}

export interface QueuePolicyCommand {
  kind: "command";
  orgId: string;
  projectId: string;
  actorId: string;
  command: unknown;
}

export type QueuePolicyApplyInput =
  | QueuePolicyAdmission
  | QueuePolicyCoordinate
  | QueuePolicyClaim
  | QueuePolicyCommand;

/** A single production entry point for admission, coordination, HTTP controls, and the final land fence. */
export class QueuePolicyController {
  constructor(private readonly pool: pg.Pool) {}

  async apply(input: QueuePolicyApplyInput): Promise<unknown> {
    if (input.kind === "command") {
      const command = QueueCommandV1Schema.parse(input.command);
      if (command.scope.projectId !== input.projectId || input.actorId.trim() === "") {
        throw new Error("queue command scope or actor is invalid");
      }
      return runWithOrgScope(this.pool, input.orgId, (client) => this.applyCommandOnClient(client, input, command));
    }
    return runWithOrgScope(this.pool, input.orgId, (client) => this.applyOnClient(client, input));
  }

  async applyOnClient(client: ScopedClient, input: QueuePolicyApplyInput): Promise<unknown> {
    switch (input.kind) {
      case "admission":
        return this.admission(client, input);
      case "coordinate":
        return this.coordinate(client, input);
      case "claim":
        return this.claim(client, input);
      case "command": {
        const command = QueueCommandV1Schema.parse(input.command);
        if (command.scope.projectId !== input.projectId || input.actorId.trim() === "") {
          throw new Error("queue command scope or actor is invalid");
        }
        return this.applyCommandOnClient(client, input, command);
      }
    }
    throw new Error("unknown queue policy apply input");
  }

  async applyCommand(input: { orgId: string; projectId: string; actorId: string; command: unknown }): Promise<unknown> {
    return this.apply({ kind: "command", ...input });
  }

  private async applyCommandOnClient(
    client: ScopedClient,
    input: QueuePolicyCommand,
    command: QueueCommandV1,
  ): Promise<unknown> {
    const prior = await client.query<{ result: unknown }>(
      "SELECT result FROM merge_queue_commands WHERE org_id = $1 AND project_id = $2 AND idempotency_key = $3",
      [input.orgId, input.projectId, command.idempotencyKey],
    );
    if (prior.rows[0] !== undefined) {
      if (!validCommandResult(prior.rows[0].result)) throw new Error("stored queue command result is malformed");
      return prior.rows[0].result;
    }
    const policy = await this.activePolicy(client, input.orgId, input.projectId);
    if (policy === undefined) throw new Error("queue commands require an active policy");
    const result = await this.executeCommand(client, input.orgId, input.projectId, command);
    if (!validCommandResult(result)) throw new Error("queue command produced a malformed result");
    const id = `mqc_${randomUUID()}`;
    await client.query(
      `INSERT INTO merge_queue_commands
           (org_id, id, project_id, policy_id, actor_id, command, idempotency_key, scope_target_branch, scope_queue_id, payload, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
      [
        input.orgId,
        id,
        input.projectId,
        policy.id,
        input.actorId,
        command.command,
        command.idempotencyKey,
        command.scope.targetBranch ?? null,
        command.scope.queueId ?? null,
        JSON.stringify(command),
        JSON.stringify(result),
      ],
    );
    await new PgEventStore(client).append({
      orgId: input.orgId,
      projectId: input.projectId,
      eventType: "merge.queue.command_applied",
      payload: { commandId: id, command: command.command, idempotencyKey: command.idempotencyKey, result },
    });
    return result;
  }

  private async admission(client: ScopedClient, input: QueuePolicyAdmission): Promise<QueuePolicyDecision> {
    const policy = await this.activePolicy(client, input.orgId, input.projectId);
    if (policy === undefined) return { kind: "hold", reason: "missing_policy" };
    return this.evaluatePolicy(client, input.orgId, policy, input.projectId, input.targetBranch);
  }

  private async coordinate(client: ScopedClient, input: QueuePolicyCoordinate): Promise<ReadonlySet<string>> {
    const queued = await client.query<QueueRow>(
      `SELECT mq.queue_id, mq.project_id, mq.target_branch, mq.policy_snapshot, mq.route_snapshot, mq.priority_snapshot, mq.priority_override,
              mq.lease_owner, mq.lease_epoch, p.state AS partition_state
         FROM merge_queue mq LEFT JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
        WHERE mq.org_id = $1 AND mq.project_id = $2 AND mq.status = 'queued'`,
      [input.orgId, input.projectId],
    );
    const held = new Set<string>();
    for (const row of queued.rows) {
      const decision = await this.evaluateQueuedRow(client, input.orgId, row, true);
      if (decision.kind === "hold") {
        const updated = await client.query(
          "UPDATE merge_queue SET status = 'held_policy', policy_hold_reason = $2 WHERE org_id = $3 AND queue_id = $1 AND status = 'queued'",
          [row.queue_id, decision.reason, input.orgId],
        );
        if (updated.rowCount === 1) {
          held.add(row.queue_id);
          await this.appendHeld(client, input.orgId, row.project_id, row.queue_id, decision.reason, "coordinate");
        }
      }
    }
    return held;
  }

  private async claim(client: ScopedClient, input: QueuePolicyClaim): Promise<boolean> {
    const result = await client.query<QueueRow>(
      `SELECT mq.queue_id, mq.project_id, mq.target_branch, mq.policy_snapshot, mq.route_snapshot, mq.priority_snapshot, mq.priority_override,
              mq.lease_owner, mq.lease_epoch, p.state AS partition_state
         FROM merge_queue mq LEFT JOIN merge_queue_partitions p ON p.org_id = mq.org_id AND p.id = mq.partition_id
        WHERE mq.org_id = $1 AND mq.project_id = $2 AND mq.queue_id = $3 AND mq.status = 'merging'
          AND mq.lease_owner = $4 AND mq.lease_epoch = $5 FOR UPDATE OF mq`,
      [input.orgId, input.projectId, input.queueId, input.leaseOwner, input.leaseEpoch],
    );
    const row = result.rows[0];
    if (row === undefined) return false;
    const decision = await this.evaluateQueuedRow(client, input.orgId, row, true);
    if (decision.kind === "admit") return true;
    const held = await client.query(
      `UPDATE merge_queue SET status = 'held_policy', policy_hold_reason = $5, claimed_at = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE org_id = $1 AND queue_id = $2 AND status = 'merging' AND lease_owner = $3 AND lease_epoch = $4`,
      [input.orgId, row.queue_id, input.leaseOwner, input.leaseEpoch, decision.reason],
    );
    if (held.rowCount !== 1) return false;
    await this.appendHeld(client, input.orgId, row.project_id, row.queue_id, decision.reason, "claim");
    return false;
  }

  private async evaluateQueuedRow(
    client: ScopedClient,
    orgId: string,
    row: QueueRow,
    requireActive: boolean,
  ): Promise<QueuePolicyDecision> {
    const policySnapshot = policyIdFrom(row.policy_snapshot);
    if (
      policySnapshot === undefined ||
      !validRouteSnapshot(row.route_snapshot) ||
      !validPrioritySnapshot(row.priority_snapshot) ||
      (row.priority_override !== null && !isPriority(row.priority_override))
    ) {
      return { kind: "hold", reason: "malformed_policy" };
    }
    const policy = await this.policyById(client, orgId, policySnapshot);
    if (policy === undefined) return { kind: "hold", reason: "missing_policy" };
    if (requireActive && !policy.active) return { kind: "hold", reason: "policy_revised" };
    if (row.target_branch === null || row.target_branch.trim() === "")
      return { kind: "hold", reason: "malformed_policy" };
    const decision = await this.evaluatePolicy(client, orgId, policy, row.project_id, row.target_branch);
    if (decision.kind === "hold") return decision;
    if (row.partition_state !== "active") return { kind: "hold", reason: "partition_not_active" };
    return decision;
  }

  private async evaluatePolicy(
    client: ScopedClient,
    orgId: string,
    policy: PolicyRow,
    projectId: string,
    targetBranch: string,
  ): Promise<QueuePolicyDecision> {
    const parsed = QueuePolicyV1Schema.safeParse(policy.body);
    if (!parsed.success) return { kind: "hold", reason: "malformed_policy" };
    const windows = await activeWindows(client, orgId, policy.id, projectId, targetBranch);
    if (windows.blackout) return { kind: "hold", reason: "blackout" };
    if (await isInterrupted(client, orgId, policy.id, projectId, targetBranch))
      return { kind: "hold", reason: "partition_not_active" };
    for (const route of parsed.data.routes) {
      if (route.targetBranch !== targetBranch) continue;
      if (!route.requiredWindows.every((window) => windows.allow.has(window))) continue;
      if (!matchesQueueMatcher(route.matcher, { branch: targetBranch, openWindows: windows.allow })) continue;
      return {
        kind: "admit",
        policyId: policy.id,
        route: route.name,
        priority: route.priority.base,
        aging: route.priority.aging,
        mode: route.partition.mode,
        capacity: route.partition.capacity,
        batchLimit: route.partition.batchLimit,
        deployGroupLimit: route.partition.deployGroupLimit,
      };
    }
    return { kind: "hold", reason: windows.allow.size === 0 ? "window_closed" : "route_unmatched" };
  }

  private async activePolicy(client: ScopedClient, orgId: string, projectId: string): Promise<PolicyRow | undefined> {
    const result = await client.query<PolicyRow>(
      "SELECT id, body, active FROM merge_queue_policies WHERE org_id = $1 AND project_id = $2 AND active = true",
      [orgId, projectId],
    );
    return result.rows[0];
  }

  private async policyById(client: ScopedClient, orgId: string, id: string): Promise<PolicyRow | undefined> {
    const result = await client.query<PolicyRow>(
      "SELECT id, body, active FROM merge_queue_policies WHERE org_id = $1 AND id = $2",
      [orgId, id],
    );
    return result.rows[0];
  }

  private async executeCommand(
    client: ScopedClient,
    orgId: string,
    projectId: string,
    command: QueueCommandV1,
  ): Promise<unknown> {
    if (
      command.command === "pause" ||
      command.command === "resume" ||
      command.command === "freeze" ||
      command.command === "unfreeze" ||
      command.command === "drain"
    ) {
      const state =
        command.command === "pause"
          ? "paused"
          : command.command === "freeze"
            ? "frozen"
            : command.command === "drain"
              ? "draining"
              : "active";
      const updated = await client.query(
        `UPDATE merge_queue_partitions SET state = $3, pause_reason = $4, generation = generation + 1
          WHERE org_id = $1 AND project_id = $2 AND ($5::text IS NULL OR target_branch = $5)`,
        [orgId, projectId, state, command.reason, command.scope.targetBranch ?? null],
      );
      return { state, affected: updated.rowCount ?? 0 };
    }
    if (command.scope.queueId === undefined)
      throw new Error(`queue command ${command.command} requires a queueId scope`);
    if (command.command === "dequeue") {
      const updated = await client.query(
        "UPDATE merge_queue SET status = 'dequeued', dequeue_reason = 'blocked', settled_at = now() WHERE org_id = $1 AND project_id = $2 AND queue_id = $3 AND status IN ('queued','held_policy')",
        [orgId, projectId, command.scope.queueId],
      );
      return { state: "dequeued", affected: updated.rowCount ?? 0 };
    }
    if (command.command === "boost" || command.command === "clear-boost") {
      const priority = command.command === "boost" ? command.priority : null;
      const updated = await client.query(
        "UPDATE merge_queue SET priority_override = $4 WHERE org_id = $1 AND project_id = $2 AND queue_id = $3 AND status IN ('queued','held_policy')",
        [orgId, projectId, command.scope.queueId, priority],
      );
      return { state: priority === null ? "boost_cleared" : "boosted", affected: updated.rowCount ?? 0 };
    }
    if (command.command === "queue" || command.command === "requeue" || command.command === "refresh") {
      const queued = await client.query<{ target_branch: string | null }>(
        "SELECT target_branch FROM merge_queue WHERE org_id = $1 AND project_id = $2 AND queue_id = $3 FOR UPDATE",
        [orgId, projectId, command.scope.queueId],
      );
      const targetBranch = queued.rows[0]?.target_branch;
      if (targetBranch === undefined || targetBranch === null || targetBranch.trim() === "") {
        return { state: "held", affected: 0, reason: "malformed_policy" };
      }
      const policy = await this.activePolicy(client, orgId, projectId);
      if (policy === undefined) return { state: "held", affected: 0, reason: "missing_policy" };
      const admission = await this.evaluatePolicy(client, orgId, policy, projectId, targetBranch);
      if (admission.kind === "hold") {
        const held = await client.query(
          "UPDATE merge_queue SET status = 'held_policy', policy_hold_reason = $4 WHERE org_id = $1 AND project_id = $2 AND queue_id = $3 AND status IN ('queued','held_policy')",
          [orgId, projectId, command.scope.queueId, admission.reason],
        );
        return { state: "held", affected: held.rowCount ?? 0, reason: admission.reason };
      }
      const admitted = await client.query(
        `UPDATE merge_queue SET status = 'queued', policy_hold_reason = NULL, policy_snapshot = $4::jsonb,
             route_snapshot = $5::jsonb, priority_snapshot = $6::jsonb
          WHERE org_id = $1 AND project_id = $2 AND queue_id = $3 AND status IN ('queued','held_policy')`,
        [
          orgId,
          projectId,
          command.scope.queueId,
          JSON.stringify({ policyId: admission.policyId, reEvaluationCommand: command.idempotencyKey }),
          JSON.stringify({
            route: admission.route,
            batchLimit: admission.batchLimit,
            deployGroupLimit: admission.deployGroupLimit,
          }),
          JSON.stringify({ priority: admission.priority, aging: admission.aging }),
        ],
      );
      return { state: "queued", affected: admitted.rowCount ?? 0, reEvaluated: true };
    }
    const updated = await client.query(
      "UPDATE merge_queue SET status = 'held_policy', policy_hold_reason = 'refresh_required' WHERE org_id = $1 AND project_id = $2 AND queue_id = $3 AND status IN ('queued','held_policy')",
      [orgId, projectId, command.scope.queueId],
    );
    return { state: "held", affected: updated.rowCount ?? 0, reEvaluationRequired: true };
  }

  private async appendHeld(
    client: ScopedClient,
    orgId: string,
    projectId: string,
    queueId: string,
    reason: HoldReason,
    phase: "coordinate" | "claim",
  ) {
    await new PgEventStore(client).append({
      orgId,
      projectId,
      eventType: "merge.queue.admission_held",
      payload: { queueId, reason, phase },
    });
  }
}

function policyIdFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("policyId" in value)) return undefined;
  const id = Reflect.get(value, "policyId");
  return typeof id === "string" && id.trim() !== "" ? id : undefined;
}

function validRouteSnapshot(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const route = Reflect.get(value, "route");
  const batchLimit = Reflect.get(value, "batchLimit");
  const deployGroupLimit = Reflect.get(value, "deployGroupLimit");
  return (
    typeof route === "string" &&
    route.trim() !== "" &&
    Number.isInteger(batchLimit) &&
    typeof batchLimit === "number" &&
    batchLimit > 0 &&
    Number.isInteger(deployGroupLimit) &&
    typeof deployGroupLimit === "number" &&
    deployGroupLimit > 0
  );
}

function validPrioritySnapshot(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const priority = Reflect.get(value, "priority");
  const aging = Reflect.get(value, "aging");
  return (
    isPriority(priority) &&
    typeof aging === "object" &&
    aging !== null &&
    typeof Reflect.get(aging, "enabled") === "boolean" &&
    typeof Reflect.get(aging, "step") === "number" &&
    Number.isInteger(Reflect.get(aging, "step")) &&
    Reflect.get(aging, "step") > 0
  );
}

function validCommandResult(value: unknown): value is { state: string; affected: number } {
  if (typeof value !== "object" || value === null) return false;
  const state = Reflect.get(value, "state");
  const affected = Reflect.get(value, "affected");
  return (
    typeof state === "string" &&
    state.trim() !== "" &&
    typeof affected === "number" &&
    Number.isInteger(affected) &&
    affected >= 0
  );
}

function isPriority(value: unknown): value is "P0" | "P1" | "P2" | "tbd" {
  return value === "P0" || value === "P1" || value === "P2" || value === "tbd";
}

async function activeWindows(
  client: ScopedClient,
  orgId: string,
  policyId: string,
  projectId: string,
  targetBranch: string,
) {
  const result = await client.query<{ name: string; kind: "allow" | "blackout" }>(
    `SELECT DISTINCT w.name, w.kind
       FROM merge_queue_windows w
       CROSS JOIN LATERAL jsonb_array_elements(w.intervals) interval
      WHERE w.org_id = $1 AND w.policy_id = $2 AND w.project_id = $3 AND (w.target_branch IS NULL OR w.target_branch = $4)
        AND (interval ->> 'startsAt')::timestamptz <= now() AND (interval ->> 'endsAt')::timestamptz > now()`,
    [orgId, policyId, projectId, targetBranch],
  );
  return {
    allow: new Set(result.rows.filter((row) => row.kind === "allow").map((row) => row.name)),
    blackout: result.rows.some((row) => row.kind === "blackout"),
  };
}

async function isInterrupted(
  client: ScopedClient,
  orgId: string,
  policyId: string,
  projectId: string,
  targetBranch: string,
): Promise<boolean> {
  const result = await client.query<{ command: string }>(
    `SELECT command FROM merge_queue_commands
      WHERE org_id = $1 AND policy_id = $2 AND project_id = $3 AND (scope_target_branch IS NULL OR scope_target_branch = $4)
        AND command IN ('pause','resume','freeze','unfreeze','drain')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [orgId, policyId, projectId, targetBranch],
  );
  const command = result.rows[0]?.command;
  return command === "pause" || command === "freeze" || command === "drain";
}
