// The zod row-decoders for `loadSpecWithProject` (projectSpec.ts): tolerant
// transforms for the jsonb `config` blob and the text[] array columns, plus the
// joined spec+project row schema. Extracted to keep projectSpec.ts under its
// max-lines cap; behavior is unchanged (a plain re-home of the schemas).

import { z } from "zod";
import type pg from "pg";
import { migrateProjectConfig } from "../config/index.js";
import { SpecMode, SpecPriority } from "../state/spec.js";
import { ProjectLifecycleEnum } from "../repositories/projects.js";
import { ProjectNotFoundError, SpecNotFoundError } from "./projectSpecErrors.js";
import type { ProjectContract, SpecContract } from "./projectSpec.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** Load `projects.org_id` (NOT NULL); v68 fix. */
export async function loadProjectOrgId(pool: QueryClient, projectId: string): Promise<string> {
  const r = await pool.query<{ org_id: string }>("SELECT org_id FROM projects WHERE project_id = $1", [projectId]);
  const row = r.rows[0];
  if (row === undefined) throw new ProjectNotFoundError(projectId);
  return row.org_id;
}

/** Load the spec + project pair, surfacing the NOT NULL org_id on each (v68 fix). */
export async function loadSpecWithProject(
  pool: QueryClient,
  specId: string,
): Promise<{ project: ProjectContract; spec: SpecContract }> {
  // Codex H3 #7 — the four triage-routing PROVENANCE columns (`parent_spec_id`,
  // `source_finding_ids`, `origin_triage_task_id`, `origin_run_id` — Claude RA2,
  // migration 0025) are SELECT-ed here so every downstream consumer that loads a
  // spec through this seam (run bootstrap, DAG snapshots, dashboard reads) can
  // observe the routing origin. Absent from the previous SELECT, they were
  // write-only outside the dedupe query in `plannerRunTriageNewSpecs.ts`.
  const result = await pool.query(
    `SELECT p.project_id, p.org_id AS project_org_id, p.name, p.repo_url, p.default_branch, p.runner_image,
            p.allocator, p.config, p.lifecycle, s.spec_id, s.org_id AS spec_org_id, s.title, s.description,
            s.acceptance_criteria, s.depends_on, s.status, s.priority, s.mode,
            s.parent_spec_id, s.source_finding_ids, s.origin_triage_task_id, s.origin_run_id, s.origin_issue_loop_id
       FROM specs s JOIN projects p ON p.project_id = s.project_id WHERE s.spec_id = $1`,
    [specId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new SpecNotFoundError(specId);
  const decoded = SpecProjectRowSchema.parse(row);
  return {
    project: {
      projectId: decoded.project_id,
      orgId: decoded.project_org_id,
      name: decoded.name,
      repoUrl: decoded.repo_url,
      defaultBranch: decoded.default_branch,
      runnerImage: decoded.runner_image,
      allocator: decoded.allocator,
      // migrateProjectConfig fails LOUD on missing/unknown `version` — no silent default.
      config: migrateProjectConfig(decoded.config),
      lifecycle: decoded.lifecycle,
    },
    spec: {
      specId: decoded.spec_id,
      projectId: decoded.project_id,
      orgId: decoded.spec_org_id,
      title: decoded.title,
      description: decoded.description,
      acceptanceCriteria: decoded.acceptance_criteria,
      dependsOn: decoded.depends_on,
      status: decoded.status,
      priority: decoded.priority,
      mode: decoded.mode,
      // Codex H3 #7 — decode triage-routing PROVENANCE when the row was routed
      // (parent_spec_id present). A non-routed spec (operator create / discovery
      // accept / seed) has null parent_spec_id and no triageProvenance is set.
      // `source_finding_ids` MAY be null on a legacy row that predates migration
      // 0025 or on a routed row with the array unset — treat as `[]` in that
      // case; the parent trail still identifies the routed spec.
      ...(decoded.parent_spec_id !== null &&
        decoded.parent_spec_id !== undefined && {
          triageProvenance: {
            parentSpecId: decoded.parent_spec_id,
            sourceFindingIds: decoded.source_finding_ids ?? [],
            originTriageTaskId: decoded.origin_triage_task_id ?? "",
            originRunId: decoded.origin_run_id ?? "",
            ...(decoded.origin_issue_loop_id === null || decoded.origin_issue_loop_id === undefined
              ? {}
              : { originIssueLoopId: decoded.origin_issue_loop_id }),
          },
        }),
    },
  };
}

/** A jsonb object column → a record, defaulting non-objects (incl. arrays/null) to `{}`. */
const RecordOrEmpty = z
  .unknown()
  .transform((value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
  );

/** A text[] column → a string[], dropping non-string members and defaulting non-arrays to `[]`. */
const StringArrayOrEmpty = z
  .unknown()
  .transform((value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []));

/**
 * A nullable text[] column → `string[] | null`: null/undefined pass through as
 * `null` (columns like `source_finding_ids` are NULLABLE, and a legacy test
 * fixture may omit the column entirely); a present array is filtered to strings;
 * a non-array is treated as `[]` (defensive — the writer sorts strings only,
 * but a legacy row could carry mixed values). `z.unknown()` treats undefined as
 * a REQUIRED value in strict-parse mode, so `.optional()` is required here
 * to accept the legacy shape.
 */
const NullableStringArray = z
  .unknown()
  .optional()
  .transform((value) =>
    value === null || value === undefined
      ? null
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
  );

/** The joined `specs s JOIN projects p` row `loadSpecWithProject` decodes. */
export const SpecProjectRowSchema = z.object({
  project_id: z.string(),
  // projects.org_id / specs.org_id are both NOT NULL on the table, so a loaded
  // row always carries a real org. Surfaced on the ProjectContract / SpecContract
  // the decoder hands back so downstream tenant writes (event-store append,
  // integration upserts) can stamp the row directly — see {@link ProjectContract.orgId}
  // (v68 fix; the prior eventStore SELECT-join subquery resolved NULL when given
  // no projectId and tripped RLS).
  project_org_id: z.string(),
  spec_org_id: z.string(),
  name: z.string(),
  repo_url: z.string(),
  default_branch: z.string(),
  runner_image: z.string(),
  allocator: z.string(),
  config: RecordOrEmpty,
  lifecycle: ProjectLifecycleEnum,
  spec_id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: StringArrayOrEmpty,
  depends_on: StringArrayOrEmpty,
  status: z.string(),
  priority: SpecPriority,
  // Task #86: the writer-prompt mode the spec was created with. The `specs.mode` column
  // is NOT NULL with default `from_scratch` (migrated in PR #756), so a real row always
  // carries a value.
  mode: SpecMode,
  // Codex H3 #7 — the four triage-routing PROVENANCE columns (Claude RA2, migration
  // 0025). All NULLABLE: a non-routed spec (operator create / discovery accept /
  // seed) has null across the four; a routed spec has parent_spec_id set (the
  // load-side sentinel that promotes the trail to `SpecContract.triageProvenance`).
  // `.nullish()` accepts both null (real DB row) and undefined (a legacy fake test
  // pool that hasn't been updated to seed the new columns) — either shape maps to
  // "no triage provenance" without a hard parse failure.
  parent_spec_id: z.string().nullish(),
  source_finding_ids: NullableStringArray,
  origin_triage_task_id: z.string().nullish(),
  origin_run_id: z.string().nullish(),
  origin_issue_loop_id: z.string().nullish(),
});
