// cspell:ignore iloop sfind

import type pg from "pg";
import { z } from "zod";
export type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export const ISSUE_LOOP_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const ISSUE_LOOP_STATES = [
  "open",
  "awaiting_reproduction",
  "reproduced",
  "triaged",
  "remediating",
  "verifying",
  "verified_source_sync_pending",
  "verified_closed",
  "externally_closed_unverified",
  "needs_attention",
  "wont_fix",
] as const;
export const ISSUE_LOOP_RESOLUTION_POLICIES = [
  "active_causal",
  "active_plus_soak",
  "observational",
  "attested",
] as const;
export const SOURCE_FINDING_STATUSES = ["open", "closed", "reopened", "edited", "deleted", "unknown"] as const;
export const ISSUE_LOOP_RELATIONS = ["duplicate_of", "supersedes", "regression_of", "caused_by", "split_from"] as const;

const IssueLoopSeverity = z.enum(ISSUE_LOOP_SEVERITIES);
export type IssueLoopSeverity = z.infer<typeof IssueLoopSeverity>;
const IssueLoopState = z.enum(ISSUE_LOOP_STATES);
export type IssueLoopState = z.infer<typeof IssueLoopState>;
const IssueLoopResolutionPolicy = z.enum(ISSUE_LOOP_RESOLUTION_POLICIES);
export type IssueLoopResolutionPolicy = z.infer<typeof IssueLoopResolutionPolicy>;
const SourceFindingStatus = z.enum(SOURCE_FINDING_STATUSES);
export type SourceFindingStatus = z.infer<typeof SourceFindingStatus>;
const IssueLoopRelation = z.enum(ISSUE_LOOP_RELATIONS);
export type IssueLoopRelation = z.infer<typeof IssueLoopRelation>;
const JsonRecord = z.record(z.string(), z.unknown());

export const IssueLoopRow = z.object({
  orgId: z.string().min(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceId: z.string().min(1),
  externalKey: z.string().min(1),
  generation: z.number().int().min(1),
  fingerprint: z.string().min(1),
  severity: IssueLoopSeverity,
  state: IssueLoopState,
  sourceRevisionId: z.string().nullable(),
  currentContractId: z.string().nullable(),
  currentAttemptId: z.string().nullable(),
  resolutionPolicy: IssueLoopResolutionPolicy,
  rowVersion: z.number().int().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type IssueLoopRow = z.infer<typeof IssueLoopRow>;
export const SourceFindingRow = z.object({
  orgId: z.string().min(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  issueLoopId: z.string().min(1),
  sourceId: z.string().min(1),
  providerObjectId: z.string().min(1),
  providerRevision: z.string().min(1),
  deliveryId: z.string().nullable(),
  status: SourceFindingStatus,
  release: z.string().nullable(),
  environment: z.string().nullable(),
  title: z.string(),
  body: z.string(),
  context: JsonRecord,
  fingerprint: z.string().min(1),
  observedAt: z.date(),
  rawArtifactRef: z.string().nullable(),
  createdAt: z.date(),
});
export type SourceFindingRow = z.infer<typeof SourceFindingRow>;
export interface RawIssueLoopRow {
  org_id: unknown;
  id: unknown;
  project_id: unknown;
  source_id: unknown;
  external_key: unknown;
  generation: unknown;
  fingerprint: unknown;
  severity: unknown;
  state: unknown;
  source_revision_id: unknown;
  current_contract_id: unknown;
  current_attempt_id: unknown;
  resolution_policy: unknown;
  row_version: unknown;
  created_at: unknown;
  updated_at: unknown;
}

export interface RawSourceFindingRow {
  org_id: unknown;
  id: unknown;
  project_id: unknown;
  issue_loop_id: unknown;
  source_id: unknown;
  provider_object_id: unknown;
  provider_revision: unknown;
  delivery_id: unknown;
  status: unknown;
  release: unknown;
  environment: unknown;
  title: unknown;
  body: unknown;
  context: unknown;
  fingerprint: unknown;
  observed_at: unknown;
  raw_artifact_ref: unknown;
  created_at: unknown;
}

export const ISSUE_LOOP_COLUMNS = `
  org_id, id, project_id, source_id, external_key, generation, fingerprint,
  severity, state, source_revision_id, current_contract_id, current_attempt_id,
  resolution_policy, row_version, created_at, updated_at
`;

export const SOURCE_FINDING_COLUMNS = `
  org_id, id, project_id, issue_loop_id, source_id, provider_object_id,
  provider_revision, delivery_id, status, release, environment, title, body,
  context, fingerprint, observed_at, raw_artifact_ref, created_at
`;

export function decodeIssueLoop(row: RawIssueLoopRow): IssueLoopRow {
  return IssueLoopRow.parse({
    orgId: row.org_id,
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    externalKey: row.external_key,
    generation: Number(row.generation),
    fingerprint: row.fingerprint,
    severity: row.severity,
    state: row.state,
    sourceRevisionId: row.source_revision_id,
    currentContractId: row.current_contract_id,
    currentAttemptId: row.current_attempt_id,
    resolutionPolicy: row.resolution_policy,
    rowVersion: Number(row.row_version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export function decodeSourceFinding(row: RawSourceFindingRow): SourceFindingRow {
  return SourceFindingRow.parse({
    orgId: row.org_id,
    id: row.id,
    projectId: row.project_id,
    issueLoopId: row.issue_loop_id,
    sourceId: row.source_id,
    providerObjectId: row.provider_object_id,
    providerRevision: row.provider_revision,
    deliveryId: row.delivery_id,
    status: row.status,
    release: row.release,
    environment: row.environment,
    title: row.title,
    body: row.body,
    context: row.context,
    fingerprint: row.fingerprint,
    observedAt: row.observed_at,
    rawArtifactRef: row.raw_artifact_ref,
    createdAt: row.created_at,
  });
}

export interface CreateIssueLoopInput {
  orgId: string;
  projectId: string;
  sourceId: string;
  externalKey: string;
  fingerprint: string;
  severity: IssueLoopSeverity;
  generation?: number;
  state?: IssueLoopState;
  sourceRevisionId?: string | null;
  resolutionPolicy?: IssueLoopResolutionPolicy;
}
export interface AppendSourceFindingInput {
  orgId: string;
  projectId: string;
  issueLoopId: string;
  sourceId: string;
  providerObjectId: string;
  providerRevision: string;
  status: SourceFindingStatus;
  title: string;
  fingerprint: string;
  observedAt: Date;
  deliveryId?: string | null;
  release?: string | null;
  environment?: string | null;
  body?: string;
  context?: Record<string, unknown>;
  rawArtifactRef?: string | null;
}
export interface LinkIssueLoopEdgeInput {
  orgId: string;
  projectId: string;
  issueLoopId: string;
  relatedIssueLoopId: string;
  relation: IssueLoopRelation;
}
export interface UpsertIssueLoopForSourceInput {
  orgId: string;
  projectId: string;
  sourceId: string;
  externalKey: string;
  fingerprint: string;
  severity: IssueLoopSeverity;
  sourceRevisionId?: string | null;
  generation?: number;
  resolutionPolicy?: IssueLoopResolutionPolicy;
}
export interface AppendSourceFindingResult {
  finding: SourceFindingRow;
  inserted: boolean;
}
export interface TransitionIssueLoopInput {
  orgId: string;
  projectId: string;
  issueLoopId: string;
  toState: IssueLoopState;
  fromState?: IssueLoopState;
  fromStates?: readonly IssueLoopState[];
}
export interface TransitionIssueLoopResult {
  loop: IssueLoopRow;
  changed: boolean;
}
export class IssueLoopNotFoundError extends Error {
  override readonly name = "IssueLoopNotFoundError";
  constructor(readonly loopId: string) {
    super(`issue loop ${loopId} not found`);
  }
}
