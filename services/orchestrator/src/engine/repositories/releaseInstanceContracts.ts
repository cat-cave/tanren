// cspell:ignore hashtextextended
import type pg from "pg";
import { z } from "zod";
import type { ReleaseEnvironment, ReleaseInstanceRecord, ReleaseState } from "../contracts/deployAdapter.js";
import type { Digest, ProviderChecksum } from "../contracts/cas.js";
import type { BehaviorRevisionId } from "../contracts/behaviorRevision.js";
export type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;
export const RELEASE_STATES = [
  "built",
  "preview",
  "promoting",
  "live",
  "superseded",
  "rolled_back",
  "torn_down",
  "failed",
] as const;
export const RELEASE_ENVIRONMENTS = ["preview", "production"] as const;
export const ReleaseStateValue = z.enum(RELEASE_STATES);
export const ReleaseEnvironmentValue = z.enum(RELEASE_ENVIRONMENTS);
export const RELEASE_COLUMNS = `
  ri.org_id, ri.id, ri.project_id, ri.provider, ri.app_id, ri.environment,
  ri.deployment_id, ri.source_ref, ri.artifact_digest, ri.provider_checksum,
  ri.integration_node_id, ri.url, ri.region, ri.previous_release_instance_id,
  ri.state, ri.created_at,
  COALESCE(
    array_agg(rbr.behavior_revision_id ORDER BY rbr.ordinal)
      FILTER (WHERE rbr.behavior_revision_id IS NOT NULL),
    ARRAY[]::text[]
  ) AS behavior_revision_ids`;
export interface RawReleaseInstanceRow {
  org_id: unknown;
  id: unknown;
  project_id: unknown;
  provider: unknown;
  app_id: unknown;
  environment: unknown;
  deployment_id: unknown;
  source_ref: unknown;
  artifact_digest: unknown;
  provider_checksum: unknown;
  integration_node_id: unknown;
  url: unknown;
  region: unknown;
  previous_release_instance_id: unknown;
  state: unknown;
  created_at: unknown;
  behavior_revision_ids: unknown;
}
export interface CreateReleaseInstanceInput {
  orgId: string;
  projectId: string;
  provider: string;
  appId: string;
  environment: ReleaseEnvironment;
  deploymentId: string;
  sourceRef: string;
  artifactDigest: Digest;
  providerChecksum: ProviderChecksum | null;
  integrationNodeId: string;
  behaviorRevisionIds?: readonly BehaviorRevisionId[];
  url?: string;
  region?: string | null;
  previousReleaseInstanceId?: string | null;
  state?: ReleaseState;
  releaseInstanceId?: string;
}
export interface TransitionReleaseInstanceInput {
  orgId: string;
  releaseInstanceId: string;
  state: ReleaseState;
  environment?: ReleaseEnvironment;
  url?: string;
  deploymentId?: string;
  previousReleaseInstanceId?: string | null;
}
export interface SupersedePriorLiveInput {
  orgId: string;
  projectId: string;
  provider: string;
  appId: string;
  exceptReleaseInstanceId?: string;
  releaseInstanceId?: string | null;
}
export interface GetReleaseInstanceByDeploymentInput {
  orgId: string;
  provider: string;
  appId: string;
  deploymentId: string;
}
export interface PromoteReleaseInput {
  orgId: string;
  projectId: string;
  provider: string;
  appId: string;
  deploymentId: string;
  promotedDeploymentId: string;
  artifactDigest: Digest;
  previousReleaseInstanceId: string | null;
  url: string;
}
export interface RollbackReleaseInput {
  orgId: string;
  projectId: string;
  releaseInstanceId: string;
  targetArtifactDigest: Digest;
  deploymentId: string;
  url: string;
}
export interface TeardownPreviewInput {
  orgId: string;
  provider: string;
  appId: string;
  deploymentId: string;
}
export interface MarkLiveReleaseInput {
  orgId: string;
  projectId: string;
  provider: string;
  appId: string;
  deploymentId: string;
  url: string;
}
export interface ReleaseInstancesRepository {
  create(input: CreateReleaseInstanceInput): Promise<ReleaseInstanceRecord>;
  getById(orgId: string, releaseInstanceId: string): Promise<ReleaseInstanceRecord | undefined>;
  getByDeployment(input: GetReleaseInstanceByDeploymentInput): Promise<ReleaseInstanceRecord | undefined>;
  listForProject(orgId: string, projectId: string): Promise<ReleaseInstanceRecord[]>;
  transition(input: TransitionReleaseInstanceInput): Promise<ReleaseInstanceRecord>;
  supersedePriorLive(input: SupersedePriorLiveInput): Promise<ReleaseInstanceRecord | undefined>;
  applyPreview(input: CreateReleaseInstanceInput): Promise<ReleaseInstanceRecord>;
  promote(input: PromoteReleaseInput): Promise<ReleaseInstanceRecord>;
  rollback(input: RollbackReleaseInput): Promise<ReleaseInstanceRecord>;
  teardownPreview(input: TeardownPreviewInput): Promise<ReleaseInstanceRecord | undefined>;
  markLive(input: MarkLiveReleaseInput): Promise<ReleaseInstanceRecord>;
}
export class ReleaseInstanceNotFoundError extends Error {
  override readonly name = "ReleaseInstanceNotFoundError";
  constructor(readonly releaseInstanceId: string) {
    super(`release instance ${releaseInstanceId} not found`);
  }
}
export class InvalidReleaseStateTransitionError extends Error {
  override readonly name = "InvalidReleaseStateTransitionError";
  constructor(
    readonly releaseInstanceId: string,
    readonly from: ReleaseState,
    readonly to: ReleaseState,
  ) {
    super(`release instance ${releaseInstanceId} cannot transition from ${from} to ${to}`);
  }
}

export const VALID_TRANSITIONS: Record<ReleaseState, readonly ReleaseState[]> = {
  built: ["built", "preview", "live", "rolled_back", "failed"],
  preview: ["preview", "promoting", "torn_down", "failed"],
  promoting: ["promoting", "live", "failed"],
  live: ["live", "superseded", "rolled_back", "failed"],
  superseded: ["superseded", "rolled_back"],
  rolled_back: ["rolled_back"],
  torn_down: ["torn_down"],
  failed: ["failed"],
};
