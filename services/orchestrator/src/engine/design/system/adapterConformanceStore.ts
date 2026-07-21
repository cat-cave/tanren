// ds-7 — the org-scoped store that records + reads the design adapter
// conformance run. One row per (org, project, target, release, artifact)
// coordinate, with a frozen `DesignAdapterConformanceReceiptV1` body and the
// canonical sha256 digest over that body. The gate + dashboard read this.

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import {
  type DesignAdapterConformanceReceiptV1,
  type DesignAdapterConformanceTarget,
  designAdapterConformanceReceiptDigest,
  parseDesignAdapterConformanceReceipt,
  receiptPasses,
} from "./adapterConformanceReceipt.js";

/** The persisted row (typed view of the SQL columns the store writes). */
export interface DesignAdapterConformanceRunRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly id: string;
  readonly releaseId: string;
  readonly artifactId: string;
  readonly target: DesignAdapterConformanceTarget;
  readonly adapterVersion: string;
  readonly artifactDigest: string;
  readonly receiptDigest: string;
  readonly outcome: "passed" | "failed" | "inconclusive_infrastructure" | "not_applicable";
  readonly notes: string;
  readonly createdAt: string;
  /** The parsed receipt body (undefined when outcome !== 'passed'). */
  readonly receipt: DesignAdapterConformanceReceiptV1 | undefined;
}

/** Raised when the persisted receipt body fails to re-parse (corrupt row → fail-closed). */
export class DesignAdapterConformanceRunCorruptError extends Error {
  constructor(
    readonly runId: string,
    readonly issue: string,
    options?: { cause?: unknown },
  ) {
    super(`design adapter conformance run '${runId}' is corrupt: ${issue}`, options);
    this.name = "DesignAdapterConformanceRunCorruptError";
  }
}

/** Raised when the artifact digest the caller supplied does not match the persisted artifact row. */
export class DesignAdapterConformanceArtifactMismatchError extends Error {
  constructor(
    readonly artifactId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`artifact '${artifactId}' digest mismatch: expected '${expected}', the persisted row carries '${actual}'`);
    this.name = "DesignAdapterConformanceArtifactMismatchError";
  }
}

export interface RecordDesignAdapterConformanceRunInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly id: string;
  readonly releaseId: string;
  readonly artifactId: string;
  readonly target: DesignAdapterConformanceTarget;
  readonly adapterVersion: string;
  /** The manifest digest of the EXACT artifact the receipt conformed against. */
  readonly artifactDigest: string;
  readonly receipt: DesignAdapterConformanceReceiptV1;
}

/** The ds-7 conformance-run store: org-scoped record + read. */
export class DesignAdapterConformanceStore {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Record a conformance run. PROOF≡EFFECT (trap #7): the caller passes the
   * receipt + the artifactDigest it conformed against; the store asserts the
   * digest matches the PERSISTED artifact row's digest, then writes the receipt
   * body and its canonical digest. A mismatch is a loud typed error — the
   * receipt MUST be over the EXACT artifact the gate / dashboard will read.
   */
  async record(input: RecordDesignAdapterConformanceRunInput): Promise<DesignAdapterConformanceRunRow> {
    const parsed = parseDesignAdapterConformanceReceipt(input.receipt);
    if (parsed.artifactDigest !== input.artifactDigest) {
      throw new DesignAdapterConformanceArtifactMismatchError(
        input.artifactId,
        input.artifactDigest,
        parsed.artifactDigest,
      );
    }
    if (parsed.target !== input.target) {
      throw new DesignAdapterConformanceRunCorruptError(
        input.id,
        `receipt target '${parsed.target}' does not match run target '${input.target}'`,
      );
    }
    return runWithOrgScope(this.pool, input.orgId, async (client) => {
      // Proof≡effect: the persisted artifact row's digest MUST equal the receipt's
      // artifactDigest. A row that points at a different artifact is rejected
      // loudly — never record a receipt over coordinate A for an artifact B.
      const artifact = await client.query<{ digest: string }>(
        `SELECT digest FROM design_artifacts WHERE org_id = $1 AND id = $2`,
        [input.orgId, input.artifactId],
      );
      const artifactRow = artifact.rows[0];
      if (artifactRow === undefined) {
        throw new DesignAdapterConformanceRunCorruptError(input.id, `artifact '${input.artifactId}' not found`);
      }
      if (artifactRow.digest !== input.artifactDigest) {
        throw new DesignAdapterConformanceArtifactMismatchError(
          input.artifactId,
          input.artifactDigest,
          artifactRow.digest,
        );
      }
      // The outcome recorded on the row mirrors the receipt's pass predicate — a
      // receipt whose body claims `passed` but fails the POSITIVE-ONLY predicate
      // (e.g. a negative control the validator did not catch) is rewritten to
      // `failed` BEFORE the row is written. The CHECK constraint then requires a
      // receipt body for `passed`, so a doctored body that omits a control can
      // never produce a `passed` row.
      const passed = receiptPasses(parsed);
      const persistedOutcome: DesignAdapterConformanceRunRow["outcome"] = passed
        ? "passed"
        : parsed.outcome === "passed"
          ? "failed"
          : parsed.outcome;
      // Keep the durable row outcome and the frozen receipt body truthful as a
      // pair. In particular, a body that self-labels `passed` but fails the
      // positive-only predicate is rewritten to `failed` here too; consumers
      // must never read `receipt.outcome === 'passed'` from a failed row.
      const body: DesignAdapterConformanceReceiptV1 =
        parsed.outcome === persistedOutcome ? parsed : { ...parsed, outcome: persistedOutcome };
      const receiptDigestPersisted = designAdapterConformanceReceiptDigest(body);
      await client.query(
        `INSERT INTO design_adapter_conformance_runs
           (org_id, project_id, id, release_id, artifact_id, target, adapter_version,
            artifact_digest, receipt_digest, receipt, outcome, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)`,
        [
          input.orgId,
          input.projectId,
          input.id,
          input.releaseId,
          input.artifactId,
          input.target,
          input.adapterVersion,
          input.artifactDigest,
          receiptDigestPersisted,
          JSON.stringify(body),
          persistedOutcome,
          body.notes,
        ],
      );
      return {
        orgId: input.orgId,
        projectId: input.projectId,
        id: input.id,
        releaseId: input.releaseId,
        artifactId: input.artifactId,
        target: input.target,
        adapterVersion: input.adapterVersion,
        artifactDigest: input.artifactDigest,
        receiptDigest: receiptDigestPersisted,
        outcome: persistedOutcome,
        notes: body.notes,
        createdAt: new Date().toISOString(),
        receipt: body,
      };
    });
  }

  /** Read the latest run for a (org, project, target). Undefined when none exists. */
  async readLatest(
    orgId: string,
    projectId: string,
    target: DesignAdapterConformanceTarget,
  ): Promise<DesignAdapterConformanceRunRow | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<RunDbRow>(
        `SELECT org_id, project_id, id, release_id, artifact_id, target, adapter_version,
                artifact_digest, receipt_digest, receipt, outcome, notes, created_at
           FROM design_adapter_conformance_runs
          WHERE org_id = $1 AND project_id = $2 AND target = $3
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [orgId, projectId, target],
      );
      return mapRow(rows.rows[0]);
    });
  }

  /** Read every run for a (org, project) — the dashboard target-conformance panel. */
  async listForProject(orgId: string, projectId: string): Promise<readonly DesignAdapterConformanceRunRow[]> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<RunDbRow>(
        `SELECT org_id, project_id, id, release_id, artifact_id, target, adapter_version,
                artifact_digest, receipt_digest, receipt, outcome, notes, created_at
           FROM design_adapter_conformance_runs
          WHERE org_id = $1 AND project_id = $2
          ORDER BY target ASC, created_at DESC, id DESC`,
        [orgId, projectId],
      );
      return rows.rows.map(mapRow).filter((row): row is DesignAdapterConformanceRunRow => row !== undefined);
    });
  }

  /** Read one run by id. */
  async readById(orgId: string, runId: string): Promise<DesignAdapterConformanceRunRow | undefined> {
    return runWithOrgScope(this.pool, orgId, async (client) => {
      const rows = await client.query<RunDbRow>(
        `SELECT org_id, project_id, id, release_id, artifact_id, target, adapter_version,
                artifact_digest, receipt_digest, receipt, outcome, notes, created_at
           FROM design_adapter_conformance_runs
          WHERE org_id = $1 AND id = $2`,
        [orgId, runId],
      );
      return mapRow(rows.rows[0]);
    });
  }
}

interface RunDbRow {
  org_id: string;
  project_id: string;
  id: string;
  release_id: string;
  artifact_id: string;
  target: string;
  adapter_version: string;
  artifact_digest: string;
  receipt_digest: string;
  receipt: unknown;
  outcome: string;
  notes: string;
  created_at: Date;
}

function mapRow(row: RunDbRow | undefined): DesignAdapterConformanceRunRow | undefined {
  if (row === undefined) return undefined;
  if (
    row.outcome !== "passed" &&
    row.outcome !== "failed" &&
    row.outcome !== "inconclusive_infrastructure" &&
    row.outcome !== "not_applicable"
  ) {
    throw new DesignAdapterConformanceRunCorruptError(row.id, `outcome '${row.outcome}' is not in the frozen enum`);
  }
  let receipt: DesignAdapterConformanceReceiptV1 | undefined;
  if (row.receipt !== null) {
    try {
      receipt = parseDesignAdapterConformanceReceipt(row.receipt);
    } catch (error) {
      throw new DesignAdapterConformanceRunCorruptError(
        row.id,
        error instanceof Error ? error.message : "receipt body failed to re-parse",
        { cause: error },
      );
    }
  }
  return {
    orgId: row.org_id,
    projectId: row.project_id,
    id: row.id,
    releaseId: row.release_id,
    artifactId: row.artifact_id,
    target: row.target as DesignAdapterConformanceTarget,
    adapterVersion: row.adapter_version,
    artifactDigest: row.artifact_digest,
    receiptDigest: row.receipt_digest,
    outcome: row.outcome,
    notes: row.notes,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
    receipt,
  };
}
