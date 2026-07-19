// rv-premerge — the REAL preview surface provisioner behind the pre-merge behavior gate.
//
// The first-prod caller of `DeployAdapter.applyPreview`: resolve the project's deploy target
// (`resolveDeployTarget` over `projects.config`), mint a per-operation deploy `OrgGrant`
// (`loadDeployOperationGrant`, the SAME integration authority the post-merge deploy uses),
// build the `direct_api` DeployAdapter, and `applyPreview` the PR head to an ephemeral
// preview; then find-or-create the `deployment_target='preview'` `verification_environments`
// row the acceptance run persists against, and expose `teardown` to reap the preview.
//
// FAIL-CLOSED: a project with NO deploy target — or a non-web provider (no HTTP preview
// surface) — resolves `no_surface` (the producer returns `not_applicable`, merge on CI
// alone). A configured web target whose grant/apply/persist FAILS resolves `failed` (the
// producer blocks the merge). Teardown reaps the preview even on failure (apex-v96 lesson).
//
// NON-SECRET: the deploy token never reaches this file — it is resolved inside the
// provisioner from the grant's credential ref and flows only into the provider bearer.

import { createHash } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { type Digest, parseDigest } from "../../contracts/cas.js";
import type { DeployProvisionerDeps } from "../../provisioners/deployProvisioner.js";
import type { BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import { buildDeployAdapter, DIRECT_API_ADAPTER_KIND } from "../../deploy/buildDeployAdapter.js";
import { PgReleaseInstancesRepository } from "../../repositories/pgReleaseInstances.js";
import { ensurePreviewVerificationEnvironment } from "../../repositories/verificationEnvironments.js";
import { loadDeployOperationGrant } from "../../postMerge/deployOnMergeAuthority.js";
import { DEPLOY_PROVIDER_KINDS, resolveDeployTarget } from "../../postMerge/deployTargetResolution.js";
import type {
  PreMergeBehaviorGateInput,
  PreviewProvisionResult,
  PreviewSurface,
  PreviewSurfaceProvisioner,
} from "./preMergeBehaviorGateProducer.js";

type QueryClient = Pick<pg.PoolClient, "query">;

/** `owner/name` from a GitHub repo URL (`https://github.com/owner/name(.git)`). */
function repoSlugOf(repoUrl: string): string {
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(repoUrl.trim());
  if (match === null) throw new Error(`pre-merge preview: unrecognized GitHub repo url '${repoUrl}'`);
  return `${match[1]}/${match[2]}`;
}

/**
 * A deterministic, non-secret identity for the exact source the preview deploys (its repo +
 * head sha). Stable across idempotent re-previews of the same head; it is the artifact
 * identity bound onto the preview release + its `verification_environments` row (the real
 * verification signal is the HTTP acceptance against the preview URL, not this digest).
 */
function previewSourceDigest(repo: string, headSha: string): Digest {
  return parseDigest(`sha256:${createHash("sha256").update(`${repo}\n${headSha}`, "utf8").digest("hex")}`);
}

/** The deploy-stack preview provisioner — the real, first-prod `applyPreview` caller. */
export class DeployAdapterPreviewSurfaceProvisioner implements PreviewSurfaceProvisioner {
  private readonly adapter: ReturnType<typeof buildDeployAdapter>;

  public constructor(
    private readonly pool: pg.Pool,
    provisioner: DeployProvisionerDeps,
  ) {
    this.adapter = buildDeployAdapter(DIRECT_API_ADAPTER_KIND, {
      provisioner,
      releaseInstances: new PgReleaseInstancesRepository(pool),
    });
  }

  public async provision(input: PreMergeBehaviorGateInput): Promise<PreviewProvisionResult> {
    const target = await this.resolveTarget(input);
    if (target === undefined) {
      return { kind: "no_surface", reason: "project configures no deploy target — no preview surface to verify" };
    }
    // Only the web deploy providers have an HTTP preview surface; any other kind (manual /
    // package / mobile) has no preview to drive rv-6 against ⇒ not_applicable (merge on CI).
    if (!DEPLOY_PROVIDER_KINDS.has(target.provider)) {
      return {
        kind: "no_surface",
        reason: `deploy provider '${target.provider}' has no web preview surface for pre-merge verification`,
      };
    }
    try {
      return await this.deployAndBind(input, target);
    } catch (error) {
      // A configured web target that could not deploy/apply/persist ⇒ fail-closed (block).
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async deployAndBind(
    input: PreMergeBehaviorGateInput,
    target: { provider: string; appId: string },
  ): Promise<PreviewProvisionResult> {
    const repo = repoSlugOf(input.repoUrl);
    const artifactDigest = previewSourceDigest(repo, input.headSha);
    const grant = await loadDeployOperationGrant(
      this.pool,
      input.projectId,
      { provider: target.provider, orgId: input.orgId },
      "deploy",
      { resourceId: target.appId, sourceRepo: repo, sourceRef: input.headSha },
    );
    if (grant === undefined) {
      return { kind: "failed", reason: `no eligible '${target.provider}' deploy grant for the preview` };
    }
    const preview = await this.adapter.applyPreview(
      grant,
      { provider: target.provider, appId: target.appId },
      {
        source: { repo, ref: input.headSha },
        artifactDigest,
        integrationNodeId: input.runId,
        behaviorRevisionIds: input.behaviorRevisionIds as readonly BehaviorRevisionId[],
      },
    );
    const environmentId = await runWithOrgScope(this.pool, input.orgId, (client) =>
      ensurePreviewVerificationEnvironment(client, {
        orgId: input.orgId,
        projectId: input.projectId,
        integrationNodeId: input.runId,
        artifactDigest,
        releaseInstanceId: preview.deploymentId,
        url: preview.url,
      }).then((result) => result.environmentId),
    );
    return {
      kind: "provisioned",
      surface: {
        deploymentId: preview.deploymentId,
        url: preview.url,
        integrationNodeId: input.runId,
        artifactDigest,
        environmentId,
      },
    };
  }

  public async teardown(surface: PreviewSurface): Promise<void> {
    // A read error propagates to the producer's best-effort tearDown (logged); a genuinely
    // absent release row (target undefined) means there is nothing to reap here.
    const target = await runWithSystemScope(this.pool, (client) =>
      readDeployProviderApp(client, surface.integrationNodeId),
    );
    if (target === undefined) return;
    const grant = await loadDeployOperationGrant(
      this.pool,
      surface.integrationNodeId,
      { provider: target.provider, orgId: surface.integrationNodeId },
      "deploy",
      { resourceId: target.appId, deploymentId: surface.deploymentId },
    );
    if (grant === undefined) throw new Error("pre-merge preview teardown: no eligible deploy grant");
    await this.adapter.teardownPreview(grant, { provider: target.provider, appId: target.appId }, surface.deploymentId);
  }

  private async resolveTarget(
    input: PreMergeBehaviorGateInput,
  ): Promise<{ provider: string; appId: string } | undefined> {
    return runWithSystemScope(this.pool, async (client) => {
      const row = (
        await client.query<{ config: unknown; org_id: string | null }>(
          "SELECT config, org_id FROM projects WHERE project_id = $1 AND org_id = $2",
          [input.projectId, input.orgId],
        )
      ).rows[0];
      const config =
        row?.config !== null && typeof row?.config === "object" && !Array.isArray(row.config)
          ? (row.config as Record<string, unknown>)
          : {};
      // deployIntent=false: absent config is simply "no preview surface", never a loud halt —
      // pre-merge behavior gating is opt-in and must not block a project with no deploy target.
      const resolution =
        row !== undefined && row.org_id === input.orgId
          ? resolveDeployTarget({ orgId: input.orgId, config, deployIntent: false })
          : ({ kind: "none" } as const);
      return resolution.kind === "configured"
        ? { provider: resolution.target.provider, appId: resolution.target.appId }
        : undefined;
    });
  }
}

/** Read the project's deploy provider/app for a preview release's integration node (teardown). */
async function readDeployProviderApp(
  client: QueryClient,
  integrationNodeId: string,
): Promise<{ provider: string; appId: string } | undefined> {
  const row = (
    await client.query<{ provider: string; app_id: string }>(
      `SELECT provider, app_id FROM release_instances
        WHERE integration_node_id = $1 AND deployment_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [integrationNodeId],
    )
  ).rows[0];
  return row === undefined ? undefined : { provider: row.provider, appId: row.app_id };
}
