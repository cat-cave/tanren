// The pg + VcsProvider-backed BatchChecker (autonomy-engine.md §2d — speculative
// batch-check). It assembles the PROSPECTIVE MERGED STATE for a batch of queued
// entries — `default_branch + each entry's PR branch` speculatively merged in DAG
// order onto an EPHEMERAL batch-integration ref (reuse the P2c-1
// `VcsProvider.buildIntegrationBranch`) — then runs the CI/gate against that ref
// (the `VcsProvider.readBranchChecks` seam + the EXACT `evaluateCiObservation`
// reducer the run loop uses). It NEVER touches `default_branch`; only the ephemeral
// `tanren/batch/<dependent>` ref is written + read.
//
// Resolution mirrors PgSpeculativeIntegrator: repo + default_branch from the project,
// the App installation from the org, the static github credential ref from
// project/org config, each entry's branch = its latest run branch (the PR head
// branch). The batch ref is named for the LAST (deepest) member's spec so it is a
// stable, safe ref per batch tail.
//
// A still-RUNNING integration CI is reported `pending` (NOT a failure): the
// coordinator HOLDS (it does not bisect a not-yet-terminal batch) and the next
// CI-completion notification re-triggers the pass. The integration ref's own
// build-conflict (two entries conflict with each other) is surfaced as `conflict`.

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { type BatchCheckVerdict, type BatchChecker } from "../contracts/batchMergeCoordinator.js";
import type { MergeQueueEntry } from "../contracts/mergeCoordinator.js";
import { installationFromOrgConfig, migrateOrgConfig } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import { DEFAULT_NO_CHECKS_SETTLE_MS } from "../config/shared.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { IntegrationAncestor, VcsProvider } from "../contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { evaluateCiObservation } from "../workflow/ciPolling.js";
import { loadActiveQuarantinedCheckNames } from "../workflow/ciQuarantine.js";

/** The ephemeral batch-integration ref the prospective merged state is built on. */
export function batchIntegrationBranchName(tailSpecId: string): string {
  if (!/^spec_[A-Za-z0-9._-]+$/u.test(tailSpecId)) {
    throw new Error(`unsafe spec id for batch integration branch: ${tailSpecId}`);
  }
  return `tanren/batch/${tailSpecId}`;
}

interface BatchProjectRow {
  repo_url: string;
  default_branch: string;
  project_config: unknown;
  org_config: unknown;
}

interface BatchBranchRow {
  spec_id: string;
  branch: string;
}

export interface PgBatchCheckerDeps {
  pool: pg.Pool;
  vcsProvider: VcsProvider;
  secrets: SecretStore;
  githubAppMinter?: GithubAppTokenMinter;
  /**
   * Injectable wall clock (ms epoch) for the no-checks settle elapsed computation —
   * defaults to `Date.now`. Tests override it to drive the grace boundary
   * deterministically (mirrors the GithubAppTokenMinter clock seam).
   */
  now?: () => number;
}

export class PgBatchChecker implements BatchChecker {
  private readonly now: () => number;

  constructor(private readonly deps: PgBatchCheckerDeps) {
    this.now = deps.now ?? Date.now;
  }

  async checkBatch(input: { projectId: string; entries: ReadonlyArray<MergeQueueEntry> }): Promise<BatchCheckVerdict> {
    // An empty entry set checks the base (`default_branch`) alone — which passes (the
    // base is green) — the bisect's lower-bound invariant, no integration needed.
    if (input.entries.length === 0) {
      return { result: "pass", integrationBranch: "" };
    }

    // The batch HEAD entry: the tail (deepest) member's queue row — the SAME row the
    // integration ref is keyed on. The no-checks settle clock (`no_checks_since`) is
    // persisted on THIS row, so it is stable across integration-ref rebuilds AND starts
    // when checking begins (not at enqueue).
    const headEntry = input.entries.at(-1);
    if (headEntry === undefined) {
      return { result: "pass", integrationBranch: "" };
    }
    const tailSpecId = headEntry.specId;
    const headQueueId = headEntry.queueId;
    const integrationBranch = batchIntegrationBranchName(tailSpecId);

    const orgId = await this.resolveProjectOrg(input.projectId);
    if (orgId === null) {
      throw new Error(`cannot batch-check ${input.projectId}: project has no org`);
    }

    const { project, branches, quarantinedCheckNames } = await runWithOrgScope(
      this.deps.pool,
      orgId,
      async (client) => {
        const projectRow = await this.loadProject(client, input.projectId);
        const branchRows = await this.loadEntryBranches(
          client,
          input.entries.map((e) => e.specId),
        );
        // THE GATE READ (CI-intelligence PR2): the batch gate inherits the same
        // quarantine exclusion as the per-run gate — a proven-flaky check is excluded
        // from the prospective-merged-state verdict (a real failure still blocks).
        const quarantined = await loadActiveQuarantinedCheckNames(client, input.projectId);
        return { project: projectRow, branches: branchRows, quarantinedCheckNames: quarantined };
      },
    );

    // Order the entries' branches in the caller's DAG order — a missing branch is a
    // hard error (we never integrate a phantom). This is the prospective merge order.
    const branchBySpec = new Map(branches.map((b) => [b.spec_id, b.branch] as const));
    const ordered: IntegrationAncestor[] = input.entries.map((entry) => {
      const branch = branchBySpec.get(entry.specId);
      if (branch === undefined) {
        throw new Error(`batch entry ${entry.specId} has no run branch to integrate`);
      }
      return { specId: entry.specId, branch };
    });

    const installation = installationFromOrgConfig(project.org_config);
    const staticRef = resolveGithubStaticRef(project.project_config, project.org_config);
    const token = await this.deps.vcsProvider.resolveToken({
      secrets: this.deps.secrets,
      ...(installation !== undefined && { installation }),
      ...(staticRef !== undefined && { staticRef }),
      ...(this.deps.githubAppMinter !== undefined && { minter: this.deps.githubAppMinter }),
    });
    const repo = this.deps.vcsProvider.parseRepository(project.repo_url);

    // 1. Build the prospective merged state on the ephemeral batch ref (NEVER main).
    const integration = await this.deps.vcsProvider.buildIntegrationBranch({
      repo,
      token,
      baseBranch: project.default_branch,
      integrationBranch,
      ancestors: ordered,
    });
    if (integration.outcome === "conflict") {
      // A real integration conflict is a definitive non-no_checks verdict — CLEAR the
      // no-checks clock so a later transient no_checks restarts the grace from scratch.
      await this.clearNoChecksSince(orgId, headQueueId);
      return {
        result: "conflict",
        message: integration.message,
        ...(integration.conflictBetween !== undefined && { conflictBetween: integration.conflictBetween }),
      };
    }

    // 2. Run the CI/gate against the prospective merged tree (the integration ref).
    const checks = await this.deps.vcsProvider.readBranchChecks({ repo, branch: integrationBranch, token });
    const observation = evaluateCiObservation(checks, { quarantinedCheckNames });
    // `passed`/`failed` are UNCHANGED — the safety boundary: a green prospective state
    // merges, a red/failing check ALWAYS blocks (never settled → merged). Both are
    // definitive non-no_checks verdicts → CLEAR the no-checks clock.
    if (observation.status === "passed") {
      await this.clearNoChecksSince(orgId, headQueueId);
      return { result: "pass", integrationBranch };
    }
    if (observation.status === "failed") {
      await this.clearNoChecksSince(orgId, headQueueId);
      return { result: "fail", message: `batch CI failed (${observation.reason}) on ${integrationBranch}` };
    }

    // PENDING — split on WHY. The NO-CHECKS SETTLE (see DEFAULT_NO_CHECKS_SETTLE_MS), now
    // anchored on the head entry's persisted `no_checks_since` (NOT `enqueued_at`):
    //   - `no_checks` (GENUINELY zero check-runs + statuses, NOT required-context gating)
    //     ⇒ this repo has NO CI registered on the freshly-rebuilt integration ref. The
    //     grace measures CONTINUOUS no-checks: the FIRST observation sets `no_checks_since`
    //     = now (and HOLDS); only after `now - no_checks_since >= grace` does it settle to
    //     pass (mirror GitHub merging a PR with no required checks + no failing checks).
    //     Because the clock starts at first-no_checks-observation (not enqueue), a backed-
    //     up queue can NEVER let a real-CI repo settle before its workflow even registers.
    //   - `checks_pending` (real CI REGISTERED but not yet terminal) ⇒ HOLD unchanged AND
    //     CLEAR `no_checks_since` — the moment a real workflow registers a check the
    //     no-checks clock is wiped, so it can never later settle. We WAIT for the
    //     registered CI to finish (a CI-completion re-triggers the pass).
    if (observation.reason === "no_checks") {
      const noChecksSettleMs = resolveNoChecksSettleMs(project.project_config);
      const sinceMs = await this.loadNoChecksSinceMs(orgId, headQueueId);
      if (sinceMs === undefined) {
        // FIRST continuous-no_checks observation on this head: START the clock + HOLD.
        // Never settle on the first sighting — the grace counts from here forward.
        await this.setNoChecksSince(orgId, headQueueId, this.now());
        return {
          result: "pending",
          message: `batch has no CI on ${integrationBranch}; settling in ${noChecksSettleMs}ms`,
          settleAfterMs: noChecksSettleMs,
        };
      }
      const elapsed = this.now() - sinceMs;
      if (elapsed >= noChecksSettleMs) {
        return { result: "pass", integrationBranch };
      }
      return {
        result: "pending",
        message: `batch has no CI on ${integrationBranch}; settling in ${noChecksSettleMs - elapsed}ms`,
        settleAfterMs: noChecksSettleMs - elapsed,
      };
    }

    // Still running REGISTERED CI (`checks_pending`) — NOT a failure, NOT settled: CLEAR
    // the no-checks clock (a real check registered) + hold (re-checks on CI completion).
    await this.clearNoChecksSince(orgId, headQueueId);
    return { result: "pending", message: `batch CI pending (${observation.reason}) on ${integrationBranch}` };
  }

  private async loadProject(client: pg.PoolClient, projectId: string): Promise<BatchProjectRow> {
    const result = await client.query<BatchProjectRow>(
      `SELECT p.repo_url, p.default_branch, p.config AS project_config, o.config AS org_config
         FROM projects p
         LEFT JOIN organizations o ON o.id = p.org_id
        WHERE p.project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`project ${projectId} not found for batch check`);
    }
    return row;
  }

  private async loadEntryBranches(client: pg.PoolClient, specIds: ReadonlyArray<string>): Promise<BatchBranchRow[]> {
    if (specIds.length === 0) return [];
    const result = await client.query<BatchBranchRow>(
      `SELECT DISTINCT ON (r.spec_id) r.spec_id, r.branch
         FROM runs r
        WHERE r.spec_id = ANY($1::text[])
        ORDER BY r.spec_id, r.started_at DESC`,
      [[...specIds]],
    );
    return result.rows;
  }

  /**
   * Read the head entry's persisted no-checks settle clock (`merge_queue.no_checks_since`)
   * as ms epoch, or undefined when NULL (the clock is not running — no continuous
   * no_checks window has been observed yet). Org-scoped under RLS (an off-scope read sees
   * zero rows ⇒ undefined). This is the STABLE settle anchor: it survives integration-ref
   * rebuilds AND starts when checking begins, not at enqueue — so the grace measures
   * CONTINUOUS no-checks, never queue-backlog time.
   */
  private async loadNoChecksSinceMs(orgId: string, queueId: string): Promise<number | undefined> {
    return runWithOrgScope(this.deps.pool, orgId, async (client): Promise<number | undefined> => {
      const result = await client.query<{ no_checks_since: Date | string | null }>(
        "SELECT no_checks_since FROM merge_queue WHERE queue_id = $1",
        [queueId],
      );
      const raw = result.rows[0]?.no_checks_since;
      if (raw === null || raw === undefined) return undefined;
      const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
      return Number.isNaN(ms) ? undefined : ms;
    });
  }

  /** START the head entry's no-checks clock (set `no_checks_since` = the given instant). Org-scoped. */
  private async setNoChecksSince(orgId: string, queueId: string, atMs: number): Promise<void> {
    await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      await client.query("UPDATE merge_queue SET no_checks_since = $2 WHERE queue_id = $1", [
        queueId,
        new Date(atMs).toISOString(),
      ]);
    });
  }

  /**
   * CLEAR the head entry's no-checks clock (`no_checks_since` → NULL) — the KEY safety
   * reset: called on every NON-no_checks verdict (checks_pending/passed/failed/conflict),
   * so the moment a real workflow registers a check the no-checks window is wiped and can
   * never later settle-merge unverified. A no-op UPDATE when already NULL. Org-scoped.
   */
  private async clearNoChecksSince(orgId: string, queueId: string): Promise<void> {
    await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      await client.query(
        "UPDATE merge_queue SET no_checks_since = NULL WHERE queue_id = $1 AND no_checks_since IS NOT NULL",
        [queueId],
      );
    });
  }

  private async resolveProjectOrg(projectId: string): Promise<string | null> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<{ org_id: string | null }>(
        "SELECT org_id FROM projects WHERE project_id = $1",
        [projectId],
      );
      return result.rows[0]?.org_id ?? null;
    });
  }
}

/**
 * Resolve the per-project no-checks settle grace (ms) from `projects.config` the SAME
 * way `maxBatchSize` is resolved — falling back to the schema default if the config
 * cannot be parsed (never a hard error in the coordinator hot path).
 */
function resolveNoChecksSettleMs(projectConfig: unknown): number {
  try {
    return migrateProjectConfig(projectConfig).noChecksSettleMs;
  } catch {
    return DEFAULT_NO_CHECKS_SETTLE_MS;
  }
}

/** Resolve the static GitHub credential ref: project credentials → org default. */
function resolveGithubStaticRef(projectConfig: unknown, orgConfig: unknown): string | undefined {
  try {
    const projectRef = migrateProjectConfig(projectConfig).credentials?.githubCredentialRef;
    if (projectRef !== undefined) return projectRef;
  } catch {
    // fall through to the org default
  }
  if (orgConfig === null || orgConfig === undefined) return undefined;
  try {
    return migrateOrgConfig(orgConfig).defaultCredentials?.github_token;
  } catch {
    return undefined;
  }
}
