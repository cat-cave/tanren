// in-9 + in-10 (fused) — the shared capability-node evaluation core.
//
// A `capability_prepare` node's job is to turn a project's active integration
// REQUIREMENTS into prepared provider bindings. This module is the FAIL-CLOSED
// decision core shared by both halves of the fused node:
//
//   in-9  — enqueue provider preparation work onto the `integration_reconciliations`
//           work queue once a node's dependencies AND its required grant are present.
//   in-10 — resolve `capability_node_dependencies` edges (fail-closed on an
//           unresolved/failed parent) and PARK a node whose grant is absent as
//           `awaiting_grant` (with a `wait_reason`), so a later grant-wake can
//           advance it idempotently.
//
// Every function here runs on an ALREADY org-scoped, in-transaction client so the
// status transition, the reconciliation enqueue, and the lifecycle event all commit
// atomically (the in-4 `DirectIntegrationStateWriter` pattern). Missing-org is a
// LOUD throw upstream; RLS makes an off-scope query see ZERO rows.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { canonicalJson, contentDigestOf, type CanonicalBody } from "../contracts/cas.js";
import { PgEventStore } from "../eventStore.js";

/** Anything that can run a query — a pool or an already-checked-out scoped client. */
export type QueryRunner = Pick<pg.PoolClient, "query">;

/** The capability-node fields the evaluator reasons over (joined with its requirement). */
export interface CapabilityNodeForEval {
  readonly id: string;
  readonly projectId: string;
  readonly requirementId: string;
  readonly environment: string;
  readonly status: string;
  readonly generation: number;
  readonly desiredStateHash: string;
  /** Requirement lineage — the plane/capability/desired-state the grant must satisfy. */
  readonly plane: string;
  readonly capability: string;
  readonly desiredState: unknown;
}

/**
 * The applied outcome of evaluating one node (drives the caller's counters + tests):
 * `enqueued` (deps ready + grant present → work enqueued), `awaiting_grant` (grant
 * absent → parked with a wait_reason), `needs_attention` (a dependency permanently
 * failed → fail-closed), `blocked` (a dependency is not ready yet → stays pending),
 * `unchanged` (already in the computed state → idempotent no-op).
 */
export type CapabilityEvalOutcome = "enqueued" | "awaiting_grant" | "needs_attention" | "blocked" | "unchanged";

const CAPABILITY_PREPARE_PHASE = "discover" as const;

/**
 * Resolve the provider set a requirement's grant may come from: `allowed` (or
 * `preferred` when `allowed` is unset) minus `forbidden`. An empty result means
 * the requirement pins no resolvable provider — the caller fails that node closed.
 */
export function allowedProviders(desiredState: unknown): string[] {
  const policy = readObject(desiredState)?.["providerPolicy"];
  const pol = readObject(policy);
  if (pol === undefined) return [];
  const allowed = readStringArray(pol["allowed"]);
  const preferred = readStringArray(pol["preferred"]);
  const forbidden = new Set(readStringArray(pol["forbidden"]));
  const base = allowed.length > 0 ? allowed : preferred;
  return Array.from(new Set(base.filter((p) => !forbidden.has(p))));
}

/** The desired-state hash for a (requirement, environment) capability node. */
export function capabilityDesiredStateHash(input: {
  requirementId: string;
  environment: string;
  requirementSourceDigest: string;
}): string {
  const body = canonicalJson({
    requirementId: input.requirementId,
    environment: input.environment,
    requirementSourceDigest: input.requirementSourceDigest,
  } as unknown as CanonicalBody);
  return contentDigestOf(new TextEncoder().encode(body));
}

export type DepResolution = "satisfied" | "blocked" | "failed";

/** A dependency resolution plus the number of edges it was computed over (in-10). */
export interface DependencyState {
  readonly resolution: DepResolution;
  /** How many `capability_node_dependencies` edges this node has (0 = no deps). */
  readonly edgeCount: number;
}

/**
 * Resolve a capability node's `capability_node_dependencies` edges (in-10).
 * Fail-closed: a parent in `needs_attention` fails this node; any parent not yet
 * `ready` blocks it; zero edges (the common case) is trivially satisfied. The edge
 * count lets the caller tell a DEP-caused needs_attention (recoverable) apart from a
 * genuine terminal failure (no edges).
 */
export async function resolveDependencies(
  client: QueryRunner,
  orgId: string,
  projectId: string,
  nodeId: string,
): Promise<DependencyState> {
  const result = await client.query<{ parent_status: string }>(
    `SELECT n.status AS parent_status
       FROM capability_node_dependencies d
       JOIN capability_nodes n
         ON n.org_id = d.org_id AND n.project_id = d.project_id
        AND n.id = d.depends_on_capability_node_id
      WHERE d.org_id = $1 AND d.project_id = $2 AND d.capability_node_id = $3`,
    [orgId, projectId, nodeId],
  );
  const edgeCount = result.rows.length;
  if (result.rows.some((r) => r.parent_status === "needs_attention")) return { resolution: "failed", edgeCount };
  if (result.rows.some((r) => r.parent_status !== "ready")) return { resolution: "blocked", edgeCount };
  return { resolution: "satisfied", edgeCount };
}

/** The identity of the covering grant (in-18: carried into the grant-linked wake event). */
export interface GrantCoverageIdentity {
  readonly providerKind: string;
  readonly connectionId: string;
  readonly grantId: string;
}

/**
 * A grant-coverage verdict: satisfied (with the covering grant's identity), or a
 * precise fail-closed reason. The identity lets `evaluateAndApply` emit the durable
 * `integration.grant.linked` wake when a previously-parked node becomes covered
 * (in-18 re-admission trigger) — it never carries a token or secret value.
 */
export type GrantEvaluation =
  | ({ readonly ok: true } & GrantCoverageIdentity)
  | { readonly ok: false; readonly reason: string };

/** grantCovers' internal pass/fail (no identity — evaluateGrant attaches it). */
type CoverageVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface GrantCandidateRow {
  provider_kind: string;
  connection_id: string;
  grant_id: string;
  capabilities: string[];
  operations: string[];
  provider_scopes: string[];
  grant_gen_status: string;
  auth_gen_status: string;
  grant_expired: boolean;
  auth_expired: boolean;
}

/**
 * Does a pinned grant GENUINELY cover this node? (in-9 privilege gate.) The single
 * query resolves each allowed provider's selection → active grant (matching plane +
 * environment) → the EXACT pinned grant + auth generations, and returns their
 * capability/operation/scope arrays, statuses, and (DB-clock) expiry. Coverage is
 * then verified in `grantCovers`: an insufficient, expired, or inactive grant
 * fail-closes with a precise reason (never a loose presence pass). Deterministic
 * (ORDER BY provider): any covering candidate wins; else the first candidate's
 * reason (or `grant_absent` when no candidate exists at all).
 */
export async function evaluateGrant(
  client: QueryRunner,
  orgId: string,
  node: CapabilityNodeForEval,
  providers: readonly string[],
): Promise<GrantEvaluation> {
  if (providers.length === 0) return { ok: false, reason: "no_provider_policy" };
  const ds = readObject(node.desiredState) ?? {};
  const requiredOperations = readStringArray(ds["requiredOperations"]);
  const requiredScopes = readStringArray(ds["requiredScopes"]);
  const result = await client.query<GrantCandidateRow>(
    `SELECT s.provider_kind, s.connection_id, s.grant_id,
            gg.capabilities, gg.operations, gg.provider_scopes,
            gg.status AS grant_gen_status, ag.status AS auth_gen_status,
            (gg.expires_at IS NOT NULL AND gg.expires_at <= now()) AS grant_expired,
            (ag.expires_at IS NOT NULL AND ag.expires_at <= now()) AS auth_expired
       FROM project_integration_grant_selections s
       JOIN org_integration_grants g
         ON g.org_id = s.org_id AND g.provider_kind = s.provider_kind
        AND g.connection_id = s.connection_id AND g.id = s.grant_id
       JOIN org_integration_grant_generations gg
         ON gg.org_id = s.org_id AND gg.provider_kind = s.provider_kind
        AND gg.connection_id = s.connection_id AND gg.grant_id = s.grant_id
        AND gg.generation = s.grant_generation
       JOIN org_integration_connection_auth_generations ag
         ON ag.org_id = s.org_id AND ag.provider_kind = s.provider_kind
        AND ag.connection_id = s.connection_id AND ag.generation = s.auth_generation
      WHERE s.org_id = $1 AND s.project_id = $2
        AND s.provider_kind = ANY($3::text[])
        AND g.status = 'active' AND g.plane = $4 AND g.environment = $5
      ORDER BY s.provider_kind`,
    [orgId, node.projectId, [...providers], node.plane, node.environment],
  );
  if (result.rows.length === 0) return { ok: false, reason: "grant_absent" };
  let firstReason: string | undefined;
  for (const row of result.rows) {
    const verdict = grantCovers(row, node.capability, requiredOperations, requiredScopes);
    if (verdict.ok) {
      return { ok: true, providerKind: row.provider_kind, connectionId: row.connection_id, grantId: row.grant_id };
    }
    firstReason ??= verdict.reason;
  }
  return { ok: false, reason: firstReason ?? "grant_absent" };
}

/** Verify one candidate grant genuinely covers the node — capability, ops, scopes, liveness. */
function grantCovers(
  row: GrantCandidateRow,
  capability: string,
  requiredOperations: readonly string[],
  requiredScopes: readonly string[],
): CoverageVerdict {
  if (row.grant_gen_status !== "active" || row.auth_gen_status !== "active") {
    return { ok: false, reason: "grant_inactive" };
  }
  if (row.grant_expired || row.auth_expired) return { ok: false, reason: "grant_expired" };
  if (!row.capabilities.includes(capability)) return { ok: false, reason: "capability_not_covered" };
  if (!isSubset(requiredOperations, row.operations)) return { ok: false, reason: "insufficient_operations" };
  if (!isSubset(requiredScopes, row.provider_scopes)) return { ok: false, reason: "insufficient_scopes" };
  return { ok: true };
}

/** Every element of `required` is present in `granted`. Empty required ⇒ trivially true. */
function isSubset(required: readonly string[], granted: readonly string[]): boolean {
  const have = new Set(granted);
  return required.every((r) => have.has(r));
}

/**
 * Evaluate ONE non-terminal capability node and apply its transition atomically
 * on the given scoped client. This is the sole state-transition seam for both the
 * in-9 prepare pass and the in-10 grant-wake — so both share one fail-closed
 * decision and one idempotency boundary:
 *
 *   deps failed      → `needs_attention` (fail-closed; wait_reason cleared)
 *   deps not ready   → `pending`         ("blocked"; no queue slot consumed)
 *   grant absent     → `awaiting_grant`  (+ wait_reason; emit grant.requested on
 *                                          the transition INTO awaiting_grant only)
 *   deps+grant ready → `enqueued`        (+ enqueue provider work, ON CONFLICT
 *                                          DO NOTHING so a double-wake is a no-op)
 *
 * A node already in its computed state is left untouched (`unchanged`) — re-running
 * the pass never double-enqueues, double-emits, or double-wakes.
 */
export async function evaluateAndApply(
  client: QueryRunner,
  orgId: string,
  node: CapabilityNodeForEval,
): Promise<CapabilityEvalOutcome> {
  const deps = await resolveDependencies(client, orgId, node.projectId, node.id);
  if (deps.resolution === "failed") {
    return applyStatus(client, orgId, node, "needs_attention", null);
  }
  if (deps.resolution === "blocked") {
    return applyStatus(client, orgId, node, "pending", null);
  }

  // GENUINE-FAILURE GUARD (in-10 finding-2): a node ALREADY in needs_attention with
  // NO dependency edges is a genuine terminal failure (e.g. no provider policy), not a
  // DEP-caused block — never silently recover it. A needs_attention node WITH edges
  // whose deps are now satisfied IS dep-caused and falls through to re-evaluate
  // (parent recovered → child recovers). (A future in-11 provider-failure must record
  // its cause on the reconciliation, not by flipping the capability node here.)
  if (node.status === "needs_attention" && deps.edgeCount === 0) {
    return "unchanged";
  }

  const providers = allowedProviders(node.desiredState);
  if (providers.length === 0) {
    // No resolvable provider — a grant can never be matched; fail closed.
    return applyStatus(client, orgId, node, "needs_attention", null);
  }

  const grant = await evaluateGrant(client, orgId, node, providers);
  if (!grant.ok) {
    // A grant that is absent, expired, inactive, or does NOT genuinely cover this
    // node's capability/operations/scopes fails closed to awaiting_grant with a
    // precise reason — it NEVER enqueues provider work under an insufficient grant.
    const waitReason = `${grant.reason}:${providers.join(",")}:${node.plane}/${node.environment}`;
    const outcome = await applyStatus(client, orgId, node, "awaiting_grant", waitReason);
    if (outcome === "awaiting_grant") {
      // Only fires on the TRANSITION into awaiting_grant (applyStatus returns
      // "unchanged" when it was already parked with the same reason) — so the
      // actionable request is emitted once, not on every re-evaluation.
      await emitGrantRequested(client, orgId, node, providers[0]!);
    }
    return outcome;
  }

  const outcome = await applyStatus(client, orgId, node, "enqueued", null);
  // Enqueue is idempotent on its own (ON CONFLICT DO NOTHING); calling it whenever
  // the node is enqueued keeps a node that reached `enqueued` in a prior crashed
  // pass from being left without its work row.
  await enqueuePrepareWork(client, orgId, node);
  // in-18 RE-ADMISSION TRIGGER: when a PREVIOUSLY-PARKED node (awaiting_grant) becomes
  // covered here — the exact grantCovers moment a grant genuinely arrives — emit the
  // durable `integration.grant.linked` wake. The merge coordinator subscribes to it and
  // re-admits any merge-queue unit parked on this grant. Fires ONLY on the real
  // awaiting_grant→enqueued transition (not on a first-pass pending→enqueued and not on
  // a re-run no-op), so the wake is genuine and single-shot per arrival.
  if (outcome === "enqueued" && node.status === "awaiting_grant") {
    await emitGrantLinked(client, orgId, node, grant);
  }
  return outcome;
}

/** UPDATE the node's status/wait_reason only when it actually changes (idempotent). */
async function applyStatus(
  client: QueryRunner,
  orgId: string,
  node: CapabilityNodeForEval,
  status: string,
  waitReason: string | null,
): Promise<CapabilityEvalOutcome> {
  const result = await client.query(
    `UPDATE capability_nodes
        SET status = $3, wait_reason = $4, updated_at = now()
      WHERE org_id = $1 AND id = $2
        AND (status IS DISTINCT FROM $3 OR wait_reason IS DISTINCT FROM $4)`,
    [orgId, node.id, status, waitReason],
  );
  const changed = (result.rowCount ?? 0) > 0;
  if (!changed) return "unchanged";
  switch (status) {
    case "enqueued":
      return "enqueued";
    case "awaiting_grant":
      return "awaiting_grant";
    case "needs_attention":
      return "needs_attention";
    default:
      return "blocked";
  }
}

/**
 * Enqueue the provider preparation work for a ready capability node onto the
 * `integration_reconciliations` queue (the in-4 `IntegrationStateWriter` claims it
 * from there). Idempotent via the `(org_id, idempotency_key)` unique index — a
 * stable key per (node, generation) means a re-run / double-wake enqueues nothing.
 */
export async function enqueuePrepareWork(
  client: QueryRunner,
  orgId: string,
  node: CapabilityNodeForEval,
): Promise<void> {
  const idempotencyKey = `capprep:${node.id}:${node.generation}`;
  await client.query(
    `INSERT INTO integration_reconciliations
       (org_id, id, project_id, requirement_id, phase, idempotency_key,
        request_fingerprint, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     ON CONFLICT (org_id, idempotency_key) DO NOTHING`,
    [
      orgId,
      `ireconcile_${randomUUID()}`,
      node.projectId,
      node.requirementId,
      CAPABILITY_PREPARE_PHASE,
      idempotencyKey,
      node.desiredStateHash,
    ],
  );
}

/** The actionable `awaiting_grant` request — the frozen in-3 grant vocabulary. */
async function emitGrantRequested(
  client: QueryRunner,
  orgId: string,
  node: CapabilityNodeForEval,
  providerKind: string,
): Promise<void> {
  const ds = readObject(node.desiredState) ?? {};
  await new PgEventStore(client).append({
    orgId,
    projectId: node.projectId,
    eventType: "integration.grant.requested",
    payload: {
      requirementId: node.requirementId,
      providerKind,
      plane: node.plane === "control" ? "control" : "product",
      environment:
        node.environment === "preview" ? "preview" : node.environment === "production" ? "production" : "test",
      capabilities: [node.capability],
      operations: readStringArray(ds["requiredOperations"]).slice(0, 256),
      scopes: readStringArray(ds["requiredScopes"]).slice(0, 256),
    },
  });
}

/**
 * in-18: the durable `integration.grant.linked` wake — emitted when a previously
 * parked (awaiting_grant) capability node becomes covered (grantCovers passed). Carries
 * ONLY the covering grant's identity + plane/environment (never a token). Its append
 * fires the events NOTIFY, which the merge coordinator subscriber consumes to re-admit
 * any merge-queue unit parked on this grant.
 */
async function emitGrantLinked(
  client: QueryRunner,
  orgId: string,
  node: CapabilityNodeForEval,
  grant: GrantCoverageIdentity,
): Promise<void> {
  await new PgEventStore(client).append({
    orgId,
    projectId: node.projectId,
    eventType: "integration.grant.linked",
    payload: {
      grantId: grant.grantId,
      connectionId: grant.connectionId,
      providerKind: grant.providerKind,
      plane: node.plane === "control" ? "control" : "product",
      environment:
        node.environment === "preview" ? "preview" : node.environment === "production" ? "production" : "test",
    },
  });
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
