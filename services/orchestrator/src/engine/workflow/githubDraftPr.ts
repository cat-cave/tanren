/* eslint-disable import/max-dependencies -- draft PR publication composes the canonical tenant, event, runner, and GitHub seams */
import type { OrgGithubAppInstallation } from "../config/orgConfig.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import { sshRunnerHandle } from "../contracts/allocator.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { normalizeStaticGithubRef, redactedGithubTokenResult } from "../credentials/githubToken.js";
import { canonicalOrgGithubCredentialRef } from "../credentials/refNamespace.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { GitHubHttpClient } from "../providers/github.js";
import { resolveVcsToken } from "../credentials/vcsCredentials.js";
import { GitHubVisibilityProjection } from "../providers/githubVisibilityProjection.js";
import { parseGitHubRepository } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { workspaceRepoPathForRun } from "../workspace/index.js";
import { draftPrBranchName, pushWorkspaceBranchToGitHub } from "../workspace/githubPush.js";
import type { AncestorStack } from "../dag/ancestorStack.js";
import { publishDraftPullRequestWithDurableLease, resolveBoundManualDraftPrHead } from "./githubDraftPrDurableLease.js";
import {
  completeDraftPushIntent,
  findPendingDraftPushIntent,
  prepareDraftPushIntent,
} from "./githubDraftPrPushIntent.js";
import { requireDraftPrPublishedHead, resolveDraftPrBaseBranch } from "./githubDraftPrBase.js";
import { appendPushedWitnessWithReconciliation } from "./githubDraftPrWitness.js";
import { messageFromError } from "./githubDraftPrHelpers.js";
import { loadDraftPrRunContext, type RunStateClient } from "./githubDraftPrRunContext.js";

export { resolveDraftPrBaseBranch } from "./githubDraftPrBase.js";

export interface PublishDraftPullRequestInput {
  pool: RunStateClient;
  eventStore?: EventStore;
  /** Merge-stage callers write `pr_url` through the de-privileged state writer. */
  runStateWriter?: RunStateWriter;
  orgId?: string | null;
  secrets: SecretStore;
  /** The shared (timed) GitHub HTTP client the draft-PR open + token resolution build over. */
  githubHttp: GitHubHttpClient;
  ssh: CommandSubstrate;
  target: RunnerHandle;
  runId: string;
  specId: string;
  projectId: string;
  /** Required tenant key stamped on every appended event. */
  appendEventOrgId: string;
  workspacePath: string;
  repoUrl: string;
  targetBranch: string;
  /** A non-empty stack bases the PR on its immediate ancestor's PR-head branch. */
  ancestorStack?: AncestorStack;
  runBranch?: string;
  title: string;
  body?: string;
  githubCredentialRef?: string;
  /** org App installation; when set, prefer minting an App token. */
  installation?: OrgGithubAppInstallation;
  githubAppMinter?: GithubAppTokenMinter;
  /** The local gitref pushed as the PR branch (default "HEAD"). */
  sourceRef?: string;
  /** The validated commit that was pushed from `sourceRef`, when the caller has one. */
  publishedHeadSha?: string;
  expectedPublishedHeadSha?: string;
  /** Legacy non-atomic post-create enqueue seam; mutually exclusive with the production atomic seam. */
  enqueueAfterCreate?: (input: { prUrl: string; prNumber: number }) => Promise<void>;
  /**
   * ATOMICITY (PR #724 follow-up — apex v67/v69 root cause #2): when wired (the
   * production native_queue path through `mergeQueueEarlyEnqueueSeam`), this callback
   * owns the FULL post-PR-open atomic-write block: appends `github.pr.created`,
   * INSERTs the merge_queue row, and appends `merge.scheduled` — all inside ONE
   * `runWithOrgScope` so they commit or roll back as ONE unit. `publishDraftPullRequest`
   * SKIPS its inline `github.pr.created` append when this is wired (the callback owns
   * it), closing the crash-between-writes split brain where the durable event landed
   * but the queue row did not (PR #724's 3-separate-txn implementation leaked here).
   * MUTUALLY EXCLUSIVE with {@link enqueueAfterCreate}.
   */
  postPrCreatedAtomicWrites?: (input: {
    prUrl: string;
    prNumber: number;
    branch: string;
    baseBranch: string;
  }) => Promise<void>;
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
  /** The shared (timed) GitHub HTTP client the draft-PR open + token resolution build over. */
  githubHttp: GitHubHttpClient;
  ssh: CommandSubstrate;
  runId: string;
  identitySecretRef: string;
  workspacePath?: string;
  title?: string;
  body?: string;
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
export async function publishDraftPullRequest(input: PublishDraftPullRequestInput): Promise<PublishedDraftPullRequest> {
  const eventStore = input.eventStore ?? new PgEventStore(input.pool);
  const context = eventContext(input);
  const branch = draftPrBranchName({ runId: input.runId, requestedBranch: input.runBranch });
  const publishedHeadSha = requireDraftPrPublishedHead({
    branch,
    sourceRef: input.sourceRef,
    publishedHeadSha: input.publishedHeadSha,
  });
  // §3.1 stacked-PR base; the persisted target reflects the actual PR base.
  const baseBranch = resolveDraftPrBaseBranch(input.targetBranch, input.ancestorStack);
  // With an App installation the static ref is optional; the ledger label is
  // the App credential ref in that case.
  const suppliedStaticRef =
    input.installation === undefined ? githubCredentialRefFromInput(input) : credentialRefOrUndefined(input);
  const staticRef =
    suppliedStaticRef === undefined
      ? undefined
      : canonicalOrgGithubCredentialRef({
          orgId: input.appendEventOrgId,
          supplied: suppliedStaticRef,
          kind: "github_token",
        });
  const installation =
    input.installation === undefined
      ? undefined
      : {
          ...input.installation,
          credentialRef: canonicalOrgGithubCredentialRef({
            orgId: input.appendEventOrgId,
            supplied: input.installation.credentialRef,
            kind: "github_app",
          }),
        };
  const ledgerRef = installation?.credentialRef ?? staticRef ?? "github_app";

  // §5a/PR-2: token resolution is credential plumbing. The runner-workspace branch push stays a
  // workspace helper (`pushWorkspaceBranchToGitHub`) — it is an SSH-over-runner concern
  // (needs `ssh`/`target`/`workspacePath`), NOT a host-API op, so it is kept out of the
  // `CodeHost` seam. The draft-PR OPEN moves onto the `VisibilityProjection` (the raw
  // `GitHubVisibilityProjection.openOrUpdateChangeRequest`): the run-path open is the
  // AUTHORITATIVE PR artifact (its url is persisted + gates the merge stage), so it uses
  // the RAW projection that THROWS on failure — NOT the hardened `SafeVisibilityProjection`
  // (which can never throw); a failed open must propagate, not silently skip.
  const http = input.githubHttp;
  const repo = parseGitHubRepository(input.repoUrl);

  try {
    await eventStore.append({
      ...context,
      eventType: "credential.requested",
      payload: redactedGithubTokenResult(ledgerRef),
    });
    const resolved = await resolveVcsToken(http, {
      secrets: input.secrets,
      orgId: input.appendEventOrgId,
      installation,
      staticRef,
      minter: input.githubAppMinter,
    });
    await eventStore.append({
      ...context,
      eventType: "credential.loaded",
      payload: redactedGithubTokenResult(ledgerRef),
    });
    const preparedIntent = await prepareDraftPushIntent({
      pool: input.pool,
      context: {
        orgId: input.appendEventOrgId,
        projectId: input.projectId,
        runId: input.runId,
        specId: input.specId,
        repoUrl: input.repoUrl,
        branch,
      },
      intendedSha: publishedHeadSha,
      sourceRef: publishedHeadSha,
      expectedPublishedHeadSha: input.expectedPublishedHeadSha,
      http,
      repo,
      token: resolved.token,
    });
    if (!("alreadyPublished" in preparedIntent.forceWithLease)) {
      await pushWorkspaceBranchToGitHub({
        ssh: input.ssh,
        target: input.target,
        workspacePath: input.workspacePath,
        repoUrl: input.repoUrl,
        branch,
        token: resolved.token,
        sourceRef: preparedIntent.intent.sourceRef,
        forceWithLease: preparedIntent.forceWithLease,
      });
    }
    const pushedEvent = {
      runId: preparedIntent.intent.runId,
      specId: preparedIntent.intent.specId,
      projectId: preparedIntent.intent.projectId,
      orgId: preparedIntent.intent.orgId,
      eventType: "github.branch.pushed" as const,
      payload: {
        repoUrl: input.repoUrl,
        branch,
        headSha: preparedIntent.intent.intendedSha,
        sourceRef: preparedIntent.intent.sourceRef,
        credentialRef: ledgerRef,
        redacted: true as const,
      },
    };
    await appendPushedWitnessWithReconciliation({
      eventStore,
      event: pushedEvent,
      http,
      repo,
      branch,
      token: resolved.token,
      publishedHeadSha: preparedIntent.intent.intendedSha,
      idempotencyKey: `${preparedIntent.intent.runId}:github.branch.pushed:${branch}:${preparedIntent.intent.intendedSha}`,
    });
    // The intent remains pending if witness append throws. This update is deliberately
    // after the sole event-store witness authority, so a restart can reconcile the
    // remote CAS and re-drive the same immutable SHA.
    await completeDraftPushIntent(input.pool, preparedIntent.intent, preparedIntent.intent.intendedSha);

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
    // ATOMICITY FIX (PR #724 follow-up — apex v67/v69 root cause #2): when the seam wired
    // the atomic 3-write block (`postPrCreatedAtomicWrites`), DELEGATE the `github.pr.created`
    // append to it so all three post-PR-open writes share ONE transaction (append + INSERT +
    // append). PR #724 fired this inline append BEFORE the enqueue's separate transaction —
    // a crash/pool blip between them resurrected the original apex v67/v69 bug (durable PR
    // event + zero queue row + orphan PR). The `else` keeps the legacy non-atomic path for
    // tests / non-native-queue projects that have no queue write to co-commit with.
    if (input.postPrCreatedAtomicWrites === undefined) {
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
      // LEGACY non-atomic path: the merge_queue enqueue happens HERE (right after the
      // inline github.pr.created append). Used only when the seam injected the legacy
      // `enqueueAfterCreate` (test / no-DB run); the production path takes the atomic branch.
      if (input.enqueueAfterCreate !== undefined) {
        await input.enqueueAfterCreate({ prUrl: pr.url, prNumber: pr.number });
      }
    } else {
      await input.postPrCreatedAtomicWrites({ prUrl: pr.url, prNumber: pr.number, branch, baseBranch });
    }
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
  const workspacePath = input.workspacePath ?? workspaceRepoPathForRun(context.runId);
  const target = sshRunnerHandle({
    host: context.runner.sshHost,
    port: context.runner.sshPort,
    username: "tanren",
    hostKeyFingerprint: context.runner.hostKeyFingerprint,
    identitySecretRef: input.identitySecretRef,
  });
  const pendingIntent = await findPendingDraftPushIntent(input.pool, {
    orgId: context.orgId,
    projectId: context.projectId,
    runId: context.runId,
    specId: context.specId,
    repoUrl: context.repoUrl,
    branch: context.branch,
  });
  const { predecessorSha: durablePredecessor, headSha: publishedHeadSha } =
    pendingIntent === undefined
      ? await resolveBoundManualDraftPrHead({
          pool: input.pool,
          orgId: context.orgId,
          specId: context.specId,
          branch: context.branch,
          repoUrl: context.repoUrl,
          ssh: input.ssh,
          target,
          workspacePath,
        })
      : {
          predecessorSha: pendingIntent.leasePredecessorSha,
          headSha: pendingIntent.intendedSha,
        };

  return await publishDraftPullRequestWithDurableLease(
    {
      pool: input.pool,
      eventStore: input.eventStore,
      orgId: context.orgId,
      appendEventOrgId: context.orgId,
      secrets: input.secrets,
      githubHttp: input.githubHttp,
      ssh: input.ssh,
      target,
      runId: context.runId,
      specId: context.specId,
      projectId: context.projectId,
      workspacePath,
      repoUrl: context.repoUrl,
      targetBranch: context.defaultBranch,
      ...(context.ancestorStack !== undefined && { ancestorStack: context.ancestorStack }),
      runBranch: context.branch,
      sourceRef: publishedHeadSha,
      publishedHeadSha,
      title:
        (input.title?.trim() ? input.title.trim() : undefined) ??
        (context.specTitle?.trim() ? `Tanren: ${context.specTitle.trim()}` : `Tanren change ${context.specId}`),
      body: input.body ?? context.specDescription,
      githubCredentialRef: context.configuredGithubCredentialRef,
      installation: context.installation,
      githubAppMinter: input.githubAppMinter,
    },
    {
      orgId: context.orgId,
      specId: context.specId,
      branch: context.branch,
      expectedPublishedHeadSha: durablePredecessor,
      predecessorEstablished: true,
    },
    publishDraftPullRequest,
  );
}

function githubCredentialRefFromInput(input: PublishDraftPullRequestInput): string {
  // Callers MUST pass githubCredentialRef directly; projectConfig fallback was removed.
  if (typeof input.githubCredentialRef !== "string") {
    throw new TypeError("GitHub credential ref is required");
  }
  return input.githubCredentialRef;
}

function credentialRefOrUndefined(input: PublishDraftPullRequestInput): string | undefined {
  // Collapse the App's empty sentinel so it mints a token instead of reaching ref validation.
  return normalizeStaticGithubRef(input.githubCredentialRef);
}

function eventContext(input: PublishDraftPullRequestInput) {
  return {
    runId: input.runId,
    specId: input.specId,
    projectId: input.projectId,
    orgId: input.appendEventOrgId,
  };
}
