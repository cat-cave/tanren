// ds-8 — durable quarantine receipt bridge for Figma/registry snapshots.

import { createHash } from "node:crypto";
import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import {
  ExternalDesignImportReceiptV1Schema,
  type DesignEcosystemCommand,
  type ExternalDesignImportReceiptV1,
} from "./designEcosystemContracts.js";

type SnapshotCommand = Extract<DesignEcosystemCommand, { type: "pull_figma" | "import_registry" }>;
type Failure = (code: "not_found" | "conflict" | "blocked", detail: string) => Error;

export interface ExternalImportRecordedResult {
  readonly kind: "external_import_recorded";
  readonly externalImportId: string;
  readonly receipt: ExternalDesignImportReceiptV1;
}

/** Snapshot pull/import is receipt-only: it never promotes or publishes a fork. */
export async function recordExternalDesignImport(
  pool: pg.Pool,
  orgId: string,
  command: SnapshotCommand,
  source: "figma" | "registry",
  fail: Failure,
): Promise<ExternalImportRecordedResult> {
  const disposition =
    command.licenseVerdict === "approved" && command.lossinessReport.lossless ? "quarantined" : "rejected";
  const receipt = ExternalDesignImportReceiptV1Schema.parse({
    version: 1,
    schemaVersion: "design_external_import.v1",
    source,
    locator: command.locator,
    externalRevision: command.externalRevision,
    snapshotDigest: command.snapshotDigest,
    licenseVerdict: command.licenseVerdict,
    lossinessReport: command.lossinessReport,
    disposition,
  });
  const digest = receiptDigest(receipt);
  await runWithOrgScope(pool, orgId, async (client) => {
    await client.query(
      `INSERT INTO design_external_imports
         (org_id, id, source, locator, external_revision, snapshot_digest,
          receipt_digest, receipt, disposition, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, now())
       ON CONFLICT (org_id, id) DO NOTHING`,
      [
        orgId,
        command.externalImportId,
        source,
        receipt.locator,
        receipt.externalRevision,
        receipt.snapshotDigest,
        digest,
        JSON.stringify(receipt),
        receipt.disposition,
      ],
    );
    const result = await client.query<{ receipt: unknown; receipt_digest: string }>(
      `SELECT receipt, receipt_digest FROM design_external_imports WHERE org_id = $1 AND id = $2`,
      [orgId, command.externalImportId],
    );
    const row = result.rows[0];
    if (row === undefined || row.receipt_digest !== digest)
      throw fail("conflict", "external import id already differs");
    const stored = ExternalDesignImportReceiptV1Schema.safeParse(row.receipt);
    if (
      !stored.success ||
      receiptDigest(stored.data) !== digest ||
      JSON.stringify(stored.data) !== JSON.stringify(receipt)
    ) {
      throw fail("blocked", "external import readback is corrupt");
    }
  });
  return { kind: "external_import_recorded", externalImportId: command.externalImportId, receipt };
}

function receiptDigest(receipt: ExternalDesignImportReceiptV1): string {
  const canonical = JSON.stringify([
    receipt.version,
    receipt.schemaVersion,
    receipt.source,
    receipt.locator,
    receipt.externalRevision,
    receipt.snapshotDigest,
    receipt.licenseVerdict,
    receipt.lossinessReport.lossless,
    receipt.lossinessReport.warnings,
    receipt.disposition,
  ]);
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
