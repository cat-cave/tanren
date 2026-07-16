// The REAL scheduled-audit pass runner (replaces the no-op).
//
// Composes the SAME read-only repo machinery the brownfield recon step uses —
// the `RepoReader` (App-token-resolved `GithubRepoReader`, indexes the linked
// repo READ-ONLY) — with an audit `AuditAnswerer` (a model pass over the indexed
// evidence that surfaces actionable findings). The scheduler then routes each
// finding into the DAG. NOTHING here writes to the target repo.
//
// This mirrors the recon engine's `RepoReader` + answerer composition and the
// Forge provider-factory's per-call allocation, so production reasons with a real
// model and there is NO deterministic fallback (§8a):
//   - a project-less job CANNOT be audited (no repo) → LOUD failure.
//   - a project with no resolvable repo URL → LOUD failure.
//   - a project with no resolvable default branch → LOUD failure.
//   - a project with no resolvable GitHub credential → the token resolver throws.
// Each is a hard failure, never a silent empty pass.
//
// The repo is indexed at the PROJECT'S OWN `default_branch` (read per-job from the
// `projects` row) — NOT a hardcoded `main`. A repo whose default branch is
// `develop`/`master`/etc. is audited at its real branch; greenfield projects keep
// `main` because that is their stored default, not a literal baked in here.

import type pg from "pg";
import { runWithSystemScope } from "@tanren/db";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import type { ResolvedGithubToken } from "../../credentials/githubTokenResolver.js";
import { resolveGithubToken } from "../../credentials/githubTokenResolver.js";
import { loadOrgDefaultGithubCredentialRef, loadOrgGithubAppInstallation } from "../../credentials/orgGithubApp.js";
import type { SecretStore } from "../../contracts/secretStore.js";
import { systemActor } from "../../state/actor.js";
import { ForgeToolsStore } from "../../repositories/forgeTools.js";
import { GithubRepoReader } from "../brownfield/githubRepoReader.js";
import type { RepoReader } from "../brownfield/types.js";
import type { AuditAnswerer, AuditJob, AuditPassResult, AuditPassRunner } from "./types.js";

/** Thrown when an audit job has no project (a repo-less job cannot be audited). */
export class AuditJobNotProjectScopedError extends Error {
  constructor(readonly jobId: string) {
    super(`scheduled audit ${jobId} has no project — a repo-less job cannot be audited`);
    this.name = "AuditJobNotProjectScopedError";
  }
}

/** Thrown when the audited project has no resolvable repo URL. */
export class AuditProjectRepoUnresolvableError extends Error {
  constructor(readonly projectId: string) {
    super(`scheduled audit cannot resolve a repo for project ${projectId}`);
    this.name = "AuditProjectRepoUnresolvableError";
  }
}

/**
 * Thrown when the audited project row carries no usable default branch. The
 * `projects.default_branch` column is `NOT NULL DEFAULT 'main'`, so this only
 * fires on a corrupt/empty value — a LOUD failure, never a silent fall back to a
 * hardcoded `main` (which would mis-index a repo whose real default is
 * `develop`/`master`/etc. and loop the audit forever producing no finding/spec).
 */
export class AuditProjectDefaultBranchUnresolvableError extends Error {
  constructor(readonly projectId: string) {
    super(`scheduled audit cannot resolve a default branch for project ${projectId}`);
    this.name = "AuditProjectDefaultBranchUnresolvableError";
  }
}

export interface AnswererPassRunnerDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  // The per-job audit answerer factory — a REAL provider answerer resolved from
  // the project's `forge` routing (no §8a fallback). The scheduler/loop builds it
  // from the same Forge infra the triage answerer uses.
  answererFactory: (target: { orgId: string; projectId: string }) => AuditAnswerer;
  // Test seam: override the repo reader (production builds a `GithubRepoReader`).
  // `defaultBranch` is the PROJECT'S resolved default branch (per-job, not a
  // build-time constant) so the override sees the real ref it will index at.
  repoReaderFor?: (repoUrl: string, defaultBranch: string, resolved: ResolvedGithubToken) => RepoReader;
}

/**
 * Build the production audit pass runner. Each `run(job)`:
 *   1. resolves the project's repo URL + its own `default_branch` (a repo-less /
 *      unresolvable-repo / unresolvable-branch job is a LOUD failure — never a
 *      silent empty pass, never a hardcoded `main`),
 *   2. resolves a GitHub token (App installation or org-default static ref, the
 *      same path recon uses),
 *   3. indexes the repo READ-ONLY at the project's default branch,
 *   4. has the audit answerer surface findings over the indexed evidence.
 */
export function createAnswererPassRunner(deps: AnswererPassRunnerDeps): AuditPassRunner {
  return {
    async run(job: AuditJob): Promise<AuditPassResult> {
      if (job.projectId === null) {
        throw new AuditJobNotProjectScopedError(job.id);
      }
      const projectId = job.projectId;
      const { repoUrl, defaultBranch } = await resolveRepoTarget(deps.pool, projectId);
      const resolved = await resolveTokenFor(deps, job.orgId);
      const reader =
        deps.repoReaderFor?.(repoUrl, defaultBranch, resolved) ??
        new GithubRepoReader({ http: deps.githubHttp, resolved, defaultBranch });
      const index = await reader.index(repoUrl);
      const answerer = deps.answererFactory({ orgId: job.orgId, projectId });
      const report = await answerer.audit({ job, index });
      return {
        findings: report.findings.map((finding) => ({
          externalId: finding.externalId,
          title: finding.title,
          body: finding.body,
          severity: finding.severity,
        })),
      };
    },
  };
}

// Resolve the audited project's repo URL + its own default branch (the ref the
// audit indexes the tree at). RLS: the audit loop runs system-scoped (the worker
// has no actor), so the read goes through `runWithSystemScope`. An empty repo URL
// or an empty/whitespace default branch is a LOUD failure — never a fall back to a
// hardcoded `main`, which would mis-index a `develop`/`master` repo.
async function resolveRepoTarget(
  pool: pg.Pool,
  projectId: string,
): Promise<{ repoUrl: string; defaultBranch: string }> {
  const row = await runWithSystemScope(pool, (client) =>
    ForgeToolsStore.getProjectRepoAndConfig(client, projectId, systemActor),
  );
  if (row === undefined || row.repoUrl === "") {
    throw new AuditProjectRepoUnresolvableError(projectId);
  }
  const defaultBranch = row.defaultBranch.trim();
  if (defaultBranch === "") {
    throw new AuditProjectDefaultBranchUnresolvableError(projectId);
  }
  return { repoUrl: row.repoUrl, defaultBranch };
}

// Resolve a GitHub token for the org — App installation when present, else the
// org's default static credential ref. Mirrors the brownfield recon route's
// `resolveTokenFor`; a missing credential is a LOUD failure in the resolver.
async function resolveTokenFor(deps: AnswererPassRunnerDeps, orgId: string): Promise<ResolvedGithubToken> {
  const installation = await loadOrgGithubAppInstallation(deps.pool, orgId);
  const staticRef = installation === undefined ? await loadOrgDefaultGithubCredentialRef(deps.pool, orgId) : undefined;
  return resolveGithubToken({
    secrets: deps.secrets,
    orgId,
    ...(installation === undefined ? {} : { installation }),
    ...(staticRef === undefined ? {} : { staticRef }),
    ...(deps.githubAppMinter === undefined ? {} : { minter: deps.githubAppMinter }),
  });
}
