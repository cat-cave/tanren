// The pg-backed DagLifecycleReadModel (autonomy-engine.md §2c): projects every
// spec's LIFECYCLE STATE from the source-of-truth rows under RLS — the spec's
// status + the terminal lifecycle events of its LATEST run. It duplicates no
// state: the projection is computed fresh each tick from `specs` + `events` +
// `runs`, then the pure `projectSpecLifecycle` core derives the ladder state +
// open-finding max severity + review verdict. The pure core lives in
// `engine/contracts/dagLifecycle.ts`; this module is its single pg wiring.
//
// Scope: like PgDagReadModel, it resolves the project's org (system-scoped
// bootstrap) then reads UNDER THAT ORG SCOPE — an off-scope read sees zero rows
// (RLS denies by default), so the snapshot is always exactly the project's DAG.
//
// Pool/role: the lateral join READS the `events` table. The data plane keeps
// SELECT for org-scoped autonomy projections while event WRITES route through the
// control plane. This read still uses `getSystemPool() ?? this.pool` when a system
// URL is configured, matching the other project-wide worker reads; the query itself
// remains under `runWithOrgScope`, so a bare data-plane read is RLS-filtered rather
// than ACL-denied.

import { getSystemPool, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import {
  type DagLifecycleReadModel,
  type DagLifecycleSnapshot,
  projectSpecLifecycle,
  type SpecLifecycle,
  type SpecLifecycleSignals,
  type SpecReviewState,
} from "../contracts/dagLifecycle.js";
import type { Finding } from "../contracts/findings.js";
import { AuditFinding, normalizeFinding } from "../answerers/schemas/index.js";

/**
 * The synthetic P0 a PRESENT-but-UNREADABLE `auditor.verdict` projects (S3a fail-closed,
 * §4). When an audit event EXISTS but its `findings` column is null / not an array (a
 * malformed/legacy payload), the run is UN-AUDITED, NOT audited-clean — so its open-
 * finding max severity must be the most-severe blocker, never `none`. P0 forces the
 * moderate threshold to treat the ancestor as not-ready and the merge gate to block.
 */
function unreadableAuditFinding(): Finding {
  return {
    id: "audit-findings-unreadable",
    severity: "P0",
    title: "audit findings unreadable",
    body: "An auditor.verdict event exists but its findings are missing/malformed — the run is un-audited (fail-closed P0).",
  };
}

/**
 * Parse the `auditor.verdict` payload's `findings` JSON into typed `Finding`s. S3a: the
 * findings list is the SOLE severity signal an audited verdict carries.
 *   - a well-formed array → those findings (an EMPTY array ⇒ explicitly audited-clean);
 *   - null / not-an-array on a PRESENT verdict → the un-audited P0 ({@link
 *     unreadableAuditFinding}) — NEVER coalesced to clean `[]` (the §4 P1 fail-open);
 *   - a malformed ENTRY throws LOUDLY (`AuditFinding.parse`) — it never silently
 *     degrades to a `none` severity.
 * The invariant: clean `[]` is reachable ONLY from a well-formed, explicitly-empty array.
 * Exported so the fail-closed invariant (unreadable ⇒ P0, never clean) is unit-tested.
 */
export function findingsFromPayload(raw: unknown): ReadonlyArray<Finding> {
  if (!Array.isArray(raw)) {
    // A present audit event with null/non-array findings is unreadable ⇒ fail-closed P0,
    // never clean. (A genuinely audited-clean verdict carries an explicit empty array.)
    return [unreadableAuditFinding()];
  }
  return raw.map((entry) => {
    // `normalizeFinding` collapses a strict-schema `fixHint: null` to an absent
    // key, yielding the frozen `{ fixHint?: string }` Finding contract.
    const finding: Finding = normalizeFinding(AuditFinding.parse(entry));
    return finding;
  });
}

interface SpecLifecycleRow {
  spec_id: string;
  spec_status: string;
  run_id: string | null;
  run_status: string | null;
  pr_opened: boolean;
  ci_passed: boolean;
  // S3: the explicit findings JSON the auditor.verdict carries — the SOLE severity
  // currency. Null when no auditor.verdict event was observed (the run is unaudited).
  audit_findings: unknown;
  // Whether ANY auditor.verdict event exists on the run (so an audited-clean verdict —
  // an empty findings list — is distinguished from a not-yet-audited run).
  audit_present: boolean;
  review_approved: boolean;
  review_changes_requested: boolean;
  review_auto_approved: boolean;
  merge_completed: boolean;
}

/**
 * Resolve the persisted auditor verdict signal from a row into the projection's neutral
 * shape (S3: findings-only). Returns undefined when no `auditor.verdict` event was
 * observed (the `unaudited` severity the moderate threshold treats as not-ready); an
 * observed verdict carries its explicit findings list (empty ⇒ audited-clean `none`).
 */
function auditVerdictFromRow(row: SpecLifecycleRow): SpecLifecycleSignals["auditVerdict"] {
  if (!row.audit_present) {
    return undefined;
  }
  // An observed verdict carries findings: a well-formed (possibly-empty) array stays as
  // is; a null/malformed column yields the un-audited P0 ({@link unreadableAuditFinding})
  // — NEVER a silent clean `[]`. The merge gate's land-time reader applies the SAME rule.
  return { findings: findingsFromPayload(row.audit_findings) };
}

/**
 * Resolve the review channel + verdict from the observed review events. A
 * changes-requested verdict wins over an approval (a later request supersedes an
 * earlier approve in the rework loop — but the projection is event-presence, so we
 * favor the more-actionable changes_requested when both are present). An
 * auto-approval is the `auto` channel; a real GitHub approval is human/simulated —
 * the projection cannot distinguish simulated from human (both post a real review)
 * so it reports `human` (the conservative, review-pending-safe label; the
 * threshold never depends on the channel, only on lifecycle rank).
 */
function reviewFromRow(row: SpecLifecycleRow): SpecReviewState | undefined {
  if (row.review_changes_requested) {
    return { channel: "human", verdict: "changes_requested" };
  }
  if (row.review_auto_approved) {
    return { channel: "auto", verdict: "approved" };
  }
  if (row.review_approved) {
    return { channel: "human", verdict: "approved" };
  }
  return undefined;
}

function lifecycleFromRow(row: SpecLifecycleRow): SpecLifecycle {
  const review = reviewFromRow(row);
  const signals: SpecLifecycleSignals = {
    specId: row.spec_id,
    specStatus: row.spec_status,
    hasRun: row.run_id !== null,
    ...(row.run_status !== null && { runStatus: row.run_status }),
    // `merge.completed` is folded into the persisted `merged` spec status by the
    // merge stage, but we also read the event so a not-yet-flipped status still
    // projects `merged` the instant the merge lands.
    prOpened: row.pr_opened || row.merge_completed,
    ciPassed: row.ci_passed,
    ...(auditVerdictFromRow(row) !== undefined && { auditVerdict: auditVerdictFromRow(row) }),
    ...(review !== undefined && { review }),
  };
  // A landed merge.completed event projects merged even before the status flip.
  if (row.merge_completed) {
    return projectSpecLifecycle({ ...signals, specStatus: "merged" });
  }
  return projectSpecLifecycle(signals);
}

export class PgDagLifecycleReadModel implements DagLifecycleReadModel {
  constructor(private readonly pool: pg.Pool) {}

  async loadLifecycle(projectId: string): Promise<DagLifecycleSnapshot> {
    const orgId = await this.resolveProjectOrg(projectId);
    if (orgId === null) {
      return { projectId, bySpecId: new Map() };
    }
    // The lateral join SELECTs `events`; keep the projection under the resolved
    // project's org scope so tenant policy, not caller discipline, bounds the read.
    const readPool = getSystemPool() ?? this.pool;
    const rows = await runWithOrgScope(readPool, orgId, async (client) => {
      const result = await client.query<SpecLifecycleRow>(
        // For each spec, its LATEST run (by started_at) and the lifecycle-event
        // signals on that run. The lateral join keeps it to one row per spec; the
        // event aggregates are scoped to the latest run's id so a stale earlier
        // run's events never leak into the projection. The auditor verdict reads
        // the MOST RECENT auditor.verdict payload on that run.
        `
        SELECT
          s.spec_id,
          s.status AS spec_status,
          lr.run_id,
          lr.run_status,
          COALESCE(ev.pr_opened, false)            AS pr_opened,
          COALESCE(ev.ci_passed, false)            AS ci_passed,
          (av.run_id IS NOT NULL)                  AS audit_present,
          av.audit_findings,
          COALESCE(ev.review_approved, false)      AS review_approved,
          COALESCE(ev.review_changes_requested, false) AS review_changes_requested,
          COALESCE(ev.review_auto_approved, false) AS review_auto_approved,
          COALESCE(ev.merge_completed, false)      AS merge_completed
        FROM specs s
        LEFT JOIN LATERAL (
          SELECT r.run_id, r.status AS run_status
            FROM runs r
           WHERE r.spec_id = s.spec_id
           ORDER BY r.started_at DESC
           LIMIT 1
        ) lr ON true
        LEFT JOIN LATERAL (
          SELECT
            bool_or(e.event_type = 'github.pr.created')          AS pr_opened,
            -- NATIVE delivery: "CI green" is a PASSING pre-merge native gate verdict
            -- (the merge authority), not a forge check-run poll. A passing gate.verdict
            -- at when='pre_merge' is the ci_green ladder signal.
            bool_or(e.event_type = 'gate.verdict'
                    AND (e.payload ->> 'passed')::boolean
                    AND e.payload ->> 'when' = 'pre_merge')      AS ci_passed,
            bool_or(e.event_type = 'review.approved')            AS review_approved,
            bool_or(e.event_type = 'review.changes_requested')   AS review_changes_requested,
            bool_or(e.event_type = 'review.auto_approved')       AS review_auto_approved,
            bool_or(e.event_type = 'merge.completed')            AS merge_completed
          FROM events e
          WHERE e.run_id = lr.run_id
        ) ev ON true
        LEFT JOIN LATERAL (
          SELECT
            e.run_id,
            -- S3: the explicit findings list is the SOLE severity currency. A non-null
            -- run_id marks that an auditor.verdict event exists so an audited-clean
            -- verdict (empty findings) is distinct from a not-yet-audited run.
            e.payload -> 'findings'                  AS audit_findings
          FROM events e
          WHERE e.run_id = lr.run_id
            AND e.event_type = 'auditor.verdict'
          ORDER BY e.ts DESC
          LIMIT 1
        ) av ON true
        WHERE s.project_id = $1
        `,
        [projectId],
      );
      return result.rows;
    });

    const bySpecId = new Map<string, SpecLifecycle>();
    for (const row of rows) {
      bySpecId.set(row.spec_id, lifecycleFromRow(row));
    }
    return { projectId, bySpecId };
  }

  private async resolveProjectOrg(projectId: string): Promise<string | null> {
    return runWithSystemScope(this.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
  }
}
