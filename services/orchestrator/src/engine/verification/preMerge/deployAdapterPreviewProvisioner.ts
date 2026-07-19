// rv-premerge — the REAL preview surface provisioner behind the pre-merge behavior gate.
//
// The first-prod caller of `DeployAdapter.applyPreview`: resolve the project's deploy target
// (`resolveDeployTarget` over `projects.config`), mint a per-operation deploy `OrgGrant`
// (`loadDeployOperationGrant`, the SAME integration authority the post-merge deploy uses),
// build the `direct_api` DeployAdapter, and `applyPreview` the PR head to an ephemeral
// preview; then bind it to the run's REAL `pre_merge_preview` `integration_nodes` node and a
// `deployment_target='preview'` `verification_environments` row the acceptance run persists
// against, and expose `teardown` to reap the deployed preview.
//
// FIX #2 (leak-safe + real node): at pre-merge NO merge_batch node exists yet, so we MINT a
// dedicated `pre_merge_preview` node (`ensurePreMergePreviewNode`) for the run and bind the env
// + release to its REAL node_id — never the runId (which is not a node_id and violated the FK,
// failing the gate closed on every run). `applyPreview` (the live deploy) is wrapped so that if
// the SUBSEQUENT env bind throws, the deployed preview is torn down — no leaked previews.
//
// FAIL-CLOSED: a project with NO deploy target — or a non-web provider (no HTTP preview
// surface) — resolves `no_surface` (the producer returns `not_applicable`, merge on CI alone).
// A configured web target whose grant/apply/persist FAILS resolves `failed` (the producer
// blocks the merge). NON-SECRET: the deploy token never reaches this file — it is resolved
// inside the provisioner from the grant's credential ref and flows only into the provider bearer.

import { createHash } from "node:crypto";
import { runWithOrgScope, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { type Digest, parseDigest } from "../../contracts/cas.js";
import type { DeployProvisionerDeps } from "../../provisioners/deployProvisioner.js";
import type { BehaviorRevisionId } from "../../contracts/behaviorRevision.js";
import { buildDeployAdapter, DIRECT_API_ADAPTER_KIND } from "../../deploy/buildDeployAdapter.js";
import { PgReleaseInstancesRepository } from "../../repositories/pgReleaseInstances.js";
import {
  ensurePreMergePreviewNode,
  ensurePreviewVerificationEnvironment,
} from "../../repositories/verificationEnvironments.js";
import { loadDeployOperationGrant } from "../../postMerge/deployOnMergeAuthority.js";
import { DEPLOY_PROVIDER_KINDS, resolveDeployTarget } from "../../postMerge/deployTargetResolution.js";
import type {
  PreMergeBehaviorGateInput,
  PreviewProvisionResult,
  PreviewSurface,
  PreviewSurfaceProvisioner,
} from "./preMergeBehaviorGateProducer.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("pre-merge-behavior-gate");
type DeployTarget = { provider: string; appId: string };
/** The DeployAdapter surface this provisioner uses (test seam narrows to what it calls). */
type PreviewAdapter = Pick<ReturnType<typeof buildDeployAdapter>, "applyPreview" | "teardownPreview">;
/** The deploy-grant loader (production → `loadDeployOperationGrant`; injectable for tests). */
export type LoadDeployGrant = typeof loadDeployOperationGrant;

/** Optional test seams; production defaults to the real deploy adapter + grant authority. */
export interface PreviewProvisionerSeams {
  readonly adapter?: PreviewAdapter;
  readonly loadGrant?: LoadDeployGrant;
}

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
  private readonly adapter: PreviewAdapter;
  private readonly loadGrant: LoadDeployGrant;

  public constructor(
    private readonly pool: pg.Pool,
    provisioner: DeployProvisionerDeps,
    seams: PreviewProvisionerSeams = {},
  ) {
    this.adapter =
      seams.adapter ??
      buildDeployAdapter(DIRECT_API_ADAPTER_KIND, {
        provisioner,
        releaseInstances: new PgReleaseInstancesRepository(pool),
      });
    this.loadGrant = seams.loadGrant ?? loadDeployOperationGrant;
  }

  public async provision(
    input: PreMergeBehaviorGateInput,
    behaviorRevisionIds: readonly BehaviorRevisionId[],
  ): Promise<PreviewProvisionResult> {
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
      return await this.deployAndBind(input, target, behaviorRevisionIds);
    } catch (error) {
      // A configured web target that could not deploy/apply/persist ⇒ fail-closed (block).
      return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async deployAndBind(
    input: PreMergeBehaviorGateInput,
    target: DeployTarget,
    behaviorRevisionIds: readonly BehaviorRevisionId[],
  ): Promise<PreviewProvisionResult> {
    const repo = repoSlugOf(input.repoUrl);
    const artifactDigest = previewSourceDigest(repo, input.headSha);
    const ref = { provider: target.provider, appId: target.appId };
    const grant = await this.loadGrant(
      this.pool,
      input.projectId,
      { provider: target.provider, orgId: input.orgId },
      "deploy",
      {
        resourceId: target.appId,
        sourceRepo: repo,
        sourceRef: input.headSha,
      },
    );
    if (grant === undefined) {
      return { kind: "failed", reason: `no eligible '${target.provider}' deploy grant for the preview` };
    }
    // FIX #2: mint the run's REAL pre_merge_preview node BEFORE the env binds to it (the env
    // FKs integration_nodes.node_id). Cheap, idempotent, needs no coverage-authority workspace.
    const integrationNodeId = await runWithOrgScope(this.pool, input.orgId, (client) =>
      ensurePreMergePreviewNode(client, {
        orgId: input.orgId,
        projectId: input.projectId,
        runId: input.runId,
        headSha: input.headSha,
      }),
    );
    const preview = await this.adapter.applyPreview(grant, ref, {
      source: { repo, ref: input.headSha },
      artifactDigest,
      integrationNodeId,
      behaviorRevisionIds,
    });
    // The preview is DEPLOYED. If the env bind throws, tear the deployed preview down so no
    // preview leaks (apex-v96 machine-accumulation), then re-throw → the outer catch → `failed`.
    const environmentId = await this.bindEnvironmentOrReap(
      input,
      ref,
      grant,
      integrationNodeId,
      artifactDigest,
      preview,
    );
    return {
      kind: "provisioned",
      surface: {
        deploymentId: preview.deploymentId,
        url: preview.url,
        integrationNodeId,
        artifactDigest,
        environmentId,
        orgId: input.orgId,
        projectId: input.projectId,
        provider: target.provider,
        appId: target.appId,
      },
    };
  }

  private async bindEnvironmentOrReap(
    input: PreMergeBehaviorGateInput,
    ref: DeployTarget,
    grant: Awaited<ReturnType<typeof loadDeployOperationGrant>> & object,
    integrationNodeId: string,
    artifactDigest: Digest,
    preview: { deploymentId: string; url: string },
  ): Promise<string> {
    try {
      return await runWithOrgScope(this.pool, input.orgId, (client) =>
        ensurePreviewVerificationEnvironment(client, {
          orgId: input.orgId,
          projectId: input.projectId,
          integrationNodeId,
          artifactDigest,
          releaseInstanceId: preview.deploymentId,
          url: preview.url,
        }).then((result) => result.environmentId),
      );
    } catch (bindError) {
      await this.adapter.teardownPreview(grant, ref, preview.deploymentId).catch((teardownError: unknown) => {
        log.warn("pre-merge preview teardown after env-bind failure failed (preview may leak)", {
          runId: input.runId,
          deploymentId: preview.deploymentId,
          reason: teardownError instanceof Error ? teardownError.message : String(teardownError),
        });
      });
      throw bindError;
    }
  }

  public async teardown(surface: PreviewSurface): Promise<void> {
    const grant = await this.loadGrant(
      this.pool,
      surface.projectId,
      { provider: surface.provider, orgId: surface.orgId },
      "deploy",
      { resourceId: surface.appId, deploymentId: surface.deploymentId },
    );
    if (grant === undefined) throw new Error("pre-merge preview teardown: no eligible deploy grant");
    await this.adapter.teardownPreview(
      grant,
      { provider: surface.provider, appId: surface.appId },
      surface.deploymentId,
    );
  }

  private async resolveTarget(input: PreMergeBehaviorGateInput): Promise<DeployTarget | undefined> {
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
