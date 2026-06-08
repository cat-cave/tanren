// The pg-backed change-percolation WRITE helpers + jsonb decoders
// (autonomy-engine.md §2c), split from `percolationPg.ts` to keep each file under
// the 500-line cap. These are the SETTLE-phase writes the production settler drives
// plus the decoders the read model uses:
//   - recordVerifiedAncestorSha: advance `verified_ancestor_shas` (the ABSORBED /
//     termination key) for one ancestor after its re-execution re-gated clean, and
//     record the absorbed review verdict (the sticky-changes_requested loop guard).
//   - clearPercolationPending: drop the in-flight marker once a percolation settled.
//   - recordReplanContext: append the upstream change as planner context (intent
//     stays alive) when a re-execution could not reconcile.
//   - decodeVerified / decodePercolationPending: parse the persisted jsonb blobs.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import type { PercolationPending } from "../contracts/changePercolation.js";
import type { ReviewVerdict } from "../contracts/dagLifecycle.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { PgEventStore } from "../eventStore.js";

/**
 * Append `integration.rebase` (tanren-owns-the-engine.md §3/§7 — the never-discard
 * `rebase_vs_rebuild` instrumentation Wave 3 reads). Org-scoped; routes through the
 * control plane when a writer is wired (same plane-split as the percolation events).
 * `sameRunId` is ALWAYS true on this path — the run row survives every base shift.
 */
export async function appendIntegrationRebaseEvent(
  pool: pg.Pool,
  input: {
    projectId: string;
    specId: string;
    runId: string;
    branch: string;
    newBaseSha: string;
    headSha: string;
    rebaseConflicted: boolean;
    decision: "rebased_clean" | "rebased_resolved" | "replanned" | "held";
  },
  runStateWriter?: RunStateWriter,
): Promise<void> {
  const event = {
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    eventType: "integration.rebase" as const,
    payload: {
      specId: input.specId,
      runId: input.runId,
      sameRunId: true,
      branch: input.branch,
      newBaseSha: input.newBaseSha,
      headSha: input.headSha,
      rebaseConflicted: input.rebaseConflicted,
      decision: input.decision,
    },
  };
  const orgId = await resolveProjectOrg(pool, input.projectId);
  if (orgId === null) return;
  if (runStateWriter !== undefined) {
    await runWithJobOrgId(orgId, () => runStateWriter.append(event));
    return;
  }
  await runWithOrgScope(pool, orgId, (client) => new PgEventStore(client).append(event));
}

/** Resolve the project's org id (system-scoped bootstrap, the same hop the walker uses). */
export async function resolveProjectOrg(pool: pg.Pool, projectId: string): Promise<string | null> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.org_id ?? null;
  });
}

/**
 * Resolve a project's org AND its operator lifecycle in one system-scoped read.
 * `archived` is true once the project has been archived through the archive
 * surface — the strand reconciler skips an archived project so it stays dormant.
 */
export async function resolveProjectOrgLifecycle(
  pool: pg.Pool,
  projectId: string,
): Promise<{ orgId: string | null; archived: boolean }> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string | null; lifecycle: string }>(
      "SELECT org_id, lifecycle FROM projects WHERE project_id = $1",
      [projectId],
    );
    const row = result.rows[0];
    return { orgId: row?.org_id ?? null, archived: row?.lifecycle === "archived" };
  });
}

async function orgScopedWrite(
  pool: pg.Pool,
  projectId: string,
  work: (client: pg.PoolClient) => Promise<void>,
): Promise<void> {
  const orgId = await resolveProjectOrg(pool, projectId);
  if (orgId === null) throw new Error(`project ${projectId} has no org for the change-percolation write`);
  await runWithOrgScope(pool, orgId, work);
}

const REVIEW_VERDICTS: ReadonlySet<string> = new Set(["pending", "approved", "changes_requested"]);

/** The decoded `verified_ancestor_shas` blob: the absorbed SHA + verdict per ancestor. */
export interface DecodedVerified {
  /** ancestorSpecId → the re-gated-clean SHA. */
  shas: Record<string, string>;
  /** ancestorSpecId → the absorbed review verdict (the sticky-changes_requested guard). */
  verdicts: Record<string, ReviewVerdict>;
}

/**
 * Decode the `verified_ancestor_shas` jsonb. Each ancestor's value is either a bare
 * SHA string (no absorbed verdict) or `{ sha, reviewVerdict? }`. Returns the SHA map
 * + the absorbed-verdict map the detect uses as the loop guard.
 */
export function decodeVerified(value: unknown): DecodedVerified {
  const shas: Record<string, string> = {};
  const verdicts: Record<string, ReviewVerdict> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { shas, verdicts };
  for (const [ancestorSpecId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      shas[ancestorSpecId] = entry;
      continue;
    }
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
      const obj = entry as { sha?: unknown; reviewVerdict?: unknown };
      if (typeof obj.sha === "string") shas[ancestorSpecId] = obj.sha;
      if (typeof obj.reviewVerdict === "string" && REVIEW_VERDICTS.has(obj.reviewVerdict)) {
        verdicts[ancestorSpecId] = obj.reviewVerdict as ReviewVerdict;
      }
    }
  }
  return { shas, verdicts };
}

/** Decode the `percolation_pending` jsonb into the in-flight marker (or undefined). */
export function decodePercolationPending(value: unknown): PercolationPending | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const ancestorSpecId = obj["ancestorSpecId"];
  const toSha = obj["toSha"];
  const reexecRunId = obj["reexecRunId"];
  if (typeof ancestorSpecId !== "string" || typeof toSha !== "string" || typeof reexecRunId !== "string") {
    return undefined;
  }
  // A marker whose re-execution run id was not yet stamped is incomplete — ignore it
  // (the kick-off stamps it immediately after creating the run).
  if (reexecRunId === "") return undefined;
  const rawVerdict = obj["reviewVerdict"];
  const reviewVerdict =
    typeof rawVerdict === "string" && REVIEW_VERDICTS.has(rawVerdict) ? (rawVerdict as ReviewVerdict) : undefined;
  return {
    ancestorSpecId,
    toSha,
    reexecRunId,
    ...(reviewVerdict !== undefined && { reviewVerdict }),
  };
}

/**
 * Advance `verified_ancestor_shas` for ONE ancestor to the re-gated-clean SHA (the
 * ABSORBED / termination key) and record the absorbed review verdict. Stored as
 * `{ sha, reviewVerdict? }` so the detect's sticky-changes_requested guard reads it.
 * Org-scoped; merges into the existing jsonb so other ancestors' entries survive.
 */
export async function recordVerifiedAncestorSha(
  pool: pg.Pool,
  input: { projectId: string; runId: string; ancestorSpecId: string; sha: string; reviewVerdict?: ReviewVerdict },
  runStateWriter?: RunStateWriter,
): Promise<void> {
  const entry: { sha: string; reviewVerdict?: ReviewVerdict } = {
    sha: input.sha,
    ...(input.reviewVerdict !== undefined && { reviewVerdict: input.reviewVerdict }),
  };
  // Plane-split: route the `verified_ancestor_shas` merge through the control plane
  // when wired (the de-privileged data plane can no longer UPDATE runs); else direct.
  if (runStateWriter !== undefined) {
    const orgId = await resolveProjectOrg(pool, input.projectId);
    if (orgId === null) throw new Error(`project ${input.projectId} has no org for the change-percolation write`);
    await runStateWriter.mergeRunVerifiedAncestorSha({
      runId: input.runId,
      orgId,
      ancestorSpecId: input.ancestorSpecId,
      entryJson: JSON.stringify(entry),
    });
    return;
  }
  await orgScopedWrite(pool, input.projectId, async (client) => {
    await client.query(
      `UPDATE runs
          SET verified_ancestor_shas =
            COALESCE(verified_ancestor_shas, '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
        WHERE run_id = $1`,
      [input.runId, input.ancestorSpecId, JSON.stringify(entry)],
    );
  });
}

/**
 * Stamp the FULL in-flight percolation marker on the dependent's EXISTING run (the
 * never-discard keep-run-row write, tanren-owns-the-engine.md §3): the
 * (ancestorSpecId, toSha, reviewVerdict?, reexecRunId) the SETTLE phase resolves
 * against. For a never-discard rebase the `reexecRunId` IS the dependent's own run id
 * (the SAME row re-gates — no new run), which is what makes the existing settle pass
 * advance `verified_ancestor_shas` against this run. Org-scoped; replaces the marker
 * wholesale (the prior marker, if any, settled before a new shift could mark again).
 *
 * Plane-split: the control-plane writer has no full-marker method yet (only the
 * reexec-id stamp + clear), so this stamps via a direct org-scoped UPDATE. The data
 * plane retains the run-column grant the old reexec-id stamp used. A control-plane
 * full-marker route is a Wave-3 follow-up (the live-jj base-shift path it feeds is
 * itself Wave-3-plumbed).
 */
export async function recordPercolationPending(
  pool: pg.Pool,
  input: {
    projectId: string;
    runId: string;
    ancestorSpecId: string;
    toSha: string;
    reexecRunId: string;
    reviewVerdict?: ReviewVerdict;
  },
): Promise<void> {
  const marker: PercolationPending = {
    ancestorSpecId: input.ancestorSpecId,
    toSha: input.toSha,
    reexecRunId: input.reexecRunId,
    ...(input.reviewVerdict !== undefined && { reviewVerdict: input.reviewVerdict }),
  };
  await orgScopedWrite(pool, input.projectId, async (client) => {
    await client.query("UPDATE runs SET percolation_pending = $2::jsonb WHERE run_id = $1", [
      input.runId,
      JSON.stringify(marker),
    ]);
  });
}

/** Re-point an EXISTING run's dynamic base onto the shifted base (NULL ⇒ non-speculative). */
export async function repointRunSpeculativeBase(
  pool: pg.Pool,
  input: { projectId: string; runId: string; speculativeBase: string | null },
  runStateWriter?: RunStateWriter,
): Promise<void> {
  if (runStateWriter !== undefined) {
    const orgId = await resolveProjectOrg(pool, input.projectId);
    if (orgId === null) throw new Error(`project ${input.projectId} has no org for the base-shift re-point`);
    await runStateWriter.setRunSpeculativeBase({
      runId: input.runId,
      orgId,
      speculativeBase: input.speculativeBase,
    });
    return;
  }
  await orgScopedWrite(pool, input.projectId, async (client) => {
    await client.query("UPDATE runs SET speculative_base = $2 WHERE run_id = $1", [input.runId, input.speculativeBase]);
  });
}

/** Clear the in-flight percolation marker once a percolation settled (absorbed/replan). */
export async function clearPercolationPending(
  pool: pg.Pool,
  input: { projectId: string; runId: string },
  runStateWriter?: RunStateWriter,
): Promise<void> {
  if (runStateWriter !== undefined) {
    const orgId = await resolveProjectOrg(pool, input.projectId);
    if (orgId === null) throw new Error(`project ${input.projectId} has no org for the change-percolation write`);
    await runStateWriter.clearRunPercolationPending({ runId: input.runId, orgId });
    return;
  }
  await orgScopedWrite(pool, input.projectId, async (client) => {
    await client.query("UPDATE runs SET percolation_pending = NULL WHERE run_id = $1", [input.runId]);
  });
}

/**
 * Record the upstream change as planner context (intent stays alive) when a
 * re-execution could not reconcile. The re-execution already routed the dependent
 * back through the planner/resolver; this is the durable, inspectable carrier of WHY
 * (the "merge.conflict.replan_routed" event, reused). It does NOT drop the spec.
 */
export async function recordReplanContext(
  pool: pg.Pool,
  input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    ancestorSha: string;
    reason: string;
  },
  runStateWriter?: RunStateWriter,
): Promise<void> {
  const event = {
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    eventType: "merge.conflict.replan_routed" as const,
    payload: {
      specId: input.specId,
      otherSpecId: input.ancestorSpecId,
      newContext: `Percolation: re-plan ON TOP OF the upstream change from ${input.ancestorSpecId} (${input.ancestorSha}). ${input.reason}`,
      replanStatus: "pending" as const,
    },
  };
  // Plane-split: append the replan-context event through the control plane when
  // wired (the writer resolves the run's org from the ambient per-job org id, so set
  // it for the append); else append in-process under a short org scope.
  if (runStateWriter !== undefined) {
    const orgId = await resolveProjectOrg(pool, input.projectId);
    if (orgId === null) throw new Error(`project ${input.projectId} has no org for the change-percolation write`);
    await runWithJobOrgId(orgId, () => runStateWriter.append(event));
    return;
  }
  await orgScopedWrite(pool, input.projectId, async (client) => {
    await new PgEventStore(client).append(event);
  });
}
