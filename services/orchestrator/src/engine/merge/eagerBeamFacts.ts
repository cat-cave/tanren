import { runWithOrgScope } from "@tanren/db";
import { CANONICAL_RUNNER_IMAGE } from "../config/shared.js";
import { bindOrgGithubCredentialRefs, migrateOrgConfig } from "../config/orgConfig.js";
import {
  bindProjectGithubCredentialRefs,
  isAbsentProjectConfig,
  migrateProjectConfig,
} from "../config/projectConfig.js";
import { memberKey, type IntegrationNodeMember } from "../contracts/integrationNodes.js";
import { resolveAncestorStack } from "../dag/ancestorStack.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import { GitHubCodeHost, parseGitHubRepository } from "../providers/githubCodeHost.js";
import { activeQuarantineVersion, loadActiveQuarantine, quarantineEnv } from "../workflow/ciQuarantine.js";
import type { EagerBeamCandidate, EagerBeamProject } from "./eagerBeamStore.js";
import type { EagerBeamRuntimeDeps } from "./eagerBeamRuntime.js";

const FULL_SHA = /^[0-9a-f]{40}$/u;

export interface ResolvedEagerBeamFacts {
  readonly repoUrl: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly members: ReadonlyArray<IntegrationNodeMember>;
  readonly memberKey: string;
  readonly runnerImage: string;
  readonly policyVersion: string;
  readonly quarantineVersion: string;
  readonly appEnv: Record<string, string>;
  readonly installation: ReturnType<typeof resolveCredentialContext>["installation"];
  readonly staticRef: string | undefined;
}

export type EagerBeamFactResolution =
  | { readonly kind: "resolved"; readonly facts: ResolvedEagerBeamFacts }
  | { readonly kind: "held"; readonly reason: string };

/** Reads every real dependency head and rejects an unconfirmable base before jj work starts. */
export class EagerBeamFactsResolver {
  public constructor(
    private readonly deps: Pick<EagerBeamRuntimeDeps, "pool" | "secrets" | "githubHttp" | "githubAppMinter">,
  ) {}

  public async resolve(project: EagerBeamProject, candidate: EagerBeamCandidate): Promise<EagerBeamFactResolution> {
    const baseBranch = requireNonBlank(project.defaultBranch, "default branch");
    const repoUrl = requireNonBlank(project.repoUrl, "repository URL");
    const frontierBranch = requireNonBlank(candidate.branch, "frontier branch");
    const stack = resolveAncestorStack({ ancestorStack: candidate.ancestorStack });
    if (stack.length === 0) return { kind: "held", reason: "empty_ancestor_stack" };
    const policyVersion = String(migrateProjectConfig(project.projectConfig).version);
    const runnerImage = resolveRunnerImage(project.runnerImage);
    const { installation, staticRef } = resolveCredentialContext(project);
    const token = await resolveVcsToken(this.deps.githubHttp, {
      secrets: this.deps.secrets,
      orgId: project.orgId,
      ...(installation === undefined ? {} : { installation }),
      ...(staticRef === undefined ? {} : { staticRef }),
      ...(this.deps.githubAppMinter === undefined ? {} : { minter: this.deps.githubAppMinter }),
    });
    const host = new GitHubCodeHost(this.deps.githubHttp, async () => ({
      token: token.token,
      ...(token.authorizationIdentity === undefined ? {} : { authorizationIdentity: token.authorizationIdentity }),
      ...(token.refresh === undefined ? {} : { refresh: token.refresh }),
    }));
    const repo = parseGitHubRepository(repoUrl);
    const baseSha = await host.fetchRef({ repo, remoteBranch: baseBranch });
    if (!isFullSha(baseSha)) return { kind: "held", reason: "base_head_unavailable" };
    const members: IntegrationNodeMember[] = [];
    for (const ancestor of stack) {
      const branch = requireNonBlank(ancestor.branch, "ancestor branch");
      const published = await host.fetchRef({ repo, remoteBranch: branch });
      if (!isFullSha(published)) return { kind: "held", reason: "ancestor_head_unavailable" };
      if (published !== ancestor.headSha) return { kind: "held", reason: "ancestor_head_changed" };
      members.push(ancestor);
    }
    const frontierHead = await host.fetchRef({ repo, remoteBranch: frontierBranch });
    if (!isFullSha(frontierHead)) return { kind: "held", reason: "frontier_head_unavailable" };
    members.push({ specId: candidate.specId, runId: candidate.runId, branch: frontierBranch, headSha: frontierHead });
    const quarantine = await runWithOrgScope(this.deps.pool, project.orgId, (client) =>
      loadActiveQuarantine(client, project.projectId),
    );
    return {
      kind: "resolved",
      facts: {
        repoUrl,
        baseBranch,
        baseSha,
        members,
        memberKey: memberKey(
          baseSha,
          members.map((member) => member.headSha),
        ),
        runnerImage,
        policyVersion,
        quarantineVersion: activeQuarantineVersion(quarantine),
        appEnv: quarantineEnv(quarantine),
        installation,
        staticRef,
      },
    };
  }
}

function resolveCredentialContext(project: EagerBeamProject): {
  installation: ReturnType<typeof migrateOrgConfig>["github_app"];
  staticRef: string | undefined;
} {
  const org =
    project.orgConfig === null || project.orgConfig === undefined ? undefined : migrateOrgConfig(project.orgConfig);
  const installation = org === undefined ? undefined : bindOrgGithubCredentialRefs(org, project.orgId).github_app;
  if (!isAbsentProjectConfig(project.projectConfig)) {
    const projectConfig = bindProjectGithubCredentialRefs(migrateProjectConfig(project.projectConfig), project.orgId);
    const staticRef = projectConfig.credentials?.githubCredentialRef;
    if (staticRef !== undefined) return { installation, staticRef };
  }
  return {
    installation,
    staticRef:
      org === undefined ? undefined : bindOrgGithubCredentialRefs(org, project.orgId).defaultCredentials?.github_token,
  };
}

function resolveRunnerImage(value: unknown): string {
  if (value === null || value === undefined) return CANONICAL_RUNNER_IMAGE;
  return requireNonBlank(value, "runner image");
}

function requireNonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing or blank`);
  return value.trim();
}

function isFullSha(value: string | undefined): value is string {
  return value !== undefined && FULL_SHA.test(value);
}
