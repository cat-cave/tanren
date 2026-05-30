// P2A-0019: Forge write actions. These are the operator-button-driven CTAs
// the hi-fi shows in attention items and prompts (`open new spec`,
// `trigger run`, `rerun task`, `acknowledge insight`). In v0 they are
// invoked by the dashboard on the operator's behalf — there is no LLM
// caller — so authz is the same as the underlying P2A-0013 routes.
//
// The implementations are thin wrappers over the workflow functions; they
// exist as a discrete surface so the future LLM (Phase 3) calls one stable
// shape regardless of whether the underlying engine path moves.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { resolveQueryClient, resolveWritableClient } from "../../data/orgScopedDb.js";
import { BehaviorStore } from "../../entities/behaviors.js";
import { MilestoneStore } from "../../entities/milestones.js";
import {
  createQueuedRunFromSpec,
  createSpec,
  type SpecContract,
  type SpecRunContract,
} from "../../workflow/projectSpec.js";

// RLS R3a: the forge WRITE-tool dispatcher runs inside an ambient
// `runWithOrgScope` (the `/forge/tools` route + the proposal-decide path both
// open one). `createSpec` / `createQueuedRunFromSpec` keep the raw pool — they
// open their OWN org-scoped transaction from the actor's org (R1/cohort-3) — but
// the entity-store links + the rerun lookup route through the ambient scope so
// they carry org context too. With no scope open everything falls back to the
// pool, behavior-identical to before (inert in R1).

interface WriteToolDeps {
  pool: pg.Pool;
}

export class WriteToolAccessDeniedError extends Error {}

// ---------------------------------------------------------------------------
// `tanren.create_spec`
// ---------------------------------------------------------------------------

export interface TanrenCreateSpecArgs {
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  behaviorIds?: string[];
  milestoneId?: string;
}

export async function tanrenCreateSpec(
  deps: WriteToolDeps,
  args: TanrenCreateSpecArgs,
  actor: ActorContext,
): Promise<
  SpecContract & {
    behaviors: ReadonlyArray<{ specId: string; behaviorId: string }>;
    milestoneId?: string;
  }
> {
  const spec = await createSpec(
    deps.pool,
    {
      projectId: args.projectId,
      title: args.title,
      description: args.description,
      // The ForgeAnswer tool args omit acceptanceCriteria intentionally —
      // the LLM is not expected to author criteria. The dashboard's
      // operator-button forms the criteria array; when omitted we use a
      // sensible single-criterion placeholder so the spec is still
      // runnable. Phase 3 will tighten this contract.
      acceptanceCriteria: args.acceptanceCriteria ?? ["Define acceptance criteria"],
    },
    actor,
  );
  const db = resolveWritableClient(deps.pool);
  const behaviorLinks: Array<{ specId: string; behaviorId: string }> = [];
  if (args.behaviorIds !== undefined) {
    for (const behaviorId of args.behaviorIds) {
      await BehaviorStore.linkToSpec(db, { specId: spec.specId, behaviorId }, actor);
      behaviorLinks.push({ specId: spec.specId, behaviorId });
    }
  }
  if (args.milestoneId !== undefined) {
    await MilestoneStore.setSpecMilestone(db, { specId: spec.specId, milestoneId: args.milestoneId }, actor);
  }
  return { ...spec, behaviors: behaviorLinks, milestoneId: args.milestoneId };
}

// ---------------------------------------------------------------------------
// `tanren.trigger_run`
// ---------------------------------------------------------------------------

export async function tanrenTriggerRun(
  deps: WriteToolDeps,
  args: { specId: string; trigger?: string; branch?: string },
  actor: ActorContext,
): Promise<SpecRunContract> {
  return createQueuedRunFromSpec(deps.pool, { specId: args.specId, trigger: args.trigger, branch: args.branch }, actor);
}

// ---------------------------------------------------------------------------
// `tanren.rerun_task` — v0 rerun queues a fresh run for the same spec. The
// "rerun a specific task in-place" semantic is a Phase 3 affordance that
// requires the planner-feedback loop changes from P2A-0012. We surface the
// stable tool shape now so the dashboard can call it; the underlying
// implementation will tighten without changing the tool contract.
// ---------------------------------------------------------------------------

export async function tanrenRerunTask(
  deps: WriteToolDeps,
  args: { taskId: string },
  actor: ActorContext,
): Promise<{ taskId: string; rerunRun: SpecRunContract }> {
  const result = await resolveQueryClient(deps.pool).query<{ spec_id: string }>(
    `SELECT r.spec_id FROM tasks t
     INNER JOIN runs r ON r.run_id = t.run_id
     WHERE t.task_id = $1`,
    [args.taskId],
  );
  const specId = result.rows[0]?.spec_id;
  if (specId === undefined) {
    throw new WriteToolAccessDeniedError(`task not found: ${args.taskId}`);
  }
  const rerunRun = await createQueuedRunFromSpec(deps.pool, { specId, trigger: "api" }, actor);
  return { taskId: args.taskId, rerunRun };
}

// ---------------------------------------------------------------------------
// `tanren.acknowledge_insight` — writes through to the P2A-0020 cache table.
// A second in-memory mirror is kept so dashboards (and the legacy P2A-0019
// tool stub tests) that ack an insight which never made it into the cache
// (e.g. a synthetic insight emitted by the v0 narration generator before
// the route persists it) still see a recorded ack. The DB is the source of
// truth; the mirror is purely a forward-compatible UX nicety.
// ---------------------------------------------------------------------------

import { acknowledgeInsight } from "../../insights/index.js";

const ACKED_INSIGHTS = new Map<string, { acknowledgedBy: string; acknowledgedAt: Date }>();

export async function tanrenAcknowledgeInsight(
  deps: WriteToolDeps,
  args: { insightId: string },
  actor: ActorContext,
): Promise<{
  insightId: string;
  acknowledgedBy: string;
  acknowledgedAt: Date;
  persisted: boolean;
}> {
  const now = new Date();
  const persisted = await acknowledgeInsight(resolveWritableClient(deps.pool), args.insightId, actor.userId, now);
  const entry = { acknowledgedBy: actor.userId, acknowledgedAt: now };
  ACKED_INSIGHTS.set(args.insightId, entry);
  return { insightId: args.insightId, ...entry, persisted };
}

// Test-only escape hatch so callers can inspect the in-memory mirror.
export function peekAcknowledgedInsightForTests(
  insightId: string,
): { acknowledgedBy: string; acknowledgedAt: Date } | undefined {
  return ACKED_INSIGHTS.get(insightId);
}
