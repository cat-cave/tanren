// The pg-backed change-percolation seam wirings (autonomy-engine.md §2c
// change-percolation), split out of `percolation.ts` to keep each file under the
// 500-line cap. Three production wirings of the `ChangePercolation` contract
// seams the PercolatingCoordinator composes:
//   - PgPercolationReadModel: the org-scoped, READ-ONLY detect — the project's
//     in-flight SPECULATIVE dependents (runs carrying a `speculative_base` + a
//     non-empty `integrated_ancestor_shas` map) + each ancestor's CURRENT head SHA
//     (read through the VcsProvider) and lifecycle severity (the P2c-1 lifecycle
//     projection). DAG state is the source of truth: read fresh each detect.
//   - PgPercolationEventEmitter: writes the four dag.spec.percolation events
//     through the single org-scoped event-writer seam (mirrors PgDagEventEmitter).
//   - recordIntegratedAncestorSha: persists the NEW integrated SHA on the
//     dependent's run after a clean re-gate (the next detect's termination key).

import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import {
  type AncestorChangeSignal,
  type ImmediateSeverity,
  type LazySeverity,
  type PercolationEventEmitter,
  type PercolationReadModel,
  type SpeculativeDependent,
} from "../contracts/changePercolation.js";
import { projectSpecLifecycle, type SpecLifecycle } from "../contracts/dagLifecycle.js";
import type { ResolvedVcsToken, VcsProvider } from "../contracts/vcsProvider.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { migrateOrgConfig } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { PgDagLifecycleReadModel } from "./lifecycle.js";
import { PgEventStore } from "../eventStore.js";

/** Resolve the project's org id (system-scoped bootstrap, the same hop the walker uses). */
async function resolveProjectOrg(pool: pg.Pool, projectId: string): Promise<string | null> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ org_id: string | null }>("SELECT org_id FROM projects WHERE project_id = $1", [
      projectId,
    ]);
    return result.rows[0]?.org_id ?? null;
  });
}

interface SpeculativeRunRow {
  run_id: string;
  spec_id: string;
  speculative_base: string;
  integrated_ancestor_shas: unknown;
}

/** Coerce a persisted jsonb blob into the per-ancestor SHA map (string→string only). */
function asShaMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export interface PgPercolationReadModelDeps {
  pool: pg.Pool;
  vcsProvider: VcsProvider;
  secrets: SecretStore;
  githubAppMinter?: GithubAppTokenMinter;
}

/**
 * The pg + VcsProvider-backed percolation detect read model. Reads the project's
 * IN-FLIGHT speculative dependents under RLS, and for each resolves its ancestors'
 * CURRENT head SHAs (via the VcsProvider ref read) + lifecycle severities (via the
 * shared P2c-1 lifecycle projection). Read-only: detection NEVER mutates.
 */
export class PgPercolationReadModel implements PercolationReadModel {
  private readonly lifecycle: PgDagLifecycleReadModel;
  constructor(private readonly deps: PgPercolationReadModelDeps) {
    this.lifecycle = new PgDagLifecycleReadModel(deps.pool);
  }

  async loadSpeculativeDependents(projectId: string): Promise<SpeculativeDependent[]> {
    const orgId = await resolveProjectOrg(this.deps.pool, projectId);
    if (orgId === null) return [];
    const rows = await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      // The latest run per spec that is speculative (carries a base + a non-empty
      // integrated-SHA map) AND still in-flight (not yet merged) — exactly the
      // dependents whose recorded integrated SHA may have diverged.
      const result = await client.query<SpeculativeRunRow>(
        `SELECT DISTINCT ON (r.spec_id) r.run_id, r.spec_id, r.speculative_base, r.integrated_ancestor_shas
           FROM runs r
          WHERE r.project_id = $1
            AND r.speculative_base IS NOT NULL
            AND r.integrated_ancestor_shas IS NOT NULL
            AND r.status NOT IN ('halted','cancelled','failed')
          ORDER BY r.spec_id, r.started_at DESC`,
        [projectId],
      );
      return result.rows;
    });
    return (
      rows
        .map(
          (row): SpeculativeDependent => ({
            specId: row.spec_id,
            runId: row.run_id,
            speculativeBase: row.speculative_base,
            integratedAncestorShas: asShaMap(row.integrated_ancestor_shas),
          }),
        )
        // A run whose map decoded empty has nothing to percolate against — drop it.
        .filter((d) => Object.keys(d.integratedAncestorShas).length > 0)
    );
  }

  async loadAncestorSignals(input: {
    projectId: string;
    dependent: SpeculativeDependent;
  }): Promise<AncestorChangeSignal[]> {
    const lifecycleSnapshot = await this.lifecycle.loadLifecycle(input.projectId);
    const { repo, token, branchBySpec } = await this.resolveAncestorRead(
      input.projectId,
      Object.keys(input.dependent.integratedAncestorShas),
    );
    const signals: AncestorChangeSignal[] = [];
    for (const [ancestorSpecId, integratedSha] of Object.entries(input.dependent.integratedAncestorShas)) {
      const branch = branchBySpec.get(ancestorSpecId);
      // A missing branch (the ancestor's run vanished) cannot be read — treat the
      // current SHA as the integrated one (no divergence detectable) rather than
      // inventing a change; the dependent is left untouched (never falsely percolated).
      const currentSha = branch === undefined ? integratedSha : await this.headSha(repo, token, branch, integratedSha);
      const life: SpecLifecycle =
        lifecycleSnapshot.bySpecId.get(ancestorSpecId) ??
        projectSpecLifecycle({
          specId: ancestorSpecId,
          specStatus: "pending",
          hasRun: false,
          prOpened: false,
          ciPassed: false,
        });
      signals.push({
        ancestorSpecId,
        integratedSha,
        currentSha,
        openFindingMaxSeverity: life.openFindingMaxSeverity,
        ...(life.review?.verdict !== undefined && { reviewVerdict: life.review.verdict }),
      });
    }
    return signals;
  }

  /** Resolve the repo + token + each ancestor's run branch (org-scoped). */
  private async resolveAncestorRead(
    projectId: string,
    ancestorSpecIds: string[],
  ): Promise<{
    repo: ReturnType<VcsProvider["parseRepository"]>;
    token: ResolvedVcsToken;
    branchBySpec: Map<string, string>;
  }> {
    const orgId = await resolveProjectOrg(this.deps.pool, projectId);
    if (orgId === null) throw new Error(`project ${projectId} has no org for percolation detect`);
    const { repoUrl, projectConfig, orgConfig, branches } = await runWithOrgScope(
      this.deps.pool,
      orgId,
      async (client) => {
        const project = await client.query<{ repo_url: string; project_config: unknown; org_config: unknown }>(
          `SELECT p.repo_url, p.config AS project_config, o.config AS org_config
             FROM projects p LEFT JOIN organizations o ON o.id = p.org_id
            WHERE p.project_id = $1`,
          [projectId],
        );
        const branchRows = await client.query<{ spec_id: string; branch: string }>(
          `SELECT DISTINCT ON (r.spec_id) r.spec_id, r.branch
             FROM runs r WHERE r.spec_id = ANY($1::text[]) ORDER BY r.spec_id, r.started_at DESC`,
          [ancestorSpecIds],
        );
        const row = project.rows[0];
        if (row === undefined) throw new Error(`project ${projectId} not found for percolation detect`);
        return {
          repoUrl: row.repo_url,
          projectConfig: row.project_config,
          orgConfig: row.org_config,
          branches: branchRows.rows,
        };
      },
    );
    const installation = orgGithubApp(orgConfig);
    const staticRef = githubStaticRef(projectConfig, orgConfig);
    const token = await this.deps.vcsProvider.resolveToken({
      secrets: this.deps.secrets,
      ...(installation !== undefined && { installation }),
      ...(staticRef !== undefined && { staticRef }),
      ...(this.deps.githubAppMinter !== undefined && { minter: this.deps.githubAppMinter }),
    });
    return {
      repo: this.deps.vcsProvider.parseRepository(repoUrl),
      token,
      branchBySpec: new Map(branches.map((b) => [b.spec_id, b.branch] as const)),
    };
  }

  /**
   * The current head SHA of an ancestor branch. A ref that cannot be read (deleted
   * branch → undefined) falls back to the integrated SHA, so an unreadable ancestor
   * is treated as UNCHANGED (never falsely percolated) — the detect only acts on a
   * real, observed divergence.
   */
  private async headSha(
    repo: ReturnType<VcsProvider["parseRepository"]>,
    token: ResolvedVcsToken,
    branch: string,
    fallback: string,
  ): Promise<string> {
    const sha = await this.deps.vcsProvider.readBranchHeadSha({ repo, branch, token });
    return sha ?? fallback;
  }
}

export interface PgPercolationEventEmitterDeps {
  pool: pg.Pool;
}

/** The pg-backed dag.spec.percolation emitter (org-scoped, mirrors PgDagEventEmitter). */
export class PgPercolationEventEmitter implements PercolationEventEmitter {
  constructor(private readonly deps: PgPercolationEventEmitterDeps) {}

  private async withScopedStore(projectId: string, work: (store: PgEventStore) => Promise<void>): Promise<void> {
    const orgId = await resolveProjectOrg(this.deps.pool, projectId);
    if (orgId === null) return;
    await runWithOrgScope(this.deps.pool, orgId, (client) => work(new PgEventStore(client)));
  }

  async emitPercolating(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    fromAncestorSha: string;
    toAncestorSha: string;
    severity: ImmediateSeverity;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.percolating",
        payload: {
          specId: input.specId,
          runId: input.runId,
          ancestorSpecId: input.ancestorSpecId,
          fromAncestorSha: input.fromAncestorSha,
          toAncestorSha: input.toAncestorSha,
          severity: input.severity,
        },
      }),
    );
  }

  async emitPercolated(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    integratedAncestorSha: string;
    viaResolver: boolean;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.percolated",
        payload: {
          specId: input.specId,
          runId: input.runId,
          ancestorSpecId: input.ancestorSpecId,
          integratedAncestorSha: input.integratedAncestorSha,
          viaResolver: input.viaResolver,
        },
      }),
    );
  }

  async emitPercolationDeferred(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    pendingAncestorSha: string;
    severity: LazySeverity;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.percolation_deferred",
        payload: {
          specId: input.specId,
          runId: input.runId,
          ancestorSpecId: input.ancestorSpecId,
          pendingAncestorSha: input.pendingAncestorSha,
          severity: input.severity,
        },
      }),
    );
  }

  async emitPercolationReplan(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    ancestorSha: string;
    reason: string;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, (store) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        eventType: "dag.spec.percolation_replan",
        payload: {
          specId: input.specId,
          runId: input.runId,
          ancestorSpecId: input.ancestorSpecId,
          ancestorSha: input.ancestorSha,
          reason: input.reason,
        },
      }),
    );
  }
}

/**
 * Persist the NEW integrated head SHA for one ancestor on the dependent's run after
 * a clean re-gate — the next detect's TERMINATION key (a subsequent detect with the
 * same SHA is a no-op). Org-scoped; merges into the existing jsonb map so other
 * ancestors' recorded SHAs are preserved.
 */
export async function recordIntegratedAncestorSha(
  pool: pg.Pool,
  input: { projectId: string; runId: string; ancestorSpecId: string; sha: string },
): Promise<void> {
  const orgId = await resolveProjectOrg(pool, input.projectId);
  if (orgId === null) throw new Error(`project ${input.projectId} has no org to record integrated SHA`);
  await runWithOrgScope(pool, orgId, async (client) => {
    await client.query(
      `UPDATE runs
          SET integrated_ancestor_shas =
            COALESCE(integrated_ancestor_shas, '{}'::jsonb) || jsonb_build_object($2::text, $3::text)
        WHERE run_id = $1`,
      [input.runId, input.ancestorSpecId, input.sha],
    );
  });
}

/** Resolve the org App installation block from the org config blob (App-first auth). */
function orgGithubApp(orgConfig: unknown): ReturnType<typeof migrateOrgConfig>["github_app"] | undefined {
  if (orgConfig === null || orgConfig === undefined) return undefined;
  try {
    return migrateOrgConfig(orgConfig).github_app;
  } catch {
    return undefined;
  }
}

/** Resolve the static GitHub credential ref: project credentials → org default. */
function githubStaticRef(projectConfig: unknown, orgConfig: unknown): string | undefined {
  try {
    const ref = migrateProjectConfig(projectConfig).credentials?.githubCredentialRef;
    if (ref !== undefined) return ref;
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
