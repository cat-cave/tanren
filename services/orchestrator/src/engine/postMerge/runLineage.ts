import type pg from "pg";
import { z } from "zod";
import { loadReviewMergeRunContext, type ReviewMergeRunContext } from "../workflow/reviewMerge/context.js";

export type { ReviewMergeRunContext } from "../workflow/reviewMerge/context.js";

type ReadClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface ValidatedRunLineage {
  runId: string;
  specId: string;
  projectId: string;
  orgId: string;
}

export interface ValidatedRunEvent {
  lineage: ValidatedRunLineage;
  payload: unknown;
  prUrl: string | null;
}

export class RunLineageMismatchError extends Error {
  constructor(runId: string, detail: string) {
    super(`run lineage mismatch for '${runId}': ${detail}`);
  }
}

export async function loadValidatedReviewMergeContext(
  client: ReadClient,
  input: { runId: string; lineage: ValidatedRunLineage; resolvedGithubCredentialRef: string },
): Promise<ReviewMergeRunContext> {
  const context = await loadReviewMergeRunContext(client, input.runId, {
    resolvedGithubCredentialRef: input.resolvedGithubCredentialRef,
  });
  if (
    context.orgId !== input.lineage.orgId ||
    context.projectId !== input.lineage.projectId ||
    context.specId !== input.lineage.specId
  ) {
    throw new RunLineageMismatchError(input.runId, "review/merge context disagrees with merge event lineage");
  }
  return context;
}

const RunEventRow = z.object({
  event_run_id: z.string(),
  event_spec_id: z.string().nullable(),
  event_project_id: z.string().nullable(),
  event_org_id: z.string(),
  payload: z.unknown(),
  run_id: z.string().nullable(),
  run_spec_id: z.string().nullable(),
  run_project_id: z.string().nullable(),
  run_org_id: z.string().nullable(),
  pr_url: z.string().nullable(),
  project_org_id: z.string().nullable(),
  spec_org_id: z.string().nullable(),
  spec_project_id: z.string().nullable(),
});

/**
 * Resolve an event and its complete run/spec/project ownership without loading
 * tenant config. The raw joins deliberately do not hide malformed tuples; every
 * coordinate is compared before a downstream authority or secret can be reached.
 */
export async function loadValidatedRunEvent(
  client: ReadClient,
  input: { runId: string; eventType: string; requireEventSpec: boolean },
): Promise<ValidatedRunEvent | undefined> {
  const result = await client.query(
    `SELECT e.run_id AS event_run_id, e.spec_id AS event_spec_id,
            e.project_id AS event_project_id, e.org_id AS event_org_id, e.payload,
            r.run_id, r.spec_id AS run_spec_id, r.project_id AS run_project_id,
            r.org_id AS run_org_id, r.pr_url,
            p.org_id AS project_org_id,
            s.org_id AS spec_org_id, s.project_id AS spec_project_id
       FROM events e
       LEFT JOIN runs r ON r.run_id = e.run_id
       LEFT JOIN projects p ON p.project_id = r.project_id
       LEFT JOIN specs s ON s.spec_id = r.spec_id
      WHERE e.run_id = $1 AND e.event_type = $2
      ORDER BY e.ts DESC, e.id DESC
      LIMIT 1`,
    [input.runId, input.eventType],
  );
  const raw = result.rows[0];
  if (raw === undefined) return undefined;
  const row = RunEventRow.parse(raw);
  if (
    row.run_id === null ||
    row.run_spec_id === null ||
    row.run_project_id === null ||
    row.run_org_id === null ||
    row.project_org_id === null ||
    row.spec_org_id === null ||
    row.spec_project_id === null
  ) {
    throw new RunLineageMismatchError(input.runId, "run, spec, or project owner is missing");
  }
  if (row.event_run_id !== input.runId || row.run_id !== input.runId) {
    throw new RunLineageMismatchError(input.runId, "event and run identities disagree");
  }
  if (row.project_org_id !== row.run_org_id) {
    throw new RunLineageMismatchError(input.runId, "run organization does not own its project");
  }
  if (row.spec_org_id !== row.run_org_id || row.spec_project_id !== row.run_project_id) {
    throw new RunLineageMismatchError(input.runId, "run organization/project does not own its spec");
  }
  if (row.event_org_id !== row.run_org_id || row.event_project_id !== row.run_project_id) {
    throw new RunLineageMismatchError(input.runId, "event organization/project does not match its run");
  }
  if (input.requireEventSpec && row.event_spec_id === null) {
    throw new RunLineageMismatchError(input.runId, `${input.eventType} is missing its spec coordinate`);
  }
  if (row.event_spec_id !== null && row.event_spec_id !== row.run_spec_id) {
    throw new RunLineageMismatchError(input.runId, "event spec does not match its run");
  }
  return {
    lineage: {
      runId: row.run_id,
      specId: row.run_spec_id,
      projectId: row.run_project_id,
      orgId: row.run_org_id,
    },
    payload: row.payload,
    prUrl: row.pr_url,
  };
}
