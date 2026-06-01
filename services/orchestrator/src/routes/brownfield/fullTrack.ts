// P3-0016 brownfield onboarding (full track) HTTP routes. Layered on top of the
// P2B-0002 minimal link endpoint (which lives in `./index.ts`); these add the
// deeper steps without touching the link handler:
//
//   POST /:orgId/projects/:projectId/recon
//     Read-only recon: index the linked repo via the App resolver + read-only
//     Answerer, return the pre-filled chapters + gaps. Writes nothing.
//
//   POST /:orgId/projects/:projectId/config-injection
//     Open ONE config-injection PR in the target repo with the kept files
//     (operator-excluded paths removed). "No runs until merged."
//
//   POST /:orgId/projects/:projectId/seed-dag
//     Turn recon gaps + open GitHub issues into seed specs (P2A-0013 createSpec).
//
//   POST /:orgId/projects/:projectId/governance
//     Persist the chosen posture (strict | open | audit_only) onto the project
//     config (P3-0023). The external-push behavior is DERIVED from the posture
//     (see `governancePosture.ts`), so no new config field + no migration.
//
// Every GitHub/Answerer seam is injectable so tests mock them. The recon report
// rides on the request between steps (transient — no interview-session table),
// mirroring the greenfield capture model: no migration.

import { Hono } from "hono";
import type pg from "pg";
import { z } from "zod";
import type { ActorContext } from "../../auth/schemas.js";
import { GovernancePosture, type GovernancePosture as GovernancePostureType } from "../../engine/config/shared.js";
import { migrateProjectConfig } from "../../engine/config/projectConfig.js";
import type { SecretStore } from "../../engine/contracts/secretStore.js";
import {
  loadOrgDefaultGithubCredentialRef,
  loadOrgGithubAppInstallation,
} from "../../engine/credentials/orgGithubApp.js";
import { resolveGithubToken, type ResolvedGithubToken } from "../../engine/credentials/githubTokenResolver.js";
import {
  FetchConfigInjectionGitHub,
  GithubRepoReader,
  openConfigInjectionPr,
  proposeConfigFiles,
  runRecon,
  seedDagFromReconAndIssues,
  ReconReport,
  type ConfigInjectionGitHub,
  type ReconAnswerer,
  type RepoReader,
} from "../../engine/forge/brownfield/index.js";
import { createGitHubIssuesConnector } from "../../engine/forge/inbox/githubConnector.js";
import type { IngestedItem } from "../../engine/forge/inbox/types.js";
import type { GitHubHttpClient } from "../../engine/providers/github.js";
import { parseGitHubRepository } from "../../engine/providers/github.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import type { ActorContextEnv } from "../../middleware/auth.js";
import { actorCanAccessOrg } from "../orgs/index.js";

export interface BrownfieldFullTrackOptions {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  // Injectable recon Answerer (provider wrap or test fake). Defaults to the
  // engine's deterministic recon Answerer when omitted.
  reconAnswererFactory?: () => ReconAnswerer;
  // Test seams: override the repo reader / config-injection GitHub / issue
  // fetch so the routes are exercised without network.
  repoReaderFor?: (repoUrl: string, defaultBranch: string, resolved: ResolvedGithubToken) => RepoReader;
  configInjectionGithubFor?: (resolved: ResolvedGithubToken) => ConfigInjectionGitHub;
  fetchIssues?: (repoUrl: string, projectId: string) => Promise<IngestedItem[]>;
}

const ReconBody = z.object({ repoUrl: z.string().min(1).max(400) }).strict();

const ConfigInjectionBody = z
  .object({
    repoUrl: z.string().min(1).max(400),
    baseBranch: z.string().min(1).max(200).default("main"),
    report: ReconReport,
    posture: GovernancePosture.default("strict"),
    excludePaths: z.array(z.string().min(1).max(400)).default([]),
  })
  .strict();

const SeedDagBody = z
  .object({
    repoUrl: z.string().min(1).max(400),
    report: ReconReport,
    includeIssues: z.boolean().default(true),
  })
  .strict();

const GovernanceBody = z.object({ posture: GovernancePosture }).strict();

export function createBrownfieldFullTrackRoutes(options: BrownfieldFullTrackOptions) {
  const app = new Hono<ActorContextEnv>();

  app.post("/:orgId/projects/:projectId/recon", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = ReconBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_recon", issues: parsed.error.issues }, 400);
    try {
      const resolved = await resolveTokenFor(options, guard.orgId);
      const reader =
        options.repoReaderFor?.(parsed.data.repoUrl, guard.defaultBranch, resolved) ??
        new GithubRepoReader({
          http: options.githubHttp,
          resolved,
          defaultBranch: guard.defaultBranch,
        });
      const { index, report } = await runRecon(
        {
          reader,
          ...(options.reconAnswererFactory === undefined ? {} : { answerer: options.reconAnswererFactory() }),
        },
        parsed.data.repoUrl,
      );
      return c.json({ repoUrl: parsed.data.repoUrl, filesIndexed: index.filesIndexed, report }, 200);
    } catch (error) {
      return c.json({ error: "recon_failed", message: messageOf(error) }, 502);
    }
  });

  app.post("/:orgId/projects/:projectId/config-injection", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = ConfigInjectionBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_config_injection", issues: parsed.error.issues }, 400);
    const repo = parseGitHubRepository(parsed.data.repoUrl);
    const files = proposeConfigFiles(
      {
        repoSlug: repo.name,
        orgLogin: repo.owner,
        repoUrl: parsed.data.repoUrl,
        report: parsed.data.report,
        posture: parsed.data.posture,
        generatedAt: new Date().toISOString(),
      },
      parsed.data.excludePaths,
    );
    try {
      const resolved = await resolveTokenFor(options, guard.orgId);
      const github =
        options.configInjectionGithubFor?.(resolved) ??
        new FetchConfigInjectionGitHub({
          http: options.githubHttp,
          token: resolved.token,
          refreshToken: resolved.refresh,
        });
      const pr = await openConfigInjectionPr({
        github,
        repoUrl: parsed.data.repoUrl,
        baseBranch: parsed.data.baseBranch,
        files,
      });
      return c.json(
        {
          pullRequest: pr,
          files: files.map((f) => ({ path: f.path, addedLines: f.addedLines })),
          noRunsUntilMerged: true,
        },
        201,
      );
    } catch (error) {
      return c.json({ error: "config_injection_failed", message: messageOf(error) }, 502);
    }
  });

  app.post("/:orgId/projects/:projectId/seed-dag", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = SeedDagBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_seed_dag", issues: parsed.error.issues }, 400);
    try {
      const issues = parsed.data.includeIssues
        ? await fetchIssuesFor(options, guard.orgId, guard.projectId, parsed.data.repoUrl)
        : [];
      const result = await seedDagFromReconAndIssues(options.pool, {
        projectId: guard.projectId,
        orgId: guard.orgId,
        report: parsed.data.report,
        issues,
        actor: { ...guard.actor, orgId: guard.orgId, projectId: guard.projectId },
      });
      return c.json(result, 201);
    } catch (error) {
      return c.json({ error: "seed_dag_failed", message: messageOf(error) }, 500);
    }
  });

  app.post("/:orgId/projects/:projectId/governance", async (c) => {
    const guard = await guardOrg(c, options.pool);
    if (guard.error !== undefined) return c.json({ error: guard.error }, guard.status);
    const parsed = GovernanceBody.safeParse(await c.req.json().catch(() => {}));
    if (!parsed.success) return c.json({ error: "invalid_governance", issues: parsed.error.issues }, 400);
    const posture = parsed.data.posture;
    const next = await persistPosture(options.pool, guard.projectId, posture);
    return c.json(
      {
        projectId: guard.projectId,
        governancePosture: posture,
        externalPushPolicy: externalPushPolicy(posture),
        config: next,
      },
      200,
    );
  });

  return app;
}

interface OrgGuard {
  orgId: string;
  projectId: string;
  defaultBranch: string;
  actor: ActorContext;
  error?: string;
  status: 403 | 404;
}

async function guardOrg(
  c: { req: { param(name: string): string }; var: { actor?: ActorContext } },
  pool: pg.Pool,
): Promise<OrgGuard> {
  const actor = c.var.actor;
  const orgId = c.req.param("orgId");
  const projectId = c.req.param("projectId");
  const base: OrgGuard = {
    orgId,
    projectId,
    defaultBranch: "main",
    actor: actor as ActorContext,
    status: 403,
  };
  if (actor === undefined) return { ...base, error: "actor_missing" };
  if (!actorCanAccessOrg(actor, orgId)) return { ...base, error: "org_access_denied", status: 403 };
  const ownership = await ProjectStore.getOwnership(pool, projectId, systemActor);
  if (ownership === undefined) return { ...base, error: "project_not_found", status: 404 };
  if (ownership.orgId !== null && ownership.orgId !== orgId)
    return { ...base, error: "project_access_denied", status: 403 };
  return { ...base, defaultBranch: ownership.defaultBranch ?? "main" };
}

async function resolveTokenFor(options: BrownfieldFullTrackOptions, orgId: string): Promise<ResolvedGithubToken> {
  const installation = await loadOrgGithubAppInstallation(options.pool, orgId);
  // No App installation ⇒ resolve the org's default GitHub credential ref as the
  // static token source (no hardcoded default ref).
  const staticRef =
    installation === undefined ? await loadOrgDefaultGithubCredentialRef(options.pool, orgId) : undefined;
  return resolveGithubToken({
    secrets: options.secrets,
    ...(installation === undefined ? {} : { installation }),
    ...(staticRef === undefined ? {} : { staticRef }),
    ...(options.githubAppMinter === undefined ? {} : { minter: options.githubAppMinter }),
  });
}

async function fetchIssuesFor(
  options: BrownfieldFullTrackOptions,
  orgId: string,
  projectId: string,
  repoUrl: string,
): Promise<IngestedItem[]> {
  if (options.fetchIssues !== undefined) return options.fetchIssues(repoUrl, projectId);
  const repo = parseGitHubRepository(repoUrl);
  const installation = await loadOrgGithubAppInstallation(options.pool, orgId);
  // No App installation ⇒ the connector resolves its static token from the org's
  // default GitHub credential ref (carried on the source config; no hardcoded
  // default ref).
  const staticRef =
    installation === undefined ? await loadOrgDefaultGithubCredentialRef(options.pool, orgId) : undefined;
  const connector = createGitHubIssuesConnector({
    secrets: options.secrets,
    githubHttp: options.githubHttp,
    ...(installation === undefined ? {} : { installation }),
    ...(options.githubAppMinter === undefined ? {} : { minter: options.githubAppMinter }),
  });
  return connector.fetch({
    id: "brownfield-recon",
    orgId,
    projectId,
    kind: "issues",
    name: "brownfield recon issues",
    detail: "",
    config: { owner: repo.owner, repo: repo.name, labels: [], ...(staticRef === undefined ? {} : { staticRef }) },
    enabled: true,
    autoRoute: false,
  });
}

async function persistPosture(pool: pg.Pool, projectId: string, posture: GovernancePostureType): Promise<unknown> {
  const config = await ProjectStore.getConfig(pool, projectId, systemActor);
  const current = migrateProjectConfig(config);
  const next = { ...current, governancePosture: posture };
  await ProjectStore.updateConfig(pool, projectId, next, systemActor);
  return next;
}

function externalPushPolicy(posture: GovernancePostureType): string {
  if (posture === "open") return "external pushes coexist · tracked, never blocked";
  if (posture === "audit_only") return "external pushes observed · tanren opens no PRs";
  return "external pushes warned + auto-spec'd · force-push blocked · main bypass fails the check";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
