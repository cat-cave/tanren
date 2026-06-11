// Template-creation STEP 3 helper — resolve a CONVERGED template-build project's
// repo + commit + runner image, so the build driver can clone the conforming tree
// at the exact converged commit for validation.
//
// REUSE the same source-of-truth the live benchmark accept seam reads: the
// project row (`repo_url`, `runner_image`) + the latest `merge.completed` event's
// `mergeSha` (the commit the LAST spec landed on `main` — the converged template
// HEAD). Org-scoped (RLS): the read runs under the creating org, so a mis-scoped
// resolution sees zero rows + fails LOUD rather than resolving the wrong tenant's
// repo. A converged project with no recorded merge sha returns `undefined` — the
// build driver turns that into a LOUD `TemplateBuildFailedError` (never validates a
// non-commit).

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ConvergedProjectFacts } from "./liveBuildDriver.js";

// Resolve the converged repo/commit/runner-image for the template-build project,
// org-scoped. Returns `undefined` when the project row is not visible under the org
// OR no merge sha is recorded (the build driver fails loud on `undefined`).
export async function resolveConvergedProjectFacts(
  pool: pg.Pool,
  input: { orgId: string; projectId: string },
): Promise<ConvergedProjectFacts | undefined> {
  return runWithOrgScope(pool, input.orgId, async (client): Promise<ConvergedProjectFacts | undefined> => {
    const projectRow = await client.query<{ repo_url: string; runner_image: string }>(
      "SELECT repo_url, runner_image FROM projects WHERE project_id = $1",
      [input.projectId],
    );
    const project = projectRow.rows[0];
    if (project === undefined || project.repo_url === "") {
      return undefined;
    }
    const sha = await latestMergeSha(client, input.projectId);
    if (sha === undefined) {
      return undefined;
    }
    return { repoRef: project.repo_url, builtSha: sha, runnerImage: project.runner_image };
  });
}

// The most recent merge sha across ALL the project's runs — the converged template
// HEAD (the commit the last spec merged onto the default branch). A run that merged
// via direct_merge emits `merge.completed` with `mergeSha`; an external PR merge
// surfaces `github.pr.merged`. Take the newest event of either kind carrying a sha.
async function latestMergeSha(client: Pick<pg.PoolClient, "query">, projectId: string): Promise<string | undefined> {
  const result = await client.query<{ payload: unknown }>(
    `SELECT payload
       FROM events
      WHERE project_id = $1
        AND event_type IN ('merge.completed', 'github.pr.merged')
      ORDER BY ts DESC, id DESC`,
    [projectId],
  );
  for (const row of result.rows) {
    const sha = mergeShaOf(row.payload);
    if (sha !== undefined) return sha;
  }
  return undefined;
}

function mergeShaOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") return undefined;
  const sha = (payload as Record<string, unknown>)["mergeSha"];
  return typeof sha === "string" && sha !== "" ? sha : undefined;
}
