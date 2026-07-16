// L2 (post-merge re-intake): when a project LINKS a GitHub repo (greenfield create
// or brownfield link), auto-create the matching `issues` inbox source so the
// post-merge auto-issue → re-ingest loop closes BY DEFAULT and a user-filed report
// has a source to land in — without an operator hand-configuring a source first.
//
// The post-merge watcher opens a tracking issue on the linked repo; that issue is
// only ever ingested back into the DAG if an `issues` inbox source exists for the
// repo. Linking the repo is the natural moment to provision it. Idempotent: if an
// `issues` source already names this (owner, repo), nothing is created.

import type pg from "pg";
import { runWithOrgScope } from "@tanren/db";
import { parseGitHubRepository } from "../../providers/github.js";
import { ActiveGitHubIssuesConfig } from "./types.js";
import { InboxStore } from "../../repositories/inbox.js";
import type { InboxSource } from "./types.js";

export interface EnsureIssuesSourceInput {
  pool: pg.Pool;
  orgId: string;
  projectId: string;
  repoUrl: string;
}

export interface EnsureIssuesSourceResult {
  source: InboxSource;
  created: boolean;
}

/**
 * Ensure an `issues` inbox source exists for the project's GitHub repo. Reads the
 * org's existing sources (org-scoped under RLS) and, if none already names this
 * (owner, repo) for this project, creates one configured for the GitHub issues
 * provider. Returns the existing-or-new source + whether it was created.
 */
export async function ensureIssuesInboxSource(input: EnsureIssuesSourceInput): Promise<EnsureIssuesSourceResult> {
  const repo = parseGitHubRepository(input.repoUrl);
  return runWithOrgScope(input.pool, input.orgId, async (client) => {
    const existing = await InboxStore.listSources(client, input.orgId);
    const match = existing.find((source) => matchesRepo(source, input.projectId, repo.owner, repo.name));
    if (match !== undefined) return { source: match, created: false };
    const source = await InboxStore.createSource(client, {
      orgId: input.orgId,
      projectId: input.projectId,
      kind: "issues",
      name: `github · ${repo.owner}/${repo.name}`,
      detail: "auto-created on repo link",
      // The one provider-only GitHub config. Webhook authority is internal source
      // metadata, never part of this reusable HTTP/UI config shape.
      config: { owner: repo.owner, repo: repo.name, labels: [] },
      enabled: true,
      autoRoute: false,
    });
    return { source, created: true };
  });
}

/** Whether an existing source is the GitHub `issues` source for this project + repo. */
function matchesRepo(source: InboxSource, projectId: string, owner: string, repo: string): boolean {
  if (source.kind !== "issues" || source.projectId !== projectId) return false;
  const parsed = ActiveGitHubIssuesConfig.safeParse(source.config);
  if (!parsed.success) return false;
  return parsed.data.owner === owner && parsed.data.repo === repo;
}
