// The pg-backed change-percolation seam wirings (autonomy-engine.md §2c
// change-percolation), split out of `percolation.ts` to keep each file under the
// 500-line cap. Two production wirings of the `ChangePercolation` contract seams
// the PercolatingCoordinator composes (the write helpers — verified-SHA / clear /
// replan — live in `percolationWrites.ts`):
//   - PgPercolationReadModel: the org-scoped, READ-ONLY detect — the project's
//     in-flight SPECULATIVE dependents (the build base + the VERIFIED/absorbed SHA
//     map + the in-flight marker + the dependent's OWN lifecycle) and, per ancestor,
//     its CURRENT head SHA (via the VcsProvider) + lifecycle severity/verdict (the
//     lifecycle projection). DAG state is the source of truth: read fresh.
//   - PgPercolationEventEmitter: writes the four dag.spec.percolation events through
//     the single org-scoped event-writer seam (mirrors PgDagEventEmitter).

import { runWithJobOrgId, runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import {
  type AncestorChangeSignal,
  type ImmediateSeverity,
  type LazySeverity,
  type PercolationEventEmitter,
  type PercolationReadModel,
  type SpeculativeDependent,
} from "../contracts/changePercolation.js";
import { projectSpecLifecycle, type ReviewVerdict, type SpecLifecycle } from "../contracts/dagLifecycle.js";
import type { ResolvedVcsToken, VcsProvider } from "../contracts/vcsProvider.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { migrateOrgConfig } from "../config/orgConfig.js";
import { migrateProjectConfig } from "../config/projectConfig.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { VcsProviderCodeHost } from "../providers/vcsProviderCodeHost.js";
import { PgDagLifecycleReadModel } from "./lifecycle.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { type EventStore, PgEventStore } from "../eventStore.js";
import {
  clearPercolationPending,
  decodePercolationPending,
  decodeVerified,
  resolveProjectOrg,
} from "./percolationWrites.js";

interface SpeculativeRunRow {
  run_id: string;
  spec_id: string;
  speculative_base: string | null;
  integrated_ancestor_shas: unknown;
  verified_ancestor_shas: unknown;
  percolation_pending: unknown;
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
  /**
   * Plane-split (autonomy loops): when present, the stale-marker housekeeping
   * clear (a `percolation_pending` marker left on a now-MERGED/DONE run) routes
   * through the control plane (the de-privileged data plane can no longer UPDATE
   * runs); absent, the clear runs in-process org-scoped — byte-identical to today.
   */
  runStateWriter?: RunStateWriter;
}

/**
 * The pg + VcsProvider-backed percolation detect read model. Reads the project's
 * IN-FLIGHT speculative dependents under RLS, and for each resolves its ancestors'
 * CURRENT head SHAs (via the VcsProvider ref read) + lifecycle severities (via the
 * shared lifecycle projection). Read-only: detection NEVER mutates.
 */
export class PgPercolationReadModel implements PercolationReadModel {
  private readonly lifecycle: PgDagLifecycleReadModel;
  constructor(private readonly deps: PgPercolationReadModelDeps) {
    this.lifecycle = new PgDagLifecycleReadModel(deps.pool);
  }

  async loadSpeculativeDependents(projectId: string): Promise<SpeculativeDependent[]> {
    const orgId = await resolveProjectOrg(this.deps.pool, projectId);
    if (orgId === null) return [];
    // The dependent's OWN lifecycle (for settling an in-flight marker) comes from
    // the shared projection — one snapshot per pass.
    const lifecycleSnapshot = await this.lifecycle.loadLifecycle(projectId);
    const rows = await runWithOrgScope(this.deps.pool, orgId, async (client) => {
      // The latest run per spec that is either (a) speculative (carries a base + a
      // non-empty build-base map — its VERIFIED SHAs may have diverged) OR (b) a
      // §2c non-speculative percolation re-exec (NULL base, empty build base, but an
      // in-flight `percolation_pending` marker the SETTLE must resolve to advance the
      // termination key — never strand a re-based-onto-main re-exec). Still in-flight
      // (not merged/halted), plus the absorbed-key + marker.
      const result = await client.query<SpeculativeRunRow>(
        `SELECT DISTINCT ON (r.spec_id)
                r.run_id, r.spec_id, r.speculative_base, r.integrated_ancestor_shas,
                r.verified_ancestor_shas, r.percolation_pending
           FROM runs r
          WHERE r.project_id = $1
            AND (r.speculative_base IS NOT NULL OR r.percolation_pending IS NOT NULL)
            AND r.status NOT IN ('halted','cancelled','failed')
          ORDER BY r.spec_id, r.started_at DESC`,
        [projectId],
      );
      return result.rows;
    });
    const dependents = rows
      .map((row): SpeculativeDependent => {
        const life = lifecycleSnapshot.bySpecId.get(row.spec_id);
        const buildBase = asShaMap(row.integrated_ancestor_shas);
        // The verified (absorbed) map defaults to the build base before the first
        // percolation: a fresh speculative start was audited against its build
        // base, so that IS its verified SHA until an ancestor changes.
        const verified = decodeVerified(row.verified_ancestor_shas);
        const verifiedShas = Object.keys(verified.shas).length > 0 ? verified.shas : buildBase;
        const pending = decodePercolationPending(row.percolation_pending);
        return {
          specId: row.spec_id,
          runId: row.run_id,
          speculativeBase: row.speculative_base,
          integratedAncestorShas: buildBase,
          verifiedAncestorShas: verifiedShas,
          absorbedReviewVerdicts: verified.verdicts,
          ...(pending !== undefined && { pending }),
          lifecycleState: life?.state ?? "building",
          openFindingMaxSeverity: life?.openFindingMaxSeverity ?? "unaudited",
          // §5 P0: the dependent's OWN review verdict feeds the settle decision — a
          // `changes_requested` re-exec must NEVER absorb the upstream change.
          ...(life?.review?.verdict !== undefined && { reviewVerdict: life.review.verdict }),
        };
      })
      // A run whose build-base map decoded empty has nothing to DETECT against —
      // UNLESS it carries an in-flight percolation marker (a §2c non-speculative
      // re-exec, re-based onto plain main), which the SETTLE must still resolve to
      // advance the termination key. Drop only the runs that are neither.
      .filter((d) => Object.keys(d.integratedAncestorShas).length > 0 || d.pending !== undefined);

    // EXCLUDE TERMINAL specs (`merged`/`done` both project to lifecycle `merged`):
    // a merged spec is NEVER a percolation dependent — its re-base is moot, and it
    // cannot be re-executed (the spec status is terminal, so a kick-off's reopen is
    // a no-op and the claim raises SpecNotRunnableError). The §2c marker-widening
    // (load runs carrying a `percolation_pending` even with a NULL speculative_base)
    // started ALSO loading the run of an already-merged spec when a STALE marker
    // lingered on it — returning it made the coordinator try to re-exec a merged
    // spec, aborting the whole pass. Drop them here, and CLEAR the moot marker
    // (idempotent — a NULL marker stays NULL) so it is never re-detected. Live
    // (non-terminal) dependents are returned for the coordinator to settle/detect.
    const terminalWithMarker = dependents.filter((d) => d.lifecycleState === "merged" && d.pending !== undefined);
    for (const terminal of terminalWithMarker) {
      console.debug(
        `[change-percolation] clearing stale percolation_pending on merged/done spec ${terminal.specId} (run ${terminal.runId}) — a terminal spec is never a percolation dependent`,
      );
      await clearPercolationPending(this.deps.pool, { projectId, runId: terminal.runId }, this.deps.runStateWriter);
    }
    return dependents.filter((d) => d.lifecycleState !== "merged");
  }

  async loadAncestorSignals(input: {
    projectId: string;
    dependent: SpeculativeDependent;
  }): Promise<AncestorChangeSignal[]> {
    const lifecycleSnapshot = await this.lifecycle.loadLifecycle(input.projectId);
    const { repo, token, branchBySpec, defaultBranch } = await this.resolveAncestorRead(
      input.projectId,
      Object.keys(input.dependent.integratedAncestorShas),
    );
    const verifiedShas = input.dependent.verifiedAncestorShas;
    const absorbedVerdicts = input.dependent.absorbedReviewVerdicts ?? {};
    const signals: AncestorChangeSignal[] = [];
    // A MERGED ancestor's run branch is stale (a squash-merge leaves it untouched),
    // so its divergence is keyed off the project's default_branch HEAD (the merge
    // commit) — read ONCE per pass, shared across every merged ancestor.
    let defaultBranchHead: string | undefined;
    for (const ancestorSpecId of Object.keys(input.dependent.integratedAncestorShas)) {
      // Detection keys off the VERIFIED (re-gated-clean) SHA, NOT the bare build
      // base — a change is actionable until the dependent's own governance re-ran.
      const verifiedSha = verifiedShas[ancestorSpecId] ?? input.dependent.integratedAncestorShas[ancestorSpecId] ?? "";
      const life: SpecLifecycle =
        lifecycleSnapshot.bySpecId.get(ancestorSpecId) ??
        projectSpecLifecycle({
          specId: ancestorSpecId,
          specStatus: "pending",
          hasRun: false,
          prOpened: false,
          ciPassed: false,
        });
      const absorbed: ReviewVerdict | undefined = absorbedVerdicts[ancestorSpecId];

      // The NEW "ancestor merged" divergence axis (§2c): a merged ancestor wrote a
      // fresh commit on default_branch while its run branch stayed put. Read the
      // current SHA off default_branch (the merge commit), NOT the stale run branch,
      // and flag the merge so the detect re-bases the descendant onto fresh main.
      if (life.state === "merged") {
        if (defaultBranchHead === undefined) {
          defaultBranchHead = await this.headSha(repo, token, defaultBranch, verifiedSha);
        }
        signals.push({
          ancestorSpecId,
          verifiedSha,
          currentSha: defaultBranchHead,
          openFindingMaxSeverity: life.openFindingMaxSeverity,
          ancestorMerged: true,
          mergedSha: defaultBranchHead,
          ...(life.review?.verdict !== undefined && { reviewVerdict: life.review.verdict }),
          ...(absorbed !== undefined && { absorbedReviewVerdict: absorbed }),
        });
        continue;
      }

      // UNMERGED ancestor: keep the existing run-branch head behavior (reviewer-push
      // detection). A missing branch (the ancestor's run vanished) cannot be read —
      // treat the current SHA as the verified one (no divergence) rather than
      // inventing a change; the dependent is left untouched (never falsely percolated).
      const branch = branchBySpec.get(ancestorSpecId);
      const currentSha = branch === undefined ? verifiedSha : await this.headSha(repo, token, branch, verifiedSha);
      signals.push({
        ancestorSpecId,
        verifiedSha,
        currentSha,
        openFindingMaxSeverity: life.openFindingMaxSeverity,
        ...(life.review?.verdict !== undefined && { reviewVerdict: life.review.verdict }),
        ...(absorbed !== undefined && { absorbedReviewVerdict: absorbed }),
      });
    }
    return signals;
  }

  /** Resolve the repo + token + default_branch + each ancestor's run branch (org-scoped). */
  private async resolveAncestorRead(
    projectId: string,
    ancestorSpecIds: string[],
  ): Promise<{
    repo: ReturnType<VcsProvider["parseRepository"]>;
    token: ResolvedVcsToken;
    branchBySpec: Map<string, string>;
    defaultBranch: string;
  }> {
    const orgId = await resolveProjectOrg(this.deps.pool, projectId);
    if (orgId === null) throw new Error(`project ${projectId} has no org for percolation detect`);
    const { repoUrl, defaultBranch, projectConfig, orgConfig, branches } = await runWithOrgScope(
      this.deps.pool,
      orgId,
      async (client) => {
        const project = await client.query<{
          repo_url: string;
          default_branch: string;
          project_config: unknown;
          org_config: unknown;
        }>(
          `SELECT p.repo_url, p.default_branch, p.config AS project_config, o.config AS org_config
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
          defaultBranch: row.default_branch,
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
      defaultBranch,
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
    // Route the ancestor head-sha read through the host-neutral `CodeHost` seam
    // (tanren-owns-the-engine.md §6) rather than the GitHub-shaped provider call —
    // the engine reasons over the `CodeHost` contract, not forge read semantics.
    // Pure substitution (`fetchRef` ≡ the provider's `readBranchHeadSha`); the
    // VcsProvider-backed read adapter reuses the existing credential resolution.
    const codeHost = new VcsProviderCodeHost(this.deps.vcsProvider, async () => token);
    const sha = await codeHost.fetchRef({ repo, remoteBranch: branch });
    return sha ?? fallback;
  }
}

export interface PgPercolationEventEmitterDeps {
  pool: pg.Pool;
  /**
   * Plane-split (autonomy loops): when present, the dag.spec.percolation events
   * append through the control-plane writer (the de-privileged data plane can no
   * longer write `events` directly); absent, in-process via `PgEventStore`.
   */
  runStateWriter?: RunStateWriter;
}

/** The pg-backed dag.spec.percolation emitter (org-scoped, mirrors PgDagEventEmitter). */
export class PgPercolationEventEmitter implements PercolationEventEmitter {
  constructor(private readonly deps: PgPercolationEventEmitterDeps) {}

  private async withScopedStore(projectId: string, work: (store: EventStore) => Promise<void>): Promise<void> {
    const orgId = await resolveProjectOrg(this.deps.pool, projectId);
    if (orgId === null) return;
    // Plane-split: route the append through the control plane when wired (ambient
    // per-job org carries the scope); else append in-process — byte-identical.
    if (this.deps.runStateWriter !== undefined) {
      const writer = this.deps.runStateWriter;
      await runWithJobOrgId(orgId, () => work(writer));
      return;
    }
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
