import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { VcsProvider } from "../contracts/vcsProvider.js";
import { loadOrgGithubAppInstallation } from "../credentials/orgGithubApp.js";
import { resolveCredentialsForRun } from "../credentials/resolveCredentials.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";

interface FalseMergedCandidate {
  queueId: string;
  runId: string;
  specId: string;
  orgId: string;
  projectId: string;
  prUrl: string;
  prNumber: number;
  projectConfig: unknown;
}

export interface MergeTruthReconciler {
  reconcile(projectId: string): Promise<number>;
}

export interface PgMergeTruthReconcilerDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  runStateWriter?: RunStateWriter;
}

const FALSE_MERGED_CANDIDATES_SQL = `
SELECT mq.queue_id, mq.run_id, mq.spec_id, mq.org_id, mq.project_id, mq.pr_url, mq.pr_number, p.config AS project_config
  FROM merge_queue mq
  JOIN runs r ON r.run_id = mq.run_id
  JOIN specs s ON s.spec_id = mq.spec_id
  JOIN projects p ON p.project_id = mq.project_id
 WHERE mq.project_id = $1
   AND mq.status = 'merged'
   AND r.status = 'completed'
   AND r.outcome = 'ok'
   AND s.status = 'merged'
   AND mq.pr_url IS NOT NULL
   AND mq.pr_url <> ''
   AND mq.pr_number IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM merge_queue active
      WHERE active.run_id = mq.run_id
        AND active.status IN ('queued', 'merging')
   )
   AND EXISTS (
     SELECT 1 FROM events held
      WHERE held.project_id = mq.project_id
        AND held.org_id = mq.org_id
        AND held.event_type = 'merge.speculative_held'
        AND (NOT (held.payload ? 'integration') OR held.payload ->> 'integration' = 'native_queue')
        AND (
          held.run_id = mq.run_id
          OR held.payload ->> 'runId' = mq.run_id
          OR held.payload ->> 'prUrl' = mq.pr_url
          OR held.payload ->> 'prNumber' = mq.pr_number
          OR held.spec_id = mq.spec_id
        )
   )
   AND NOT EXISTS (
     SELECT 1 FROM events done
      WHERE done.project_id = mq.project_id
        AND done.org_id = mq.org_id
        AND done.event_type = 'merge.completed'
        AND (
          done.run_id = mq.run_id
          OR done.payload ->> 'runId' = mq.run_id
          OR done.payload ->> 'prUrl' = mq.pr_url
          OR done.payload ->> 'prNumber' = mq.pr_number
          OR done.spec_id = mq.spec_id
        )
   )
 ORDER BY mq.settled_at NULLS LAST, mq.queue_id`;

/** Autonomous correction for old false-terminal native-queue state. */
export class PgMergeTruthReconciler implements MergeTruthReconciler {
  constructor(private readonly deps: PgMergeTruthReconcilerDeps) {}

  async reconcile(projectId: string): Promise<number> {
    const candidates = await this.listCandidates(projectId);
    let corrected = 0;
    for (const candidate of candidates) {
      const token = await this.resolveToken(candidate);
      const pr = this.deps.vcsProvider.parsePullRequest(candidate.prUrl);
      const state = await this.deps.vcsProvider.readPullRequestState(pr, token);
      if (!state.confirmed) continue;
      if (!state.merged) {
        const requeued = await this.requeue(candidate);
        if (requeued === 1) {
          await this.emitFalseMergedCorrected(candidate, state.open);
          corrected += 1;
        }
      } else if (state.merged) {
        await this.emitMissingMergeCompleted(candidate, state.mergeSha);
        corrected += 1;
      }
    }
    return corrected;
  }

  private async listCandidates(projectId: string): Promise<FalseMergedCandidate[]> {
    const orgId = await resolveProjectOrg(this.deps.pool, projectId);
    if (orgId === null) return [];
    return runWithOrgScope(this.deps.pool, orgId, async (client) => {
      const result = await client.query<{
        queue_id: string;
        run_id: string;
        spec_id: string;
        org_id: string;
        project_id: string;
        pr_url: string;
        pr_number: string;
        project_config: unknown;
      }>(FALSE_MERGED_CANDIDATES_SQL, [projectId]);
      return result.rows.map((row) => ({
        queueId: row.queue_id,
        runId: row.run_id,
        specId: row.spec_id,
        orgId: row.org_id,
        projectId: row.project_id,
        prUrl: row.pr_url,
        prNumber: Number(row.pr_number),
        projectConfig: row.project_config,
      }));
    });
  }

  private async resolveToken(candidate: FalseMergedCandidate) {
    const projectConfig = migrateProjectConfig(candidate.projectConfig);
    const credentials = await runWithOrgScope(this.deps.pool, candidate.orgId, (client) =>
      resolveCredentialsForRun(client, { projectConfig, orgId: candidate.orgId }),
    );
    const installation = await loadOrgGithubAppInstallation(this.deps.pool, candidate.orgId);
    return this.deps.vcsProvider.resolveToken({
      secrets: this.deps.secrets,
      ...(installation !== undefined && { installation }),
      staticRef: credentials.githubCredentialRef,
      ...(this.deps.githubAppMinter !== undefined && { minter: this.deps.githubAppMinter }),
    });
  }

  private async requeue(candidate: FalseMergedCandidate): Promise<number> {
    return runWithOrgScope(this.deps.pool, candidate.orgId, async (client) => {
      await client.query("LOCK TABLE merge_queue IN SHARE ROW EXCLUSIVE MODE");
      const updated = await client.query(
        `UPDATE merge_queue mq
            SET status = 'queued', dequeue_reason = NULL, claimed_at = NULL, settled_at = NULL
          WHERE mq.queue_id = $1
            AND mq.project_id = $2
            AND mq.status = 'merged'
            AND NOT EXISTS (
              SELECT 1 FROM merge_queue active
               WHERE active.run_id = mq.run_id
                 AND active.status IN ('queued', 'merging')
            )`,
        [candidate.queueId, candidate.projectId],
      );
      if ((updated.rowCount ?? 0) === 0) return 0;
      await this.setSpecStatusToReview(candidate);
      return 1;
    });
  }

  private async setSpecStatusToReview(candidate: FalseMergedCandidate): Promise<void> {
    if (this.deps.runStateWriter !== undefined) {
      await this.deps.runStateWriter.setSpecStatus({
        specId: candidate.specId,
        orgId: candidate.orgId,
        status: "review",
      });
      return;
    }

    await runWithOrgScope(this.deps.pool, candidate.orgId, async (client) => {
      await client.query("UPDATE specs SET status = 'review' WHERE spec_id = $1 AND status = 'merged'", [
        candidate.specId,
      ]);
    });
  }

  private async emitFalseMergedCorrected(candidate: FalseMergedCandidate, open: boolean): Promise<void> {
    await this.withScopedStore(candidate, (store) =>
      store.append({
        runId: candidate.runId,
        specId: candidate.specId,
        projectId: candidate.projectId,
        eventType: "merge.false_merged.corrected",
        payload: {
          prUrl: candidate.prUrl,
          prNumber: candidate.prNumber,
          integration: "native_queue",
          specId: candidate.specId,
          queueId: candidate.queueId,
          runId: candidate.runId,
          reason: open ? "forge_pr_open_unmerged" : "forge_pr_closed_unmerged",
        },
      }),
    );
  }

  private async emitMissingMergeCompleted(
    candidate: FalseMergedCandidate,
    mergeSha: string | undefined,
  ): Promise<void> {
    await this.withScopedStore(candidate, (store) =>
      store.append({
        runId: candidate.runId,
        specId: candidate.specId,
        projectId: candidate.projectId,
        eventType: "merge.completed",
        payload: {
          prUrl: candidate.prUrl,
          prNumber: candidate.prNumber,
          integration: "native_queue",
          ...(mergeSha !== undefined && { mergeSha }),
        },
      }),
    );
  }

  private async withScopedStore(candidate: FalseMergedCandidate, work: (store: EventStore) => Promise<void>) {
    if (this.deps.runStateWriter !== undefined) {
      await runWithJobOrgId(candidate.orgId, () => work(this.deps.runStateWriter!));
      return;
    }
    await runWithOrgScope(this.deps.pool, candidate.orgId, (client) => work(new PgEventStore(client)));
  }
}

async function resolveProjectOrg(pool: pg.Pool, projectId: string): Promise<string | null> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.org_id ?? null;
  });
}
