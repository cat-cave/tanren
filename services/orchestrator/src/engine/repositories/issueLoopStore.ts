// cspell:ignore sfind
import { randomUUID } from "node:crypto";
import {
  decodeIssueLoop,
  decodeSourceFinding,
  ISSUE_LOOP_COLUMNS,
  SOURCE_FINDING_COLUMNS,
  type AppendSourceFindingInput,
  type AppendSourceFindingResult,
  type CreateIssueLoopInput,
  type IssueLoopRow,
  IssueLoopNotFoundError,
  type LinkIssueLoopEdgeInput,
  type QueryClient,
  type SourceFindingRow,
  type TransitionIssueLoopInput,
  type TransitionIssueLoopResult,
  type UpsertIssueLoopForSourceInput,
  type RawIssueLoopRow,
  type RawSourceFindingRow,
} from "./issueLoopContracts.js";

// The aggregate store owns SQL mutations and reads; its contract/decoders remain
// independently importable for adapters that only need validation shapes.
export const IssueLoopStore = {
  async create(client: QueryClient, input: CreateIssueLoopInput): Promise<IssueLoopRow> {
    const id = `iloop_${randomUUID()}`;
    const result = await client.query<RawIssueLoopRow>(
      `INSERT INTO issue_loops
         (org_id, id, project_id, source_id, external_key, generation, fingerprint,
          severity, state, source_revision_id, resolution_policy, row_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, now())
       RETURNING ${ISSUE_LOOP_COLUMNS}`,
      [
        input.orgId,
        id,
        input.projectId,
        input.sourceId,
        input.externalKey,
        input.generation ?? 1,
        input.fingerprint,
        input.severity,
        input.state ?? "open",
        input.sourceRevisionId ?? null,
        input.resolutionPolicy ?? "active_causal",
      ],
    );
    return decodeIssueLoop(result.rows[0]!);
  },

  async upsertForSource(client: QueryClient, input: UpsertIssueLoopForSourceInput) {
    const id = `iloop_${randomUUID()}`;
    const result = await client.query<RawIssueLoopRow>(
      `INSERT INTO issue_loops
         (org_id, id, project_id, source_id, external_key, generation, fingerprint,
          severity, state, source_revision_id, resolution_policy, row_version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10, 1, now())
       ON CONFLICT (org_id, source_id, external_key, generation) DO NOTHING
       RETURNING ${ISSUE_LOOP_COLUMNS}`,
      [
        input.orgId,
        id,
        input.projectId,
        input.sourceId,
        input.externalKey,
        input.generation ?? 1,
        input.fingerprint,
        input.severity,
        input.sourceRevisionId ?? null,
        input.resolutionPolicy ?? "active_causal",
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) return { loop: decodeIssueLoop(inserted), created: true };
    const existing = await client.query<RawIssueLoopRow>(
      `SELECT ${ISSUE_LOOP_COLUMNS}
         FROM issue_loops
        WHERE org_id = $1 AND source_id = $2 AND external_key = $3 AND generation = $4`,
      [input.orgId, input.sourceId, input.externalKey, input.generation ?? 1],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new IssueLoopNotFoundError(input.externalKey);
    return { loop: decodeIssueLoop(row), created: false };
  },

  async get(client: QueryClient, orgId: string, projectId: string, loopId: string): Promise<IssueLoopRow | undefined> {
    const result = await client.query<RawIssueLoopRow>(
      `SELECT ${ISSUE_LOOP_COLUMNS}
         FROM issue_loops
        WHERE org_id = $1 AND project_id = $2 AND id = $3`,
      [orgId, projectId, loopId],
    );
    return result.rows[0] === undefined ? undefined : decodeIssueLoop(result.rows[0]);
  },

  async getById(client: QueryClient, orgId: string, loopId: string): Promise<IssueLoopRow | undefined> {
    const result = await client.query<RawIssueLoopRow>(
      `SELECT ${ISSUE_LOOP_COLUMNS} FROM issue_loops WHERE org_id = $1 AND id = $2`,
      [orgId, loopId],
    );
    return result.rows[0] === undefined ? undefined : decodeIssueLoop(result.rows[0]);
  },

  async listForProject(
    client: QueryClient,
    orgId: string,
    projectId: string,
    options?: { limit?: number },
  ): Promise<IssueLoopRow[]> {
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
    const result = await client.query<RawIssueLoopRow>(
      `SELECT ${ISSUE_LOOP_COLUMNS}
         FROM issue_loops
        WHERE org_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [orgId, projectId, limit],
    );
    return result.rows.map((row) => decodeIssueLoop(row));
  },

  async appendFinding(client: QueryClient, input: AppendSourceFindingInput): Promise<SourceFindingRow> {
    const id = `sfind_${randomUUID()}`;
    const result = await client.query<RawSourceFindingRow>(
      `INSERT INTO source_findings
         (org_id, id, project_id, issue_loop_id, source_id, provider_object_id,
          provider_revision, delivery_id, status, release, environment, title, body,
          context, fingerprint, observed_at, raw_artifact_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17)
       RETURNING ${SOURCE_FINDING_COLUMNS}`,
      [
        input.orgId,
        id,
        input.projectId,
        input.issueLoopId,
        input.sourceId,
        input.providerObjectId,
        input.providerRevision,
        input.deliveryId ?? null,
        input.status,
        input.release ?? null,
        input.environment ?? null,
        input.title,
        input.body ?? "",
        JSON.stringify(input.context ?? {}),
        input.fingerprint,
        input.observedAt,
        input.rawArtifactRef ?? null,
      ],
    );
    return decodeSourceFinding(result.rows[0]!);
  },

  async appendFindingIfAbsent(
    client: QueryClient,
    input: AppendSourceFindingInput,
  ): Promise<AppendSourceFindingResult> {
    const id = `sfind_${randomUUID()}`;
    const result = await client.query<RawSourceFindingRow>(
      `INSERT INTO source_findings
         (org_id, id, project_id, issue_loop_id, source_id, provider_object_id,
          provider_revision, delivery_id, status, release, environment, title, body,
          context, fingerprint, observed_at, raw_artifact_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17)
       ON CONFLICT (org_id, source_id, provider_object_id, provider_revision) DO NOTHING
       RETURNING ${SOURCE_FINDING_COLUMNS}`,
      [
        input.orgId,
        id,
        input.projectId,
        input.issueLoopId,
        input.sourceId,
        input.providerObjectId,
        input.providerRevision,
        input.deliveryId ?? null,
        input.status,
        input.release ?? null,
        input.environment ?? null,
        input.title,
        input.body ?? "",
        JSON.stringify(input.context ?? {}),
        input.fingerprint,
        input.observedAt,
        input.rawArtifactRef ?? null,
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) return { finding: decodeSourceFinding(inserted), inserted: true };
    const existing = await client.query<RawSourceFindingRow>(
      `SELECT ${SOURCE_FINDING_COLUMNS}
         FROM source_findings
        WHERE org_id = $1 AND source_id = $2 AND provider_object_id = $3 AND provider_revision = $4`,
      [input.orgId, input.sourceId, input.providerObjectId, input.providerRevision],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error("source finding disappeared after idempotent conflict");
    return { finding: decodeSourceFinding(row), inserted: false };
  },

  async transition(
    client: QueryClient,
    input: TransitionIssueLoopInput,
  ): Promise<TransitionIssueLoopResult | undefined> {
    if (input.fromState !== undefined && input.fromStates !== undefined)
      throw new Error("issue-loop transition accepts fromState or fromStates, not both");
    const fromStates = input.fromStates ?? (input.fromState === undefined ? [] : [input.fromState]);
    const result = await client.query<RawIssueLoopRow>(
      `UPDATE issue_loops
          SET state = $4, row_version = row_version + 1, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3
          AND state <> $4
          AND (cardinality($5::text[]) = 0 OR state = ANY($5::text[]))
       RETURNING ${ISSUE_LOOP_COLUMNS}`,
      [input.orgId, input.projectId, input.issueLoopId, input.toState, fromStates],
    );
    const changed = result.rows[0];
    if (changed !== undefined) return { loop: decodeIssueLoop(changed), changed: true };
    const current = await IssueLoopStore.get(client, input.orgId, input.projectId, input.issueLoopId);
    return current === undefined ? undefined : { loop: current, changed: false };
  },

  async markSourceSyncVerified(
    client: QueryClient,
    orgId: string,
    projectId: string,
    issueLoopId: string,
  ): Promise<TransitionIssueLoopResult | undefined> {
    return IssueLoopStore.transition(client, {
      orgId,
      projectId,
      issueLoopId,
      toState: "verified_closed",
      fromState: "verified_source_sync_pending",
    });
  },

  async markExternallyClosedUnverified(
    client: QueryClient,
    orgId: string,
    projectId: string,
    issueLoopId: string,
  ): Promise<TransitionIssueLoopResult | undefined> {
    const result = await client.query<RawIssueLoopRow>(
      `UPDATE issue_loops
          SET state = 'externally_closed_unverified', row_version = row_version + 1, updated_at = now()
        WHERE org_id = $1 AND project_id = $2 AND id = $3 AND state <> 'verified_closed'
       RETURNING ${ISSUE_LOOP_COLUMNS}`,
      [orgId, projectId, issueLoopId],
    );
    const changed = result.rows[0];
    if (changed !== undefined) return { loop: decodeIssueLoop(changed), changed: true };
    const current = await IssueLoopStore.get(client, orgId, projectId, issueLoopId);
    return current === undefined ? undefined : { loop: current, changed: false };
  },

  async listFindings(client: QueryClient, orgId: string, loopId: string): Promise<SourceFindingRow[]> {
    const result = await client.query<RawSourceFindingRow>(
      `SELECT ${SOURCE_FINDING_COLUMNS}
         FROM source_findings
        WHERE org_id = $1 AND issue_loop_id = $2
        ORDER BY observed_at ASC, id ASC`,
      [orgId, loopId],
    );
    return result.rows.map(decodeSourceFinding);
  },

  async linkEdge(client: QueryClient, input: LinkIssueLoopEdgeInput): Promise<void> {
    await client.query(
      `INSERT INTO issue_loop_edges (org_id, project_id, issue_loop_id, related_issue_loop_id, relation)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, project_id, issue_loop_id, related_issue_loop_id, relation) DO NOTHING`,
      [input.orgId, input.projectId, input.issueLoopId, input.relatedIssueLoopId, input.relation],
    );
  },
} as const;
