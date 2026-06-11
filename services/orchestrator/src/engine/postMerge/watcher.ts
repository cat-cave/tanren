// Post-merge auto-issue creation (tempering.md dimension A — the last core
// run-loop item). After a run's PR merges onto `default_branch`, this watcher
// reads the post-merge CI on the BASE branch (the host `readBranchChecks` read —
// §5e, still a host read — + the SAME `evaluateCiObservation` evaluator the
// run/queue CI poll uses) for the merge commit. When that CI FAILS, it auto-opens
// ONE tracking issue through the best-effort `VisibilityProjection.openTrackingIssue?`
// seam (tanren-owns-the-engine.md §6) so the regression is tracked, then records
// `merge.post_merge_failed` + `issue.opened`. The projection is `harden`-severed, so
// a host with no issue support resolves `skipped` (the watcher tolerates it, §4) and a
// transient forge error resolves `failed` (the claim is released so a later wake retries).
//
// It reuses the existing seams — NOT a new poller: the subscriber wakes it on the
// SAME run-activity bus the DagWalker / MergeCoordinator listen on, and it only
// acts once a run has a `merge.completed` event (the authoritative merge signal,
// which carries the merge sha). Token resolution + base-branch state route through
// the VcsProvider; the run context loads through the shared review/merge loader.
//
// IDEMPOTENCY (open at most ONE issue per merge, never spam): before filing, the
// watcher checks for a prior `issue.opened` event on the run — present ⇒ it already
// filed (or the post-merge CI already failed once and was tracked) and returns
// without a second issue. A pending post-merge CI files nothing and leaves no
// marker, so the NEXT bus wake re-checks; a passing post-merge CI files nothing.
// Only a genuine FAILURE files an issue + records the marker.

import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { orgScopeFromRunOrgId, resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import type { EventStore } from "../eventStore.js";
import { PgEventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { RepoRef, ResolvedVcsToken, VcsProvider } from "../contracts/vcsProvider.js";
import type { ProjectedTrackingIssue, SafeVisibilityProjection } from "../contracts/visibilityProjection.js";
import { parseGitHubPullRequestUrl } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { buildProjectHostSeams } from "../providers/hostFactory.js";
import { vcsCredentialHttp } from "../credentials/vcsCredentialHttp.js";
import { type ActiveQuarantine, loadActiveQuarantine } from "../workflow/ciQuarantine.js";
import { evaluateCiObservation, type CiObservation } from "../workflow/ciObservation.js";
import { loadReviewMergeRunContext, type ReviewMergeRunContext } from "../workflow/reviewMerge/context.js";
import { PgPostMergeIssueClaimStore, type PostMergeIssueClaimStore } from "./issueClaimStore.js";

/** The label every auto-filed post-merge-failure tracking issue carries. */
export const POST_MERGE_FAILURE_LABEL = "tanren:post-merge-failure";

export interface PostMergeWatcherDeps {
  /** The runtime (`tanren_app`) pool. The watcher re-reads under the system scope. */
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  /** Shared App installation-token minter (cache lives here), when an App is installed. */
  githubAppMinter?: GithubAppTokenMinter;
  /** Injectable for tests; defaults to a `PgEventStore` over `pool`. */
  eventStore?: EventStore;
  /**
   * Plane-split (autonomy loops): the control-plane run-state writer. When present
   * (remote-writes on), the watcher's two `events` appends route through the
   * control plane (the de-privileged data plane can no longer write `events`
   * directly); absent, in-process via `PgEventStore`. Used as the `eventStore`
   * when no explicit `eventStore` is injected (a test injects its own recorder).
   */
  runStateWriter?: RunStateWriter;
  /**
   * The CROSS-PROCESS atomic file-once guard. Injectable for tests; defaults to the
   * `PgPostMergeIssueClaimStore` over `pool`. Exactly one process across the fleet
   * wins `claim()` per merged run, so only one tracking-issue publish ever fires.
   */
  claimStore?: PostMergeIssueClaimStore;
  /**
   * Build the best-effort `VisibilityProjection` the tracking issue is published
   * through, given the run's resolved token. Injectable for tests (a fake projection);
   * defaults to `buildProjectHostSeams(vcsCredentialHttp(vcsProvider), …).visibility`
   * — the hardened (never-rejecting) seam over the SAME GitHub HTTP client the run's
   * `VcsProvider` already holds, with the per-run token supplier.
   */
  buildVisibility?: (token: ResolvedVcsToken) => SafeVisibilityProjection;
}

/** The authoritative merge signal for a run: its `merge.completed` event. */
interface MergeRecord {
  prNumber: number;
  mergeSha?: string;
}

/**
 * The post-merge watcher. `check(runId)` is the per-run pass the subscriber drives
 * on each bus wake. It is a no-op unless the run merged; it opens at most one issue
 * per merge.
 */
export class PostMergeWatcher {
  private readonly eventStore: EventStore;
  private readonly claimStore: PostMergeIssueClaimStore;

  constructor(private readonly deps: PostMergeWatcherDeps) {
    // Plane-split: prefer an explicitly injected eventStore (tests), then the
    // control-plane writer when wired (remote-writes on — the writer IS an
    // EventStore), then the in-process PgEventStore (single-role dev, unchanged).
    this.eventStore = deps.eventStore ?? deps.runStateWriter ?? new PgEventStore(deps.pool);
    this.claimStore = deps.claimStore ?? new PgPostMergeIssueClaimStore(deps.pool);
  }

  /**
   * The best-effort `VisibilityProjection` the tracking issue is published through,
   * for the run's resolved token. Defaults to the hardened host seam over the run's
   * GitHub HTTP client (`buildProjectHostSeams` — never-rejecting, §6); a test injects
   * its own factory. Built per call so the token supplier carries the per-run token.
   */
  private buildVisibility(token: ResolvedVcsToken): SafeVisibilityProjection {
    if (this.deps.buildVisibility !== undefined) {
      return this.deps.buildVisibility(token);
    }
    return buildProjectHostSeams(vcsCredentialHttp(this.deps.vcsProvider), async () => token).visibility;
  }

  /**
   * Evaluate one run's post-merge state. Returns without effect when the run has
   * not merged, when this merge's issue is already claimed/filed, or when the
   * post-merge CI is pending/passing. Files exactly one issue on a genuine failure
   * — and across an N-process fleet, the atomic claim guarantees exactly one
   * `createIssue` even when many workers wake on the same `merge.completed` NOTIFY.
   */
  async check(runId: string): Promise<void> {
    if (runId === "") return;
    // Not merged yet — nothing to watch.
    const merge = await this.loadMergeRecord(runId);
    if (merge === undefined) return;
    // Cheap fast-path: this merge's issue was already claimed/filed — skip the
    // base-branch CI read entirely. Only an optimization; the atomic claim below is
    // the real guard, so a stale `false` here can never cause a duplicate.
    if (await this.claimStore.exists(runId)) return;

    const context = await this.loadContext(runId);
    if (context === undefined) return;

    const resolved = await this.resolveToken(context);
    // Derive the repo from the PR ref (robust for a `.../pull/N` URL). Pure helper
    // (§5b) — a URL→`{repo,number}` parse, no provider state.
    const repo = parseGitHubPullRequestUrl(context.prUrl).repo;
    const checks = await this.deps.vcsProvider.readBranchChecks({
      repo,
      branch: context.baseBranch,
      token: resolved,
    });
    // Resolve the org FIRST so the CI-intelligence quarantine read is org-scoped: a
    // proven-flaky base-branch check on the project's ACTIVE quarantine surface is
    // EXCLUDED from the failure verdict, so a known-flaky post-merge check no longer
    // auto-opens a spurious regression issue. orgId-absent ⇒ no scoped read ⇒ no
    // exclusion (the strict default), and the issue-claim below needs it regardless.
    const orgId = await this.resolveOrg(context.projectId);
    if (orgId === undefined) return;
    const quarantine = await this.loadQuarantine(orgId, context.projectId);
    const observation = evaluateCiObservation(checks, { quarantinedCheckNames: quarantine.checkNames });
    // ONLY a genuine FAILURE files an issue. Pending → leave for the next wake;
    // passed → nothing to track. Never an issue on a non-failure. The claim is taken
    // ONLY here (after a confirmed failure), so a pass/pending never consumes it.
    if (observation.status !== "failed") return;

    // The CROSS-PROCESS atomic lock: exactly one waking worker wins; the rest skip.
    const won = await this.claimStore.claim({
      runId,
      specId: context.specId,
      projectId: context.projectId,
      orgId,
    });
    if (!won) return;

    await this.fileTrackingIssue({ runId, orgId, context, repo, token: resolved, merge, observation });
  }

  /** Read the run's `merge.completed` event (the authoritative merge signal), system-scoped. */
  private async loadMergeRecord(runId: string): Promise<MergeRecord | undefined> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ payload: unknown }>(
        `SELECT payload FROM events
           WHERE run_id = $1 AND event_type = 'merge.completed'
           ORDER BY ts DESC, id DESC
           LIMIT 1`,
        [runId],
      );
      const payload = result.rows[0]?.payload;
      if (payload === null || typeof payload !== "object") return;
      const record = payload as { prNumber?: unknown; mergeSha?: unknown };
      if (typeof record.prNumber !== "number") return;
      return {
        prNumber: record.prNumber,
        ...(typeof record.mergeSha === "string" && { mergeSha: record.mergeSha }),
      };
    });
  }

  /** Resolve the run's project org (for the org-scoped atomic claim), system-scoped. */
  private async resolveOrg(projectId: string): Promise<string | undefined> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? undefined;
    });
  }

  /**
   * Load the project's ACTIVE flaky-quarantine, ORG-SCOPED (`quarantined_tests` is
   * a tenant table — RLS denies by default, so the read MUST carry the org GUC).
   * Used to EXCLUDE a proven-flaky base-branch check from the post-merge failure
   * verdict. A load failure fails OPEN (empty quarantine ⇒ the verdict stays strict),
   * never bricking the watcher on an enrichment read.
   */
  private async loadQuarantine(orgId: string, projectId: string): Promise<ActiveQuarantine> {
    try {
      return await runWithOrgScope(this.deps.pool, orgId, (client) => loadActiveQuarantine(client, projectId));
    } catch (error) {
      console.error(
        `[post-merge] active-quarantine load failed for project ${projectId} (verdict stays strict):`,
        error,
      );
      return { checkNames: new Set<string>(), testIds: [] };
    }
  }

  /** Load the review/merge run context (prUrl, baseBranch=default_branch, credentials), system-scoped. */
  private async loadContext(runId: string): Promise<ReviewMergeRunContext | undefined> {
    const githubCredentialRef = await this.resolveGithubCredentialRef(runId);
    return runWithSystemScope(this.deps.pool, async (client) =>
      loadReviewMergeRunContext(client, runId, { resolvedGithubCredentialRef: githubCredentialRef }),
    );
  }

  /** Resolve the run's effective GitHub credential ref using the same project→org-default chain as merge. */
  private async resolveGithubCredentialRef(runId: string): Promise<string> {
    const base = await runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{
        org_id: string | null;
        project_id: string | null;
        spec_id: string | null;
        config: unknown;
      }>(
        `SELECT r.org_id, r.project_id, r.spec_id, p.config
           FROM runs r JOIN projects p ON p.project_id = r.project_id
          WHERE r.run_id = $1`,
        [runId],
      );
      return result.rows[0];
    });
    if (base === undefined || base.org_id === null || base.project_id === null || base.spec_id === null) {
      throw new Error(`cannot check post-merge state: run ${runId} has no resolvable org/project/spec`);
    }
    const orgId = base.org_id;
    const projectConfig = migrateProjectConfig(base.config);
    const credentials = await runWithOrgScope(this.deps.pool, orgId, (client) =>
      resolveCredentialsForRun(client, { projectConfig, orgScope: orgScopeFromRunOrgId(orgId) }),
    );
    return credentials.githubCredentialRef;
  }

  private async resolveToken(context: ReviewMergeRunContext) {
    return this.deps.vcsProvider.resolveToken({
      secrets: this.deps.secrets,
      ...(context.installation !== undefined && { installation: context.installation }),
      ...(context.staticCredentialRef !== undefined && { staticRef: context.staticCredentialRef }),
      ...(this.deps.githubAppMinter !== undefined && { minter: this.deps.githubAppMinter }),
    });
  }

  /**
   * Open the single tracking issue through the best-effort `VisibilityProjection`
   * (the `openTrackingIssue?` seam — tanren-owns-the-engine.md §6), then mark the
   * claim `filed` + record the two events. The claim is ALREADY held (this process
   * won it). The projection is `harden`-severed, so a publish failure surfaces as a
   * `ProjectionOutcome` rather than a throw:
   *   - `projected` ⇒ the issue opened: settle the claim `filed` + record the events.
   *   - `failed`    ⇒ a transient forge error: RELEASE the claim so a later wake
   *                   re-claims + retries — never permanently suppressed.
   *   - `skipped`   ⇒ the host provides no `openTrackingIssue` (no issue support):
   *                   there is nothing to file, so RELEASE the claim and return —
   *                   the watcher tolerates a projection without issue support (§4).
   */
  private async fileTrackingIssue(args: {
    runId: string;
    orgId: string;
    context: ReviewMergeRunContext;
    repo: RepoRef;
    token: ResolvedVcsToken;
    merge: MergeRecord;
    observation: CiObservation;
  }): Promise<void> {
    const { runId, orgId, context, repo, token, merge, observation } = args;
    const failingChecks = observation.failingChecks.map((c) => ({
      kind: c.kind,
      name: c.name,
      state: c.state,
      ...(c.url !== undefined && { url: c.url }),
    }));
    const title = `Post-merge CI failed on ${context.baseBranch} after merging ${context.specId} (PR #${merge.prNumber})`;
    const body = renderIssueBody({ context, merge, failingChecks, runId });
    const visibility = this.buildVisibility(token);
    const outcome = await visibility.openTrackingIssue({
      repoFullName: `${repo.owner}/${repo.name}`,
      title,
      body,
      labels: [POST_MERGE_FAILURE_LABEL],
    });
    if (outcome.kind !== "projected") {
      // `failed` (transient) or `skipped` (no issue support): release the claim so a
      // later wake re-claims (a transient error retries; a host without issue support
      // simply re-skips, never permanently suppressed). Nothing is recorded — the
      // `issue.opened`/`merge.post_merge_failed` events need the opened handle.
      await this.claimStore.release(runId);
      if (outcome.kind === "failed") {
        throw new Error(`post-merge tracking-issue publish failed: ${outcome.error}`);
      }
      return;
    }
    const issue: ProjectedTrackingIssue = outcome.value;
    // The issue opened: settle the claim to `filed` (the durable terminal marker).
    await this.claimStore.markFiled(runId, { url: issue.url, number: issue.number });

    const base = {
      runId,
      specId: context.specId,
      projectId: context.projectId,
    };
    // The watcher runs with NO ambient org scope (it wakes on the run-activity bus,
    // and the inner system-scoped reads above already closed), so these two tenant
    // `events` writes would hit the H2 throw (no scope → MissingOrgScopeError),
    // which the subscriber catches/logs — the issue would be created on GitHub but
    // these run-timeline events silently lost. `orgId` is already resolved (the
    // atomic-claim org) at the call site, so append them under the run's per-job org
    // id: each `eventStore.append` opens a short `runWithOrgScope` carrying the GUC.
    await runWithJobOrgId(orgId, async () => {
      await this.eventStore.append({
        ...base,
        eventType: "merge.post_merge_failed",
        payload: {
          prUrl: context.prUrl,
          prNumber: merge.prNumber,
          specId: context.specId,
          baseBranch: context.baseBranch,
          ...(merge.mergeSha !== undefined && { mergeSha: merge.mergeSha }),
          failingChecks,
        },
      });
      await this.eventStore.append({
        ...base,
        eventType: "issue.opened",
        payload: {
          reason: "post_merge_failure",
          issueNumber: issue.number,
          issueUrl: issue.url,
          prUrl: context.prUrl,
          label: POST_MERGE_FAILURE_LABEL,
        },
      });
    });
  }
}

/** Render the tracking-issue body: the failing checks + links to the merged PR + the run. */
function renderIssueBody(args: {
  context: ReviewMergeRunContext;
  merge: MergeRecord;
  failingChecks: ReadonlyArray<{ kind: string; name: string; state: string; url?: string }>;
  runId: string;
}): string {
  const { context, merge, failingChecks, runId } = args;
  const lines = [
    `The post-merge CI on \`${context.baseBranch}\` failed after merging spec \`${context.specId}\`.`,
    "",
    `- Merged PR: ${context.prUrl} (#${merge.prNumber})`,
    `- Run: \`${runId}\``,
    `- Spec: \`${context.specId}\``,
    ...(merge.mergeSha === undefined ? [] : [`- Merge commit: \`${merge.mergeSha}\``]),
    "",
    "Failing post-merge checks:",
    ...failingChecks.map((c) => `- ${c.name} (${c.state})${c.url === undefined ? "" : ` — ${c.url}`}`),
    "",
    "_Auto-filed by Tanren post-merge watcher._",
  ];
  return lines.join("\n");
}
