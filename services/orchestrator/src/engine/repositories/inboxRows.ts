import { z } from "zod";
import {
  Candidate,
  CandidateTriage,
  InboxSource,
  SourceKind,
  parsePersistedInboxSourceConfig,
} from "../forge/inbox/types.js";

export const SourceRowSchema = z
  .object({
    id: z.string(),
    org_id: z.string(),
    project_id: z.string().nullable(),
    kind: z.string(),
    name: z.string(),
    detail: z.string(),
    config: z.record(z.string(), z.unknown()).nullable(),
    enabled: z.string(),
    auto_route: z.string(),
    state: z.string(),
    attention_code: z.string().nullable(),
    attention_message: z.string().nullable(),
    attention_observed_at: z.union([z.date(), z.string()]).nullable(),
    webhook_configured: z.boolean(),
    retry_not_before: z.union([z.date(), z.string()]).nullable(),
    project_valid: z.boolean().optional(),
  })
  .strict();

export type SourceRow = z.infer<typeof SourceRowSchema>;

export interface CandidateRow {
  id: string;
  source_id: string;
  org_id: string;
  project_id: string | null;
  external_id: string;
  title: string;
  body: string;
  severity: string;
  status: string;
  triage: unknown;
  resolved_spec_id: string | null;
  source_name: string | null;
  source_kind: string | null;
}

export interface InboxSourceReadFailure {
  id: string;
  orgId: string;
  projectId: string | null;
}

export class InboxSourceProjectScopeError extends Error {
  constructor() {
    super("inbox source project does not belong to its organization");
    this.name = "InboxSourceProjectScopeError";
  }
}

export class InboxSourceDecodeError extends Error {
  readonly source: InboxSourceReadFailure;

  constructor(row: SourceRow) {
    super("persisted inbox source config is not canonical");
    this.name = "InboxSourceDecodeError";
    this.source = {
      id: row.id,
      orgId: row.org_id,
      projectId: row.project_valid === false ? null : row.project_id,
    };
  }
}

export function mapSource(raw: SourceRow): InboxSource {
  const row = SourceRowSchema.parse(raw);
  if (row.project_valid === false) throw new InboxSourceProjectScopeError();
  const kind = SourceKind.parse(row.kind);
  const config = row.config === null ? null : parsePersistedInboxSourceConfig(kind, row.config);
  const observedAt = isoOrNull(row.attention_observed_at);
  const attention =
    row.attention_code === null || row.attention_message === null || observedAt === null
      ? null
      : { code: row.attention_code, message: row.attention_message, observedAt };
  return InboxSource.parse({
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    kind,
    name: row.name,
    detail: row.detail,
    config,
    enabled: row.enabled === "true",
    autoRoute: row.auto_route === "true",
    state: row.state,
    attention,
    retryNotBefore: isoOrNull(row.retry_not_before),
    webhookConfigured: row.webhook_configured,
  });
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function mapCandidate(row: CandidateRow): Candidate {
  const triageRaw = row.triage;
  const hasTriage = triageRaw !== null && typeof triageRaw === "object" && Object.keys(triageRaw).length > 0;
  return Candidate.parse({
    id: row.id,
    sourceId: row.source_id,
    orgId: row.org_id,
    projectId: row.project_id,
    externalId: row.external_id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    status: row.status,
    triage: hasTriage ? CandidateTriage.parse(triageRaw) : null,
    resolvedSpecId: row.resolved_spec_id,
    sourceName: row.source_name ?? "",
    sourceKind: SourceKind.parse(row.source_kind ?? "manual"),
  });
}
