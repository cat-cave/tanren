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
// reason/message the feed redaction layer already surfaced, and the live-
// progress signals (`inFlight[].stage` + top-level `lastActivityAt`) are
// derived from event TYPES + timestamps in that same feed — a label and a
// timestamp, never a payload value — so a watcher sees a long single spec move
// through writer→gate→checker→auditor→PR→CI→merge with zero extra queries.

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
    // A coarse, human-readable pipeline stage derived from the run's LATEST
    // event (planning/writing/gating/checking/auditing/opening_pr/ci/merging,
    // or "running" when no stage-bearing event has landed yet). A derived
    // label — never a payload/secret value. This is the "it's alive" signal a
    // watcher needs while a single spec churns for 10–20 minutes without the
    // counts changing.
    stage: z.string().min(1),
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
    // ISO timestamp of the most recent event in the project's feed, or null
    // when the project has no events yet. The "is anything happening" signal:
    // a watcher that sees `lastActivityAt` advancing knows the project is alive
    // even when the spec counts don't move. A timestamp — never a value.
    lastActivityAt: z.string().nullable(),
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
const ACTIVE_SPEC_STATUSES: ReadonlySet<string> = new Set(["in_flight", "review"]);

// Not-yet-started spec statuses.
const PENDING_SPEC_STATUSES: ReadonlySet<string> = new Set(["open"]);

// ---------------------------------------------------------------------------
// Pipeline stage derivation
// ---------------------------------------------------------------------------

// The coarse stage fallback when no stage-bearing event has landed for a run
// yet (the run is queued/just started). Matches the InFlightSpec.runStatus
// vocabulary so a watcher never sees an empty stage.
export const DEFAULT_STAGE = "running";

// Maps an event-type prefix → the coarse human stage. Ordered most-specific
// first so a longer prefix (e.g. `github.pr.`) wins over a shorter sibling. We
// match on prefix because the pipeline emits `<phase>.<verb>` families
// (writer.started, writer.subtask.started, gate.passed, …) and any verb in a
// family maps to the same stage. Only the event TYPE is read — never a payload
// field — so this can never surface a secret.
const STAGE_BY_EVENT_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["planner.", "planning"],
  ["writer.", "writing"],
  ["gate.", "gating"],
  ["checker.", "checking"],
  ["auditor.", "auditing"],
  ["github.pr.", "opening_pr"],
  ["ci.", "ci"],
  ["merge.", "merging"],
];

/**
 * Derive the coarse pipeline stage for a run from its latest stage-bearing
 * event type. Pure: reads only the (already-redacted, newest-first) feed and
 * matches on the event TYPE string. Returns DEFAULT_STAGE ("running") when no
 * event in the feed belongs to the run or none matches a known stage prefix.
 */
export function deriveRunStage(runId: string, feed: ReadonlyArray<ProjectFeedItem>): string {
  // The feed is newest-first, so the first event we see for this run is its
  // latest. The first such event that maps to a known stage wins.
  for (const item of feed) {
    if (item.runId !== runId) continue;
    const stage = stageForEventType(item.eventType);
    if (stage !== undefined) return stage;
  }
  return DEFAULT_STAGE;
}

function stageForEventType(eventType: string): string | undefined {
  for (const [prefix, stage] of STAGE_BY_EVENT_PREFIX) {
    if (eventType.startsWith(prefix)) return stage;
  }
  return undefined;
}

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
  // Spec ids whose latest merge completion signal is a terminal infra halt.
  completionBlockingSpecIds: ReadonlySet<string>;
}

/**
 * Fold the three loaded read surfaces into the `ProjectProgress` aggregate.
 * Pure (no I/O); the caller owns the org-scoped loads.
 */
export function buildProjectProgress(input: BuildProjectProgressInput): ProjectProgress {
  const counts = bucketSpecCounts(input.specs);
  const total = input.specs.length;
  const mergedButBlocked = input.specs.filter(
    (spec) => spec.status === "merged" && input.completionBlockingSpecIds.has(spec.spec_id),
  ).length;
  const effectivelyMerged = Math.max(0, counts.merged - mergedButBlocked);
  const percentComplete = total === 0 ? 0 : Math.round((effectivelyMerged / total) * 100);
  const v1Reached = total > 0 && effectivelyMerged === total;

  return ProjectProgress.parse({
    project: input.project,
    v1Reached,
    specCounts: counts,
    percentComplete,
    inFlight: buildInFlight(input.specs, input.runs, input.feed),
    blocked: buildBlocked(input.specs, input.completionBlockingSpecIds),
    recentMilestones: buildMilestones(input.specs, input.runs, input.feed),
    lastActivityAt: lastActivityAt(input.feed),
  });
}

// The newest event timestamp across the whole project feed (the feed arrives
// newest-first, so it's the head), as an ISO string — or null when the project
// has no events yet. A timestamp only; never a payload value.
function lastActivityAt(feed: ReadonlyArray<ProjectFeedItem>): string | null {
  const newest = feed[0];
  if (newest === undefined) return null;
  return newest.ts.toISOString();
}

function bucketSpecCounts(specs: ReadonlyArray<ProjectSpecRow>): SpecCounts {
  const counts = { total: specs.length, merged: 0, active: 0, pending: 0, needsAttention: 0, other: 0 };
  for (const spec of specs) {
    const status = spec.status;
    if (status === "merged") counts.merged += 1;
    else if (ACTIVE_SPEC_STATUSES.has(status)) counts.active += 1;
    else if (PENDING_SPEC_STATUSES.has(status)) counts.pending += 1;
    else if (BLOCKED_SPEC_STATUSES.has(status)) counts.needsAttention += 1;
    else counts.other += 1;
  }
  return counts;
}

// The latest run per spec drives inFlight: runs arrive newest-first, so the
// first run we see for a spec is its latest. A spec is in-flight when that
// latest run is running/queued. Each item also carries a coarse `stage`
// derived from that run's latest event in the (already-loaded) feed — so a
// watcher sees the run move through writer→gate→checker→auditor→PR→CI→merge
// even while the spec counts hold steady.
function buildInFlight(
  specs: ReadonlyArray<ProjectSpecRow>,
  runs: ReadonlyArray<RunListItem>,
  feed: ReadonlyArray<ProjectFeedItem>,
): InFlightSpec[] {
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
      stage: deriveRunStage(run.runId, feed),
      prUrl: run.prUrl,
    });
  }
  return out;
}

function buildBlocked(
  specs: ReadonlyArray<ProjectSpecRow>,
  completionBlockingSpecIds: ReadonlySet<string>,
): BlockedSpec[] {
  return specs
    .filter((s) => BLOCKED_SPEC_STATUSES.has(s.status) || completionBlockingSpecIds.has(s.spec_id))
    .map((s) => ({
      specId: s.spec_id,
      title: s.title,
      status: completionBlockingSpecIds.has(s.spec_id) ? "completion_blocked" : s.status,
    }));
}

// Filter the (already-redacted) feed to the milestone event types, newest-first,
// capped. `detail` is the event's non-secret reason/message; the feed redaction
// layer already stripped any sensitive payload field, so we only read the
// known-safe string fields.
function buildMilestones(
  specs: ReadonlyArray<ProjectSpecRow>,
  runs: ReadonlyArray<RunListItem>,
  feed: ReadonlyArray<ProjectFeedItem>,
): ProgressMilestone[] {
  const titleBySpec = new Map(specs.map((s) => [s.spec_id, s.title]));
  const specByRun = new Map(runs.map((r) => [r.runId, r.specId]));
  const out: ProgressMilestone[] = [];
  for (const item of feed) {
    if (!MILESTONE_EVENT_TYPES.has(item.eventType)) continue;
    const specId = milestoneSpecId(item, specByRun);
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

function milestoneSpecId(item: ProjectFeedItem, specByRun: ReadonlyMap<string, string>): string | null {
  if (item.eventType === "merge.batch.infra_blocked") {
    return payloadSpecIds(item)[0] ?? item.specId;
  }
  if (item.specId !== null) return item.specId;
  if (item.eventType === "merge.dequeued") {
    return payloadSpecIds(item)[0] ?? specByRun.get(item.runId) ?? null;
  }
  if (!isMergeInfraBlockedEvent(item)) return null;
  return payloadSpecIds(item)[0] ?? null;
}

function isMergeInfraBlockedEvent(item: ProjectFeedItem): boolean {
  return item.eventType === "merge.queue.infra_blocked" || item.eventType === "merge.batch.infra_blocked";
}

function payloadSpecIds(item: ProjectFeedItem): string[] {
  const ids: string[] = [];
  const payload = payloadRecord(item);
  if (payload !== undefined) {
    appendSpecId(ids, payload["specId"]);
    appendMemberSpecIds(ids, payload["members"]);
  }
  return [...new Set(ids)];
}

function appendMemberSpecIds(ids: string[], members: unknown): void {
  if (!Array.isArray(members)) return;
  for (const member of members) {
    if (member === null || typeof member !== "object") continue;
    appendSpecId(ids, (member as Record<string, unknown>)["specId"]);
  }
}

function appendSpecId(ids: string[], value: unknown): void {
  if (typeof value === "string" && value !== "") ids.push(value);
}

function payloadRecord(item: ProjectFeedItem): Record<string, unknown> | undefined {
  const payload = item.payload;
  if (payload === null || typeof payload !== "object") return undefined;
  return payload as Record<string, unknown>;
}

// A short, non-secret summary pulled from the (redacted) payload: the
// reason/message a merge/dag event carries. Never a secret — these are the
// human-readable status strings the event schemas define (e.g. dequeue reason,
// conflict message), and redaction has already run.
function milestoneDetail(item: ProjectFeedItem): string | null {
  const record = payloadRecord(item);
  if (record === undefined) return null;
  const message = record["message"];
  if (typeof message === "string" && message !== "") return message;
  const reason = record["reason"];
  if (typeof reason === "string" && reason !== "") return reason;
  return null;
}
