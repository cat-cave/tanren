import type pg from "pg";
import { z } from "zod";
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
import { resolveAncestorStack } from "../dag/ancestorStack.js";
import { readGithubCredentialRef, readGithubInstallation } from "./githubDraftPrHelpers.js";

export type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

const DraftPrRunRow = z.object({
  run_id: z.string(),
  spec_id: z.string(),
  project_id: z.string(),
  org_id: z.string(),
  branch: z.string(),
  ancestor_stack: z.unknown().nullable(),
  repo_url: z.string(),
  default_branch: z.string(),
  config: z.unknown().nullable(),
  org_config: z.unknown().nullable(),
  spec_title: z.string(),
  spec_description: z.string(),
  ssh_host: z.string().nullable(),
  ssh_port: z.number().nullable(),
  host_key_fingerprint: z.string().nullable(),
});

export interface DraftPrRunContext {
  runId: string;
  specId: string;
  projectId: string;
  orgId: string;
  branch: string;
  ancestorStack?: AncestorStack;
  repoUrl: string;
  defaultBranch: string;
  configuredGithubCredentialRef?: string;
  installation?: OrgGithubAppInstallation;
  specTitle: string;
  specDescription: string;
  runner?: {
    sshHost: string;
    sshPort: number;
    hostKeyFingerprint: string;
  };
}

export async function loadDraftPrRunContext(
  pool: RunStateClient,
  runId: string,
): Promise<DraftPrRunContext | undefined> {
  const result = await pool.query(
    `SELECT
       r.run_id,
       r.spec_id,
       r.project_id,
       r.org_id,
       r.branch,
       r.ancestor_stack,
       p.repo_url,
       p.default_branch,
       p.config,
       o.config AS org_config,
       s.title AS spec_title,
       s.description AS spec_description,
       runner.ssh_host,
       runner.ssh_port,
       runner.host_key_fingerprint
     FROM runs r
     JOIN projects p ON p.project_id = r.project_id
     LEFT JOIN organizations o ON o.id = p.org_id
     JOIN specs s ON s.spec_id = r.spec_id
     LEFT JOIN LATERAL (
       SELECT ssh_host, ssh_port, host_key_fingerprint
       FROM runners
       WHERE run_id = r.run_id
       ORDER BY created_at DESC
       LIMIT 1
     ) runner ON true
     WHERE r.run_id = $1`,
    [runId],
  );
  const raw = result.rows[0];
  if (raw === undefined) return undefined;
  const row = DraftPrRunRow.parse(raw);
  const ancestorStack = resolveAncestorStack({ ancestorStack: row.ancestor_stack });
  return {
    runId: row.run_id,
    specId: row.spec_id,
    projectId: row.project_id,
    orgId: row.org_id,
    branch: row.branch,
    ...(ancestorStack.length > 0 && { ancestorStack }),
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    configuredGithubCredentialRef: readGithubCredentialRef(row.config, row.org_id),
    installation: readGithubInstallation(row.org_config, row.org_id),
    specTitle: row.spec_title,
    specDescription: row.spec_description,
    runner:
      row.ssh_host === null || row.ssh_port === null || row.host_key_fingerprint === null
        ? undefined
        : { sshHost: row.ssh_host, sshPort: row.ssh_port, hostKeyFingerprint: row.host_key_fingerprint },
  };
}
