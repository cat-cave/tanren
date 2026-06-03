// Project-progress read contract + aggregation helper. A single "where is my
// project" surface (apex doctrine: the operator API mirrors the end-user
// dashboard) that folds the three existing read sources — the spec list
// (`projectSpecs.listForProject`), the project run list (`fetchRunListItems`),
// and the project activity feed (`fetchFeedPage`) — into one aggregate, so a
// user (or a driver/monitor) watches a project advance toward v1 in ONE call
// instead of stitching `/specs` + `/runs` + `/feed`.
//
// This module owns NO SQL and opens NO transaction: it is a pure reducer over
// rows the caller already loaded through the org-scoped reads. No new writes,
// no side effects, no secret values — `detail` carries only the non-secret
// reason/message the feed redaction layer already surfaced.

import { z } from "zod";
import type { ProjectSpecRow } from "../../engine/repositories/index.js";
import type { ProjectFeedItem, RunListItem } from "./contract.js";

// ---------------------------------------------------------------------------
// Response contract
// ---------------------------------------------------------------------------

export const ProjectProgressMeta = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    repoUrl: z.string(),
  })
  .strict();
export type ProjectProgressMeta = z.infer<typeof ProjectProgressMeta>;

// Spec rows bucketed by status. `merged` drives v1/percent; `active`/`pending`
// are the in-progress and not-yet-started buckets; `needsAttention` is the
// must-look-at bucket; `other` catches any status not explicitly named so a new
// enum value never silently vanishes from the totals.
export const SpecCounts = z
  .object({
    total: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    needsAttention: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
  })
  .strict();
export type SpecCounts = z.infer<typeof SpecCounts>;

export const InFlightSpec = z
  .object({
    specId: z.string().min(1),
    title: z.string(),
    runStatus: z.string().min(1),
    prUrl: z.string().nullable(),
  })
  .strict();
export type InFlightSpec = z.infer<typeof InFlightSpec>;

export const BlockedSpec = z
  .object({
    specId: z.string().min(1),
    title: z.string(),
    status: z.string().min(1),
  })
  .strict();
export type BlockedSpec = z.infer<typeof BlockedSpec>;

export const ProgressMilestone = z
  .object({
    type: z.string().min(1),
    specId: z.string().nullable(),
    title: z.string().nullable(),
    ts: z.coerce.date(),
    // A short, NON-SECRET summary (a reason/message), never a secret value.
    detail: z.string().nullable(),
  })
  .strict();
export type ProgressMilestone = z.infer<typeof ProgressMilestone>;

export const ProjectProgress = z
  .object({
    project: ProjectProgressMeta,
    // True only when every spec is merged (and at least one spec exists).
    v1Reached: z.boolean(),
    specCounts: SpecCounts,
    // merged / total as a 0..100 integer percentage.
    percentComplete: z.number().int().min(0).max(100),
    inFlight: z.array(InFlightSpec),
    blocked: z.array(BlockedSpec),
    recentMilestones: z.array(ProgressMilestone),
  })
  .strict();
export type ProjectProgress = z.infer<typeof ProjectProgress>;

// ---------------------------------------------------------------------------
// Milestone filter
// ---------------------------------------------------------------------------

// The event types the progress feed surfaces as project milestones — the
// DAG/merge/percolation timeline a user watching their build cares about. The
// raw feed carries every event; we filter to these.
export const MILESTONE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "merge.completed",
  "dag.spec.enqueued",
  "dag.spec.percolating",
  "dag.spec.percolated",
  "merge.blocked",
  "merge.dequeued",
  "merge.conflict",
  "merge.conflict.resolving",
  "merge.conflict.resolved",
  "merge.conflict.irreconcilable",
  "merge.conflict.replan_routed",
  "merge.batch.infra_blocked",
  "merge.queue.infra_blocked",
  "github.pr.created",
  "run.failed",
]);

export const RECENT_MILESTONE_CAP = 20;

// Run statuses that mean a spec is actively progressing (its latest run is live
// or waiting to start) — drives the inFlight list.
const IN_FLIGHT_RUN_STATUSES: ReadonlySet<string> = new Set(["running", "queued"]);

// Spec statuses a user must look at: terminal-but-not-merged / stuck.
const BLOCKED_SPEC_STATUSES: ReadonlySet<string> = new Set(["halted", "cancelled", "needs_attention", "blocked"]);

// Active (in-progress) spec statuses.
const ACTIVE_SPEC_STATUSES: ReadonlySet<string> = new Set(["in_flight", "active", "review"]);

// Not-yet-started spec statuses.
const PENDING_SPEC_STATUSES: ReadonlySet<string> = new Set(["open", "pending"]);

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface BuildProjectProgressInput {
  project: ProjectProgressMeta;
  specs: ReadonlyArray<ProjectSpecRow>;
  // Project run-list items (newest-first), as `fetchRunListItems` returns them.
  runs: ReadonlyArray<RunListItem>;
  // Project activity-feed items (newest-first), as `fetchFeedPage` returns them.
  feed: ReadonlyArray<ProjectFeedItem>;
}

/**
 * Fold the three loaded read surfaces into the `ProjectProgress` aggregate.
 * Pure (no I/O); the caller owns the org-scoped loads.
 */
export function buildProjectProgress(input: BuildProjectProgressInput): ProjectProgress {
  const counts = bucketSpecCounts(input.specs);
  const total = input.specs.length;
  const merged = counts.merged + counts.done;
  const percentComplete = total === 0 ? 0 : Math.round((merged / total) * 100);
  const v1Reached = total > 0 && merged === total;

  return ProjectProgress.parse({
    project: input.project,
    v1Reached,
    specCounts: counts,
    percentComplete,
    inFlight: buildInFlight(input.specs, input.runs),
    blocked: buildBlocked(input.specs),
    recentMilestones: buildMilestones(input.specs, input.feed),
  });
}

function bucketSpecCounts(specs: ReadonlyArray<ProjectSpecRow>): SpecCounts {
  const counts = { total: specs.length, merged: 0, done: 0, active: 0, pending: 0, needsAttention: 0, other: 0 };
  for (const spec of specs) {
    const status = spec.status;
    if (status === "merged") counts.merged += 1;
    else if (status === "done") counts.done += 1;
    else if (ACTIVE_SPEC_STATUSES.has(status)) counts.active += 1;
    else if (PENDING_SPEC_STATUSES.has(status)) counts.pending += 1;
    else if (BLOCKED_SPEC_STATUSES.has(status)) counts.needsAttention += 1;
    else counts.other += 1;
  }
  return counts;
}

// The latest run per spec drives inFlight: runs arrive newest-first, so the
// first run we see for a spec is its latest. A spec is in-flight when that
// latest run is running/queued.
function buildInFlight(specs: ReadonlyArray<ProjectSpecRow>, runs: ReadonlyArray<RunListItem>): InFlightSpec[] {
  const titleBySpec = new Map(specs.map((s) => [s.spec_id, s.title]));
  const seen = new Set<string>();
  const out: InFlightSpec[] = [];
  for (const run of runs) {
    if (seen.has(run.specId)) continue;
    seen.add(run.specId);
    if (!IN_FLIGHT_RUN_STATUSES.has(run.status)) continue;
    out.push({
      specId: run.specId,
      title: titleBySpec.get(run.specId) ?? run.specTitle,
      runStatus: run.status,
      prUrl: run.prUrl,
    });
  }
  return out;
}

function buildBlocked(specs: ReadonlyArray<ProjectSpecRow>): BlockedSpec[] {
  return specs
    .filter((s) => BLOCKED_SPEC_STATUSES.has(s.status))
    .map((s) => ({ specId: s.spec_id, title: s.title, status: s.status }));
}

// Filter the (already-redacted) feed to the milestone event types, newest-first,
// capped. `detail` is the event's non-secret reason/message; the feed redaction
// layer already stripped any sensitive payload field, so we only read the
// known-safe string fields.
function buildMilestones(
  specs: ReadonlyArray<ProjectSpecRow>,
  feed: ReadonlyArray<ProjectFeedItem>,
): ProgressMilestone[] {
  const titleBySpec = new Map(specs.map((s) => [s.spec_id, s.title]));
  const out: ProgressMilestone[] = [];
  for (const item of feed) {
    if (!MILESTONE_EVENT_TYPES.has(item.eventType)) continue;
    const specId = item.specId;
    out.push({
      type: item.eventType,
      specId,
      title: specId === null ? null : (titleBySpec.get(specId) ?? null),
      ts: item.ts,
      detail: milestoneDetail(item),
    });
    if (out.length >= RECENT_MILESTONE_CAP) break;
  }
  return out;
}

// A short, non-secret summary pulled from the (redacted) payload: the
// reason/message a merge/dag event carries. Never a secret — these are the
// human-readable status strings the event schemas define (e.g. dequeue reason,
// conflict message), and redaction has already run.
function milestoneDetail(item: ProjectFeedItem): string | null {
  const payload = item.payload;
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const message = record["message"];
  if (typeof message === "string" && message !== "") return message;
  const reason = record["reason"];
  if (typeof reason === "string" && reason !== "") return reason;
  return null;
}
