// The `manual_external` DeployAdapter's attestation-store CONTRACT + types + the
// TEST-ONLY in-memory impl. Split out of `manualExternalDeployAdapter.ts` so that
// module stays under the 500-line cap; the production `PgManualAttestationStore`
// lives in `pgManualAttestationStore.ts` (Codex H3 #20).
//
// The two impls (Pg + InMemory) share this contract identically. Every consumer
// (the adapter itself, the confirmation route, tests) imports the store types
// from here.

import type { DeploySource } from "../provisioners/deployProvisioner.js";

/** The surface kind an operator-attested target resolves to: a live URL or a downloadable artifact. */
export type ManualExternalSurfaceKind = "web_url" | "download";

/**
 * The confirmation LIFECYCLE state stamped on the persisted attestation row.
 *   pending_manual_confirmation — `deploy()` recorded the attestation; awaiting
 *     an operator confirmation. `verify()` in this state FAILS LOUD (never a
 *     silent verified).
 *   confirmed                   — an operator confirmed the deploy via the
 *     confirmation route; `verify()` may now run the URL smoke probe.
 * NB: `verified` is NOT a persisted state — a URL that stops answering next week
 * does not un-confirm the operator's action, so persisting it would lie.
 */
export type ManualAttestationState = "pending_manual_confirmation" | "confirmed";

/**
 * An operator's recorded deploy ATTESTATION: the declared live target URL, its surface
 * kind, and the merged source ref the operator claims deploying. NON-SECRET — a public
 * URL + a git ref. This is the record `verify` confirms against.
 */
export interface ManualAttestation {
  /** The operator-declared live target URL (the deploy they performed out-of-band). */
  url: string;
  /** Whether the target is a reachable live endpoint (`web_url`) or a downloadable artifact. */
  surfaceKind: ManualExternalSurfaceKind;
  /** The merged source ref the operator attested deploying. */
  source: DeploySource;
}

/**
 * The full persisted row an attestation resolves to — the attestation PLUS the
 * durable lifecycle state (pending vs confirmed) + the confirmation audit
 * trail. `verify()` reads THIS shape to decide whether to run the URL probe.
 * NON-SECRET.
 */
export interface ManualAttestationRecord {
  deploymentId: string;
  orgId: string;
  projectId: string;
  appId: string;
  attestation: ManualAttestation;
  /** The confirmation lifecycle (persisted); see {@link ManualAttestationState}. */
  state: ManualAttestationState;
  /** When `deploy()` recorded the pending attestation. */
  recordedAt: Date;
  /** When an operator confirmed (null until confirmation lands). */
  confirmedAt: Date | null;
  /** The user id of the confirming operator (null until confirmation lands). */
  confirmedBy: string | null;
}

/** Input for {@link ManualAttestationStore.record} — the tenant scope + attestation. */
export interface ManualAttestationRecordInput {
  deploymentId: string;
  orgId: string;
  projectId: string;
  appId: string;
  attestation: ManualAttestation;
}

/** Input for {@link ManualAttestationStore.confirm}. */
export interface ManualAttestationConfirmInput {
  deploymentId: string;
  orgId: string;
  /** The user id of the confirming operator (an audit-trail id, non-secret). */
  confirmedBy: string;
}

/**
 * The result of a {@link ManualAttestationStore.confirm} call — the (possibly
 * pre-existing) confirmed record plus a discriminator marking a FRESH flip.
 */
export interface ManualAttestationConfirmResult {
  record: ManualAttestationRecord;
  /** True when THIS call flipped a pending row → confirmed; false on an idempotent re-confirm. */
  freshlyConfirmed: boolean;
}

/**
 * The injectable attestation record store. `record` upserts the pending-confirmation
 * row that `deploy()` produces; `read` reads back the current row with lifecycle
 * state; `confirm` flips a pending row to confirmed and stamps the audit columns.
 * A DURABLE Postgres-backed impl (`PgManualAttestationStore`) in production; the
 * process-local {@link InMemoryManualAttestationStore} for tests only (NEVER a
 * production default — see `buildDeployAdapter.ts`).
 */
export interface ManualAttestationStore {
  /**
   * Record the pending-manual-confirmation attestation for a deploy. IDEMPOTENT —
   * a re-record for the same deployment id upserts (deploy() may re-run on a retry
   * of the same merged ref; the row does not double). The row lands in
   * `pending_manual_confirmation` state; the operator's confirmation flips it via
   * {@link confirm}.
   */
  record(input: ManualAttestationRecordInput): Promise<void>;
  /**
   * Read the persisted attestation record (with lifecycle state + confirmation
   * audit trail). Returns `undefined` when no deploy() has recorded a row for this
   * id — a caller that then throws makes the missing-row case LOUD.
   */
  read(deploymentId: string): Promise<ManualAttestationRecord | undefined>;
  /**
   * Confirm the attestation: flip a pending row to `confirmed` + stamp
   * `confirmed_at` / `confirmed_by`. IDEMPOTENT — a re-confirm is a no-op that
   * yields the already-confirmed record; a non-existent row yields `undefined`
   * (the caller decides whether to 404). A row in a state that is NOT
   * `pending_manual_confirmation` is NOT flipped again (never re-writes the
   * `confirmed_at` / `confirmed_by` audit trail). The `freshlyConfirmed`
   * discriminator on the result is the confirmation-route's emit gate — the
   * caller emits `deploy.manual_confirmed` on the FRESH flip only (no duplicates).
   */
  confirm(input: ManualAttestationConfirmInput): Promise<ManualAttestationConfirmResult | undefined>;
}

/**
 * A TEST-ONLY process-local attestation store (a `Map`) with the same lifecycle
 * contract as the production Pg store. Explicitly a test fake — the production
 * default is `PgManualAttestationStore` (see `buildDeployAdapter.ts`), which
 * survives a restart. The rename + the docstring here close Codex H3 #20 (the
 * former `InMemoryManualAttestationStore` was defaulted into `buildDeployAdapter`
 * so a production `manual_external` deploy silently lost every attestation on
 * restart).
 */
export class InMemoryManualAttestationStore implements ManualAttestationStore {
  private readonly records = new Map<string, ManualAttestationRecord>();

  async record(input: ManualAttestationRecordInput): Promise<void> {
    // Idempotent upsert: a re-record preserves the existing lifecycle if the row
    // is already confirmed (never re-clears the confirmation audit trail), else
    // upserts the pending row.
    const existing = this.records.get(input.deploymentId);
    if (existing !== undefined && existing.state === "confirmed") {
      // Refresh the attestation payload but preserve the confirmation trail.
      this.records.set(input.deploymentId, {
        ...existing,
        orgId: input.orgId,
        projectId: input.projectId,
        appId: input.appId,
        attestation: input.attestation,
      });
      return;
    }
    this.records.set(input.deploymentId, {
      deploymentId: input.deploymentId,
      orgId: input.orgId,
      projectId: input.projectId,
      appId: input.appId,
      attestation: input.attestation,
      state: "pending_manual_confirmation",
      recordedAt: existing?.recordedAt ?? new Date(),
      confirmedAt: null,
      confirmedBy: null,
    });
  }

  async read(deploymentId: string): Promise<ManualAttestationRecord | undefined> {
    const record = this.records.get(deploymentId);
    return record === undefined ? undefined : { ...record, attestation: { ...record.attestation } };
  }

  async confirm(input: ManualAttestationConfirmInput): Promise<ManualAttestationConfirmResult | undefined> {
    const existing = this.records.get(input.deploymentId);
    if (existing === undefined) return undefined;
    if (existing.orgId !== input.orgId) {
      // Cross-tenant confirm is denied at the store (mirrors RLS deny-by-default).
      return undefined;
    }
    if (existing.state === "confirmed") {
      // Idempotent re-confirm — do NOT overwrite the audit trail.
      return { record: { ...existing }, freshlyConfirmed: false };
    }
    const confirmed: ManualAttestationRecord = {
      ...existing,
      state: "confirmed",
      confirmedAt: new Date(),
      confirmedBy: input.confirmedBy,
    };
    this.records.set(input.deploymentId, confirmed);
    return { record: { ...confirmed }, freshlyConfirmed: true };
  }
}
