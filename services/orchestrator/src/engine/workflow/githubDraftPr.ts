import type pg from "pg";
import { migrateOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { SshTarget } from "../contracts/allocator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { redactedGithubTokenResult, validateGithubCredentialRef } from "../credentials/githubToken.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { workspaceRepoPathForRun } from "../workspace/index.js";
import { draftPrBranchName } from "../workspace/githubPush.js";

type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface PublishDraftPullRequestInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  // Plane-split P3c: route the `UPDATE runs SET pr_url` through the control plane
  // when wired (remote-writes on) — else the byte-identical in-process write on
  // `pool`. `orgId` scopes the remote write (present whenever the writer is).
  runStateWriter?: RunStateWriter;
  orgId?: string | null;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  ssh: SshSubstrate;
  target: SshTarget;
  runId: string;
  specId: string;
  projectId: string;
  workspacePath: string;
  repoUrl: string;
  targetBranch: string;
  runBranch?: string;
  title: string;
  body?: string;
  githubCredentialRef?: string;
  projectConfig?: Record<string, unknown>;
  timeoutMs: number;
  /** P3-0003: org App installation; when set, prefer minting an App token. */
  installation?: OrgGithubAppInstallation;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * The local gitref pushed as the PR branch (default "HEAD"). The planner run
   * passes the cleaned PR ref (writer commits with the bootstrap commit dropped)
   * so the PR excludes bootstrap-generated artifacts.
   */
  sourceRef?: string;
}

export interface PublishedDraftPullRequest {
  branch: string;
  prUrl: string;
  prNumber: number;
  reused: boolean;
}

export interface PublishDraftPullRequestForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  ssh: SshSubstrate;
  runId: string;
  githubCredentialRef?: string;
  identitySecretRef: string;
  workspacePath?: string;
  title?: string;
  body?: string;
  timeoutMs: number;
  /** P3-0003: shared installation-token minter (cache lives here). */
  githubAppMinter?: GithubAppTokenMinter;
}

export class DraftPrRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run not found for draft PR publication: ${runId}`);
  }
}

export class DraftPrRunnerNotFoundError extends Error {
  constructor(runId: string) {
    super(`runner not found for draft PR publication: ${runId}`);
  }
}

export async function publishDraftPullRequest(input: PublishDraftPullRequestInput): Promise<PublishedDraftPullRequest> {
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const context = eventContext(input);
  const branch = draftPrBranchName({ runId: input.runId, requestedBranch: input.runBranch });
  // With an App installation the static ref is optional; the ledger label is
  // the App credential ref in that case.
  const staticRef =
    input.installation === undefined ? githubCredentialRefFromInput(input) : credentialRefOrUndefined(input);
  const ledgerRef = input.installation?.credentialRef ?? staticRef ?? "github_app";

  try {
    await eventStore.append({
      ...context,
      eventType: "credential.requested",
      payload: redactedGithubTokenResult(ledgerRef),
    });
    const resolved = await input.vcsProvider.resolveToken({
      secrets: input.secrets,
      installation: input.installation,
      staticRef,
      minter: input.githubAppMinter,
    });
    await eventStore.append({
      ...context,
      eventType: "credential.loaded",
      payload: redactedGithubTokenResult(ledgerRef),
    });
    await input.vcsProvider.pushBranch({
      secrets: input.secrets,
      ssh: input.ssh,
      target: input.target,
      workspacePath: input.workspacePath,
      repoUrl: input.repoUrl,
      branch,
      credentialRef: ledgerRef,
      token: resolved,
      timeoutMs: input.timeoutMs,
      sourceRef: input.sourceRef,
    });
    await eventStore.append({
      ...context,
      eventType: "github.branch.pushed",
      payload: { repoUrl: input.repoUrl, branch, credentialRef: ledgerRef, redacted: true },
    });

    const pr = await input.vcsProvider.openDraftPullRequest({
      repo: input.vcsProvider.parseRepository(input.repoUrl),
      token: resolved,
      headBranch: branch,
      baseBranch: input.targetBranch,
      title: input.title,
      body: input.body,
    });
    const prOrgId = typeof input.orgId === "string" ? input.orgId : undefined;
    if (input.runStateWriter !== undefined && prOrgId !== undefined) {
      await input.runStateWriter.setRunPrUrl({ runId: input.runId, orgId: prOrgId, prUrl: pr.url });
    } else {
      await input.pool.query("UPDATE runs SET pr_url = $2 WHERE run_id = $1", [input.runId, pr.url]);
    }
    await eventStore.append({
      ...context,
      eventType: "github.pr.created",
      payload: {
        repoUrl: input.repoUrl,
        branch,
        targetBranch: input.targetBranch,
        prUrl: pr.url,
        prNumber: pr.number,
        reused: pr.reused,
      },
    });
    return { branch, prUrl: pr.url, prNumber: pr.number, reused: pr.reused };
  } catch (error) {
    await eventStore.append({
      ...context,
      eventType: "github.failed",
      payload: {
        operation: "publish_draft_pull_request",
        branch,
        message: messageFromError(error),
      },
    });
    throw error;
  }
}

export async function publishDraftPullRequestForRun(
  input: PublishDraftPullRequestForRunInput,
): Promise<PublishedDraftPullRequest> {
  const context = await loadDraftPrRunContext(input.pool, input.runId);
  if (context === undefined) {
    throw new DraftPrRunNotFoundError(input.runId);
  }
  if (context.runner === undefined) {
    throw new DraftPrRunnerNotFoundError(input.runId);
  }

  return await publishDraftPullRequest({
    pool: input.pool,
    eventStore: input.eventStore,
    secrets: input.secrets,
    vcsProvider: input.vcsProvider,
    ssh: input.ssh,
    target: {
      host: context.runner.sshHost,
      port: context.runner.sshPort,
      username: "tanren",
      hostKeyFingerprint: context.runner.hostKeyFingerprint,
      identitySecretRef: input.identitySecretRef,
    },
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    workspacePath: input.workspacePath ?? workspaceRepoPathForRun(context.runId),
    repoUrl: context.repoUrl,
    targetBranch: context.defaultBranch,
    runBranch: context.branch,
    title: input.title ?? `Tanren: ${context.specTitle}`,
    body: input.body ?? context.specDescription,
    githubCredentialRef: input.githubCredentialRef,
    projectConfig: context.projectConfig,
    timeoutMs: input.timeoutMs,
    installation: context.installation,
    githubAppMinter: input.githubAppMinter,
  });
}

async function loadDraftPrRunContext(pool: RunStateClient, runId: string): Promise<DraftPrRunContext | undefined> {
  const result = await pool.query(
    `SELECT
       r.run_id,
       r.spec_id,
       r.project_id,
       r.branch,
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
  const row = result.rows[0] as DraftPrRunRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    runId: row.run_id,
    specId: row.spec_id,
    projectId: row.project_id,
    branch: row.branch,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    projectConfig: asRecord(row.config),
    installation: installationFromOrgConfig(row.org_config),
    specTitle: row.spec_title,
    specDescription: row.spec_description,
    runner:
      row.ssh_host === null || row.ssh_port === null || row.host_key_fingerprint === null
        ? undefined
        : {
            sshHost: row.ssh_host,
            sshPort: Number(row.ssh_port),
            hostKeyFingerprint: row.host_key_fingerprint,
          },
  };
}

function githubCredentialRefFromInput(input: PublishDraftPullRequestInput): string {
  const configured = input.githubCredentialRef ?? input.projectConfig?.["githubCredentialRef"];
  if (typeof configured !== "string") {
    throw new TypeError("GitHub credential ref is required");
  }
  return validateGithubCredentialRef(configured);
}

function credentialRefOrUndefined(input: PublishDraftPullRequestInput): string | undefined {
  const configured = input.githubCredentialRef ?? input.projectConfig?.["githubCredentialRef"];
  return typeof configured === "string" ? validateGithubCredentialRef(configured) : undefined;
}

function eventContext(input: PublishDraftPullRequestInput) {
  return { runId: input.runId, specId: input.specId, projectId: input.projectId };
}

interface DraftPrRunContext {
  runId: string;
  specId: string;
  projectId: string;
  branch: string;
  repoUrl: string;
  defaultBranch: string;
  projectConfig: Record<string, unknown>;
  installation?: OrgGithubAppInstallation;
  specTitle: string;
  specDescription: string;
  runner?: {
    sshHost: string;
    sshPort: number;
    hostKeyFingerprint: string;
  };
}

interface DraftPrRunRow {
  run_id: string;
  spec_id: string;
  project_id: string;
  branch: string;
  repo_url: string;
  default_branch: string;
  config: unknown;
  org_config: unknown;
  spec_title: string;
  spec_description: string;
  ssh_host: string | null;
  ssh_port: number | null;
  host_key_fingerprint: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function installationFromOrgConfig(orgConfig: unknown): OrgGithubAppInstallation | undefined {
  if (orgConfig === null || orgConfig === undefined) {
    return undefined;
  }
  try {
    return migrateOrgConfig(orgConfig).github_app;
  } catch {
    return undefined;
  }
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
