import type pg from "pg";
import { installationFromOrgConfig, type OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import { sshRunnerHandle } from "../contracts/allocator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import {
  normalizeStaticGithubRef,
  redactedGithubTokenResult,
  validateGithubCredentialRef,
} from "../credentials/githubToken.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import { gitHubHttpOf } from "../providers/projectHostSeamsOver.js";
import { GitHubVisibilityProjection } from "../providers/githubVisibilityProjection.js";
import { parseGitHubRepository } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { workspaceRepoPathForRun } from "../workspace/index.js";
import { draftPrBranchName, pushWorkspaceBranchToGitHub } from "../workspace/githubPush.js";
import { type AncestorStack, resolveAncestorStack } from "../dag/ancestorStack.js";

type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

export interface PublishDraftPullRequestInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  // route the `UPDATE runs SET pr_url` through the control plane
  // when wired (remote-writes on) — else the byte-identical in-process write on
  // `pool`. `orgId` scopes the remote write (present whenever the writer is).
  runStateWriter?: RunStateWriter;
  orgId?: string | null;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  runId: string;
  specId: string;
  projectId: string;
  workspacePath: string;
  repoUrl: string;
  targetBranch: string;
  /**
   * walker-jj-local-integration-design.md §3.1: the ordered ancestor stack this dependent
   * speculative run is stacked on. A NON-EMPTY stack ⇒ the draft PR bases on the IMMEDIATE
   * ancestor's PR-head branch (the LAST stack entry) — a true stacked PR showing only this
   * run's delta over its ancestor. Empty/absent (a non-speculative run) ⇒ `default_branch`.
   */
  ancestorStack?: AncestorStack;
  runBranch?: string;
  title: string;
  body?: string;
  githubCredentialRef?: string;
  projectConfig?: Record<string, unknown>;
  timeoutMs: number;
  /** org App installation; when set, prefer minting an App token. */
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
}

export interface PublishDraftPullRequestForRunInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  ssh: CommandSubstrate;
  runId: string;
  githubCredentialRef?: string;
  identitySecretRef: string;
  workspacePath?: string;
  title?: string;
  body?: string;
  timeoutMs: number;
  /** shared installation-token minter (cache lives here). */
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

/**
 * walker-jj-local-integration-design.md §3.1: resolve the draft PR's base branch. When the
 * run carries a NON-EMPTY ancestor stack, the base is the IMMEDIATE ancestor's PR-head
 * branch (the LAST stack entry) — a true human-stacked PR (GitHub then renders only this
 * run's delta over its ancestor). An empty stack (a non-speculative run) ⇒ `fallbackBase`
 * (the run's `default_branch`).
 */
export function resolveDraftPrBaseBranch(fallbackBase: string, ancestorStack: AncestorStack | undefined): string {
  if (ancestorStack === undefined || ancestorStack.length === 0) {
    return fallbackBase;
  }
  const immediateAncestor = ancestorStack.at(-1);
  // A stack member with a blank branch cannot be a PR base — fall back rather than open
  // against "" (the bootstrap write-back fills the branch, so this is defensive).
  return immediateAncestor !== undefined && immediateAncestor.branch !== "" ? immediateAncestor.branch : fallbackBase;
}

export async function publishDraftPullRequest(input: PublishDraftPullRequestInput): Promise<PublishedDraftPullRequest> {
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const context = eventContext(input);
  const branch = draftPrBranchName({ runId: input.runId, requestedBranch: input.runBranch });
  // §3.1 stacked-PR base: the immediate-ancestor PR-head branch when flag-on + stacked,
  // else today's `targetBranch`. The persisted/event `targetBranch` reflects the BASE the
  // PR actually opened against.
  const baseBranch = resolveDraftPrBaseBranch(input.targetBranch, input.ancestorStack);
  // With an App installation the static ref is optional; the ledger label is
  // the App credential ref in that case.
  const staticRef =
    input.installation === undefined ? githubCredentialRefFromInput(input) : credentialRefOrUndefined(input);
  const ledgerRef = input.installation?.credentialRef ?? staticRef ?? "github_app";

  // §5a/PR-2: token resolution is credential PLUMBING, not a forge op — resolve through
  // the standalone `resolveVcsToken(http, creds)` over the provider's existing client,
  // off the `VcsProvider` interface. §5c: the runner-workspace branch push stays a
  // WORKSPACE HELPER (`pushWorkspaceBranchToGitHub`) — it is an SSH-over-runner concern
  // (needs `ssh`/`target`/`workspacePath`), NOT a host-API op, so it is kept out of the
  // `CodeHost` seam. The draft-PR OPEN moves onto the `VisibilityProjection` (the raw
  // `GitHubVisibilityProjection.openOrUpdateChangeRequest`): the run-path open is the
  // AUTHORITATIVE PR artifact (its url is persisted + gates the merge stage), so it uses
  // the RAW projection that THROWS on failure — NOT the hardened `SafeVisibilityProjection`
  // (which can never throw); a failed open must propagate, not silently skip.
  const http = gitHubHttpOf(input.vcsProvider);
  const repo = parseGitHubRepository(input.repoUrl);

  try {
    await eventStore.append({
      ...context,
      eventType: "credential.requested",
      payload: redactedGithubTokenResult(ledgerRef),
    });
    const resolved = await resolveVcsToken(http, {
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
    await pushWorkspaceBranchToGitHub({
      ssh: input.ssh,
      target: input.target,
      workspacePath: input.workspacePath,
      repoUrl: input.repoUrl,
      branch,
      token: resolved.token,
      timeoutMs: input.timeoutMs,
      sourceRef: input.sourceRef,
    });
    await eventStore.append({
      ...context,
      eventType: "github.branch.pushed",
      payload: { repoUrl: input.repoUrl, branch, credentialRef: ledgerRef, redacted: true },
    });

    const visibility = new GitHubVisibilityProjection(http, async () => resolved);
    const pr = await visibility.openOrUpdateChangeRequest({
      repoFullName: `${repo.owner}/${repo.name}`,
      headBranch: branch,
      baseBranch,
      title: input.title,
      ...(input.body !== undefined && { body: input.body }),
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
        targetBranch: baseBranch,
        prUrl: pr.url,
        prNumber: pr.number,
      },
    });
    return { branch, prUrl: pr.url, prNumber: pr.number };
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
    target: sshRunnerHandle({
      host: context.runner.sshHost,
      port: context.runner.sshPort,
      username: "tanren",
      hostKeyFingerprint: context.runner.hostKeyFingerprint,
      identitySecretRef: input.identitySecretRef,
    }),
    runId: context.runId,
    specId: context.specId,
    projectId: context.projectId,
    workspacePath: input.workspacePath ?? workspaceRepoPathForRun(context.runId),
    repoUrl: context.repoUrl,
    // §3.1: the run's base is `default_branch`; when the run is stacked (a non-empty
    // ancestor stack), `publishDraftPullRequest` re-resolves the base to the immediate
    // ancestor's PR-head branch (a true stacked PR) — so the operator
    // `POST /runs/:id/github/draft-pr` route opens the same base the autonomous loop does.
    targetBranch: context.defaultBranch,
    ...(context.ancestorStack !== undefined && { ancestorStack: context.ancestorStack }),
    runBranch: context.branch,
    // GitHub rejects an EMPTY PR title with 422 (`missing_field: title`) — proven live
    // on apex v31. `??` does NOT catch an empty string, so an empty `input.title` (a
    // deploy spec resolved one) flowed straight through. Coalesce on BLANK (trim), and
    // end on a spec-id fallback that is structurally never empty.
    title:
      (input.title?.trim() ? input.title.trim() : undefined) ??
      (context.specTitle?.trim() ? `Tanren: ${context.specTitle.trim()}` : `Tanren change ${context.specId}`),
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
  const row = result.rows[0] as DraftPrRunRow | undefined;
  if (row === undefined) {
    return undefined;
  }
  // Re-hydrate the ordered ancestor stack from `runs.ancestor_stack` (the jj-local base
  // source). Empty for a non-speculative run. The stacked-PR base reads it so the operator
  // route opens the same base the loop does.
  const ancestorStack = resolveAncestorStack({ ancestorStack: row.ancestor_stack });
  return {
    runId: row.run_id,
    specId: row.spec_id,
    projectId: row.project_id,
    branch: row.branch,
    ...(ancestorStack.length > 0 && { ancestorStack }),
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
  // App-installed run: the static ref is OPTIONAL. The App sentinel is an
  // EMPTY-STRING ref (a present-but-empty string, not `undefined`) — collapse it
  // (and any whitespace-only value) to "no static ref" so the run mints the App
  // token, NEVER pushing `""` through the grammar validator (apex v30 crash).
  return normalizeStaticGithubRef(typeof configured === "string" ? configured : undefined);
}

function eventContext(input: PublishDraftPullRequestInput) {
  return { runId: input.runId, specId: input.specId, projectId: input.projectId };
}

interface DraftPrRunContext {
  runId: string;
  specId: string;
  projectId: string;
  branch: string;
  /** §3.1: the ordered ancestor stack (the stacked-PR base source), when speculative. */
  ancestorStack?: AncestorStack;
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
  ancestor_stack: unknown;
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

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
