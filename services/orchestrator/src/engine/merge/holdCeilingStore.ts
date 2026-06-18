// Audit RC-7 (in-memory hold-ceiling durability gap): the DURABLE backing store for
// the two merge runaway-guard counters.
//
// `RecoverableDriveHoldCeiling` (per-entry recoverable-drive attempts) and
// `BatchInfraHoldCeiling` (per-project consecutive infra-holds) used to hold their
// counters in process-local `Map`s. A rolling deploy / crash-loop LOST them, so a
// flapping candidate re-earned its full attempt budget every restart and the loud
// `needs_attention` / terminal-alert escalation never fired. This store persists the
// counters to `merge_queue_holds` (one row per scope+kind) so the ceiling SURVIVES a
// restart. Held candidates are off the hot path, so the extra org-scoped round-trip is
// fine.
//
// no-timeouts reframe: the loud `infra_blocked` alert no longer fires on the COUNT — it
// fires on a PROGRESS signal (the same infra failure SIGNATURE persisting with no recovery,
// the fixed-point read in `infraNonRecovery.ts`). So this store ALSO persists the trailing
// failure-SIGNATURE history (`recordSignature` / `clear`) durably, exactly as it persisted
// the count, so the sustained-non-recovery decision survives a restart. The `attempts` count
// is retained as TELEMETRY ONLY (the emitted diagnostic), never a control-flow trigger.
//
// FAIL-CLOSED: a DB read/write failure PROPAGATES (loud) — it must NEVER silently
// reset the counter to zero, which would defeat the very ceiling it backs and re-grant
// a flapping candidate its full attempt budget. ORG-SCOPED: the row is tenant-scoped,
// so reads/writes run under `runWithOrgScope` (RLS); the org is resolved system-scoped
// from the scope id (a queue_id → merge_queue.org_id, or a project_id → projects.org_id).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { appendInfraSignature } from "./infraNonRecovery.js";

/** Which ceiling a row belongs to (the `merge_queue_holds.kind` discriminant). */
export type HoldCeilingKind = "recoverable_drive" | "batch_infra";

/**
 * The durable per-scope hold counter. `increment` bumps the persisted count by one and
 * returns the NEW value (read-modify-write in one statement); `clear` removes the row
 * (a settled/recovered candidate starts fresh). Both are org-scoped.
 */
export interface HoldCeilingStore {
  /**
   * Atomically increment the TELEMETRY counter for `(scopeId, kind)` and return the new
   * total. The first increment for a fresh scope creates the row at 1. FAIL-CLOSED: a DB
   * failure throws rather than returning a reset-to-one count. The count is observability
   * only (the emitted `attempts` diagnostic) — the alert keys off {@link recordSignature}.
   */
  increment(kind: HoldCeilingKind, scopeId: string): Promise<number>;
  /**
   * Append the infra-failure `signature` to the durable trailing signature history for
   * `(scopeId, kind)` and return the NEW bounded history (oldest→newest). This is the
   * PROGRESS signal the loud alert keys off: the caller feeds the returned history to
   * `isSustainedInfraNonRecovery`. FAIL-CLOSED like `increment`: a DB failure throws
   * (never a silent reset that would forget the non-recovery streak).
   */
  recordSignature(kind: HoldCeilingKind, scopeId: string, signature: string): Promise<string[]>;
  /** Remove the counter + signature history for `(scopeId, kind)` so a recovered candidate starts fresh. */
  clear(kind: HoldCeilingKind, scopeId: string): Promise<void>;
}

/**
 * The in-memory backing store. Used by the in-process fakes + unit tests that do not
 * stand up Postgres. NOTE: this is the NON-DURABLE store — it is the very thing RC-7
 * replaced for the production path; it exists only so the contract has a Pg-free impl.
 */
export class InMemoryHoldCeilingStore implements HoldCeilingStore {
  private readonly counts = new Map<string, number>();
  private readonly signatures = new Map<string, string[]>();

  private key(kind: HoldCeilingKind, scopeId: string): string {
    return `${kind}:${scopeId}`;
  }

  increment(kind: HoldCeilingKind, scopeId: string): Promise<number> {
    const next = (this.counts.get(this.key(kind, scopeId)) ?? 0) + 1;
    this.counts.set(this.key(kind, scopeId), next);
    return Promise.resolve(next);
  }

  recordSignature(kind: HoldCeilingKind, scopeId: string, signature: string): Promise<string[]> {
    const next = appendInfraSignature(this.signatures.get(this.key(kind, scopeId)) ?? [], signature);
    this.signatures.set(this.key(kind, scopeId), next);
    return Promise.resolve(next);
  }

  clear(kind: HoldCeilingKind, scopeId: string): Promise<void> {
    this.counts.delete(this.key(kind, scopeId));
    this.signatures.delete(this.key(kind, scopeId));
    return Promise.resolve();
  }
}

/**
 * The Postgres-backed durable store (org-scoped under RLS, like merge_queue). The org
 * for a scope is resolved system-scoped (the bus/coordinator carry only the scope id);
 * the counter read/write then runs under that org's RLS scope. A scope whose org cannot
 * be resolved (a deleted run/project) throws — fail-closed, never a silent reset.
 */
export class PgHoldCeilingStore implements HoldCeilingStore {
  constructor(private readonly pool: pg.Pool) {}

  async increment(kind: HoldCeilingKind, scopeId: string): Promise<number> {
    const orgId = await this.resolveOrg(kind, scopeId);
    return runWithOrgScope(this.pool, orgId, async (client) => {
      // Single-statement upsert read-modify-write: INSERT at 1, or bump the existing
      // count by one, RETURNING the new total. The (org_id, scope_id, kind) unique
      // index is the conflict target.
      const result = await client.query<{ attempts: string }>(
        `INSERT INTO merge_queue_holds (scope_id, kind, org_id, attempts, last_attempt_at)
           VALUES ($1, $2, $3, '1', now())
         ON CONFLICT (org_id, scope_id, kind)
           DO UPDATE SET attempts = (merge_queue_holds.attempts::bigint + 1)::text,
                         last_attempt_at = now()
         RETURNING attempts`,
        [scopeId, kind, orgId],
      );
      const attempts = result.rows[0]?.attempts;
      if (attempts === undefined) {
        // The upsert must return exactly one row; a missing row is a genuine fault, not
        // a "reset to zero" — surface it loudly (fail-closed).
        throw new Error(`merge_queue_holds upsert returned no row for ${kind}:${scopeId}`);
      }
      return Number(attempts);
    });
  }

  async recordSignature(kind: HoldCeilingKind, scopeId: string, signature: string): Promise<string[]> {
    const orgId = await this.resolveOrg(kind, scopeId);
    return runWithOrgScope(this.pool, orgId, async (client) => {
      // Read-modify-write the bounded signature history in ONE statement: read the prior
      // JSON history (default '[]'), append+clamp in JS, and upsert it back, RETURNING the
      // persisted value so a concurrent writer's row still round-trips. Held candidates are
      // off the hot path, so this extra round-trip is fine.
      const prior = await client.query<{ signatures: string }>(
        "SELECT signatures FROM merge_queue_holds WHERE scope_id = $1 AND kind = $2",
        [scopeId, kind],
      );
      const history = parseSignatures(prior.rows[0]?.signatures, kind, scopeId);
      const next = appendInfraSignature(history, signature);
      const written = await client.query<{ signatures: string }>(
        `INSERT INTO merge_queue_holds (scope_id, kind, org_id, signatures, last_attempt_at)
           VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (org_id, scope_id, kind)
           DO UPDATE SET signatures = $4, last_attempt_at = now()
         RETURNING signatures`,
        [scopeId, kind, orgId, JSON.stringify(next)],
      );
      return parseSignatures(written.rows[0]?.signatures, kind, scopeId);
    });
  }

  async clear(kind: HoldCeilingKind, scopeId: string): Promise<void> {
    // A clear of an unresolvable-org scope is a no-op (the row, if any, is unreachable
    // and a deleted run/project carries no surviving counter): never throw on cleanup.
    const orgId = await this.tryResolveOrg(kind, scopeId);
    if (orgId === null) return;
    await runWithOrgScope(this.pool, orgId, async (client) => {
      await client.query("DELETE FROM merge_queue_holds WHERE scope_id = $1 AND kind = $2", [scopeId, kind]);
    });
  }

  /** Resolve the org for a scope, throwing if it cannot be found (fail-closed for increment). */
  private async resolveOrg(kind: HoldCeilingKind, scopeId: string): Promise<string> {
    const orgId = await this.tryResolveOrg(kind, scopeId);
    if (orgId === null) {
      throw new Error(`merge_queue_holds: cannot resolve org for ${kind} scope ${scopeId}`);
    }
    return orgId;
  }

  /**
   * Resolve the org for a scope, system-scoped: a `recoverable_drive` scope id is a
   * merge_queue.queue_id; a `batch_infra` scope id is a projects.project_id. Returns
   * `null` when the source row is gone (a deleted run/project).
   */
  private async tryResolveOrg(kind: HoldCeilingKind, scopeId: string): Promise<string | null> {
    return runWithSystemScope(this.pool, async (client) => {
      if (kind === "recoverable_drive") {
        const result = await client.query<{ org_id: string }>("SELECT org_id FROM merge_queue WHERE queue_id = $1", [
          scopeId,
        ]);
        return result.rows[0]?.org_id ?? null;
      }
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [scopeId],
      );
      return result.rows[0]?.org_id ?? null;
    });
  }
}

/**
 * Parse the persisted `signatures` JSON into a string history. FAIL-CLOSED: a present-but-
 * unparseable value is a genuine corruption (never a silent reset that would forget the
 * non-recovery streak), so it throws loudly; an absent row is a legitimately-empty history.
 */
function parseSignatures(raw: string | undefined, kind: HoldCeilingKind, scopeId: string): string[] {
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`merge_queue_holds: corrupt signatures JSON for ${kind}:${scopeId}`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((s) => typeof s !== "string")) {
    throw new Error(`merge_queue_holds: signatures for ${kind}:${scopeId} is not a string[]`);
  }
  return parsed as string[];
}
