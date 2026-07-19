// cspell:ignore verenv
// rv-env — the MISSING producer of `verification_environments` rows at deploy time,
// plus the resolver the post-deploy acceptance/demo path uses to persist against it.
//
// The runtime-verification substrate (migration 0037) FKs every acceptance run
// (`behavior_verification_runs.environment_id`) and every bh-10 production re-proof
// binding (`ProductionSymptomStage` / baseline reproduction) to a
// `verification_environments` row keyed on
// (org_id, project_id, integration_node_id, artifact_digest, deployment_target='production',
//  lifecycle_status='ready'). Before this, NOTHING in production created such a row — only
// test fixtures did — so a REAL post-deploy acceptance run / proof-backed demo had no
// environment to persist against (it drove an ephemeral, non-persisting sink with a
// fabricated `environmentId`), and rv-19's re-proof binding always threw.
//
// This module closes that gap two ways:
//   1. `ensureLiveVerificationEnvironment` — the deploy path (markLive / promote) calls
//      this when a release goes LIVE in production, find-or-creating the ready row bound to
//      that exact release. Under markLive/promote it runs INSIDE the deploy transaction, so
//      the create is atomic with the live transition.
//   2. `PgVerificationEnvironmentResolver` — the post-deploy proof-backed demo (rv-18) /
//      re-proof resolves the SAME row's id to drive the PERSISTING acceptance store, so a
//      real production behavior verdict lands in the 0079-hardened ledger.
//
// Idempotency is DB-enforced by the 0082 partial unique index on the identity tuple
// (org · project · node · artifact · target · fingerprint, WHERE lifecycle_status='ready'):
// the deploy path holds the `org:project:production` advisory lock, but the demo/re-proof
// resolvers create OUTSIDE that lock, so the find-or-create relies on
// `ON CONFLICT (<identity>) DO NOTHING` + re-SELECT, not the lock. Binding is honest: the
// identity includes the deployment fingerprint (node·artifact·live URL), so a re-deploy to
// the SAME URL reuses the row while a DIVERGENT URL yields a distinct env — a verdict is
// never attributed to an environment bound to a different deployment.

import { createHash, randomUUID } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ReleaseInstanceRecord } from "../contracts/deployAdapter.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

const PRODUCTION_TARGET = "production";
// rv-premerge: the deployment target for an EPHEMERAL pre-merge preview env. `deployment_target`
// is a plain-text column (migration 0037) that is part of the 0082 partial-unique identity, so a
// 'preview' env and a 'production' env with otherwise-identical identity are DISTINCT rows — a
// pre-merge verdict is never attributed to the production environment (or vice versa).
const PREVIEW_TARGET = "preview";
const READY = "ready";

/** The exact identity fields the runtime-verification readers bind an environment on. */
export type LiveReleaseBinding = Pick<
  ReleaseInstanceRecord,
  "orgId" | "projectId" | "integrationNodeId" | "artifactDigest" | "releaseInstanceId" | "url"
>;

export interface EnsureLiveVerificationEnvironmentResult {
  readonly environmentId: string;
  /** true when this call inserted the row; false when an existing ready row was reused. */
  readonly created: boolean;
}

// A deterministic, non-secret fingerprint of the exact live deployment the environment
// represents: its integration node, its artifact, and its resolved live URL. Stable across
// idempotent re-deploys of the same artifact to the same node/URL; DIVERGES on a URL change.
function deploymentFingerprint(release: LiveReleaseBinding): string {
  const material = `${release.integrationNodeId}\n${release.artifactDigest}\n${release.url}`;
  return `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

const SELECT_READY_ENV = `
  SELECT id FROM verification_environments
   WHERE org_id = $1 AND project_id = $2 AND integration_node_id = $3
     AND artifact_digest = $4 AND deployment_target = $5 AND environment_fingerprint = $6
     AND lifecycle_status = $7
   ORDER BY created_at DESC, id DESC
   LIMIT 1`;

/**
 * Find-or-create the ready production `verification_environments` row for a release that
 * has gone LIVE. Returns the environment id an acceptance run / demo / re-proof threads
 * into `behavior_verification_runs.environment_id`.
 *
 * Idempotent (DB-enforced by the 0082 partial unique index): a re-deploy of the same
 * artifact to the same node+URL reuses the ready row. A divergent URL yields a distinct
 * env (its fingerprint differs), so a verdict is never bound to the wrong deployment.
 */
export async function ensureLiveVerificationEnvironment(
  client: QueryClient,
  release: LiveReleaseBinding,
  newId: () => string = () => `verenv_${randomUUID()}`,
): Promise<EnsureLiveVerificationEnvironmentResult> {
  return ensureReadyVerificationEnvironment(client, release, PRODUCTION_TARGET, newId);
}

/**
 * rv-premerge: find-or-create the ready PREVIEW `verification_environments` row for an
 * ephemeral pre-merge preview a release has been applied to. Identical identity/idempotency
 * semantics to the live variant, but `deployment_target='preview'` — so a `pre_merge`
 * acceptance run persists against a preview-scoped env distinct from any production env for
 * the same node/artifact. The preview release's `applyPreview` write already registered the
 * artifact in `cas_artifacts`, satisfying this row's artifact FK.
 */
export async function ensurePreviewVerificationEnvironment(
  client: QueryClient,
  release: LiveReleaseBinding,
  newId: () => string = () => `verenv_${randomUUID()}`,
): Promise<EnsureLiveVerificationEnvironmentResult> {
  return ensureReadyVerificationEnvironment(client, release, PREVIEW_TARGET, newId);
}

async function ensureReadyVerificationEnvironment(
  client: QueryClient,
  release: LiveReleaseBinding,
  deploymentTarget: string,
  newId: () => string,
): Promise<EnsureLiveVerificationEnvironmentResult> {
  const fingerprint = deploymentFingerprint(release);
  const key = [
    release.orgId,
    release.projectId,
    release.integrationNodeId,
    release.artifactDigest,
    deploymentTarget,
    fingerprint,
    READY,
  ];
  const existing = await client.query<{ id: string }>(SELECT_READY_ENV, key);
  const found = existing.rows[0];
  if (found !== undefined) return { environmentId: found.id, created: false };

  const id = newId();
  // ON CONFLICT targets the 0082 partial unique index — a concurrent create (e.g. the deploy
  // path AND the demo resolver racing) collapses to one row without either duplicating.
  await client.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (org_id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint)
       WHERE lifecycle_status = 'ready' DO NOTHING`,
    [
      release.orgId,
      id,
      release.projectId,
      release.integrationNodeId,
      release.artifactDigest,
      deploymentTarget,
      fingerprint,
      release.releaseInstanceId,
      READY,
    ],
  );
  // Re-read on the identity so a concurrent winner's row (or ours) settles to a single id.
  const settled = await client.query<{ id: string }>(SELECT_READY_ENV, key);
  const row = settled.rows[0];
  if (row === undefined) {
    throw new Error(
      `verification environment find-or-create failed to settle for live release ${release.releaseInstanceId}`,
    );
  }
  return { environmentId: row.id, created: row.id === id };
}

/**
 * rv-premerge fix #2: find-or-create the run's REAL `integration_nodes` row the pre-merge
 * preview `verification_environments` row FKs. At the pre-merge point NO merge_batch node
 * exists yet (it is materialized later, in the merge-coordinator drive) and an eager_base node
 * exists only for jj-local dependents — so binding the preview env to the runId violates the
 * `verification_environments.integration_node_id → integration_nodes(node_id)` FK. This mints a
 * dedicated, run-unique `pre_merge_preview` node (migration 0086 purpose) instead: a plain
 * `status='ready'` row with a run-keyed `member_key`, idempotent on `(org_id, member_key)`. It
 * needs NO coverage-authority / jj workspace (it is not assembled by the merge coordinator).
 */
export async function ensurePreMergePreviewNode(
  client: QueryClient,
  input: { readonly orgId: string; readonly projectId: string; readonly runId: string; readonly headSha: string },
  newId: () => string = () => `inode_${randomUUID()}`,
): Promise<string> {
  const memberKey = `pre_merge_preview:${input.runId}`;
  const selectByKey = `SELECT node_id FROM integration_nodes WHERE org_id = $1 AND member_key = $2 LIMIT 1`;
  const existing = await client.query<{ node_id: string }>(selectByKey, [input.orgId, memberKey]);
  const found = existing.rows[0];
  if (found !== undefined) return found.node_id;

  const nodeId = newId();
  await client.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, status)
     VALUES ($1, $2, $3, 'pre_merge_preview', $4, $5, 'pre_merge_preview', '[]'::jsonb, $6, 'ready')
     ON CONFLICT (org_id, member_key) DO NOTHING`,
    [nodeId, input.projectId, input.orgId, input.headSha, `pre_merge_preview/${input.runId}`, memberKey],
  );
  // Re-read on the unique (org_id, member_key) so a concurrent winner (or our row) settles to one id.
  const settled = await client.query<{ node_id: string }>(selectByKey, [input.orgId, memberKey]);
  const row = settled.rows[0];
  if (row === undefined) {
    throw new Error(`pre-merge preview node find-or-create failed to settle for run ${input.runId}`);
  }
  return row.node_id;
}

/** Resolves the ready verification environment id for a run's live release. */
export interface VerificationEnvironmentResolver {
  resolveForLiveRelease(release: LiveReleaseBinding): Promise<string>;
}

/**
 * The production resolver: find-or-create (org-scoped, RLS) the ready environment for a live
 * release and return its id. Used by the post-deploy proof-backed demo so its acceptance run
 * persists a real behavior verdict against the deploy-created environment.
 */
export class PgVerificationEnvironmentResolver implements VerificationEnvironmentResolver {
  public constructor(private readonly pool: pg.Pool) {}

  public async resolveForLiveRelease(release: LiveReleaseBinding): Promise<string> {
    return runWithOrgScope(this.pool, release.orgId, async (client) => {
      const result = await ensureLiveVerificationEnvironment(client, release);
      return result.environmentId;
    });
  }
}
