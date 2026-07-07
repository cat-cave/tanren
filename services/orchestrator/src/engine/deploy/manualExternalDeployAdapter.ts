// The `manual_external` DeployAdapter — the legitimately HUMAN-IN-THE-LOOP class. The
// deploy is performed OUT-OF-BAND by an operator (a hand-run deploy, a vendor portal,
// a physical/manual delivery); the adapter's job is to record the operator's
// ATTESTATION (the declared live target URL + its kind) and then PROVE it: `verify`
// confirms the attested URL is actually reachable — but only AFTER the operator has
// confirmed the deploy through the confirmation route (Codex H3 #21). This is an
// attestation/confirmation flow — NOT a no-op and NOT a rubber stamp.
//
// Codex H3 Surface 7 findings #20 / #21 (the BLOCKING fix this module wires):
//   #20 — attestations used to live in a process-local `Map`
//         (`InMemoryManualAttestationStore`) that lost every row on restart.
//   #21 — `deploy()` used to write `state: "attested"` directly from the grant
//         metadata — a rubber-stamp with NO real operator confirmation. `verify()`
//         then smoke-probed the URL and reported `state: "confirmed"` off that
//         rubber stamp.
// The fix (this file + `manualAttestationStore.ts` + `pgManualAttestationStore.ts`):
// `deploy()` records `pending_manual_confirmation` in a DURABLE (Postgres-backed)
// store + emits `deploy.pending_manual` (the operator-facing wake); an operator
// confirms out-of-band via
// `POST /orgs/:orgId/projects/:projectId/deploys/:deploymentId/confirm` which flips
// the row to `confirmed` + emits `deploy.manual_confirmed`; `verify()` reads the row
// + FAILS LOUD when still pending (NEVER a silent verified) and only then
// smoke-probes the URL + emits `deploy.verified`.
//
// The store contract + the in-memory (test-only) impl live in
// `manualAttestationStore.ts`; the production `PgManualAttestationStore` lives in
// `pgManualAttestationStore.ts`. This module wires the adapter over that seam.

import type {
  DemoSurface,
  DeployAdapter,
  DeployRef,
  DeployStatus,
  DeployVerification,
  ProvisionOrBindInput,
  UrlReachabilityProbe,
  VerifyPollPolicy,
} from "../contracts/deployAdapter.js";
import type { OrgGrant, ProjectContext, ProvisionedArtifact } from "../contracts/integrationProvisioner.js";
import type { DeployResult, DeploySource } from "../provisioners/deployProvisioner.js";
import type { EventStore } from "../eventStore.js";
import { serviceAuditActor } from "../events/schemas/audit.js";
import { DeployAdapterConfigError, DeployAdapterOperationError } from "./deployAdapterErrors.js";
import type {
  ManualAttestationRecord,
  ManualAttestationStore,
  ManualExternalSurfaceKind,
} from "./manualAttestationStore.js";
import { pollUntilTerminal } from "./pollUntilTerminal.js";

// Re-export the store contract + fake so the many existing consumers can keep
// importing from this module (the split is invisible outside this directory).
export type {
  ManualAttestation,
  ManualAttestationConfirmInput,
  ManualAttestationConfirmResult,
  ManualAttestationRecord,
  ManualAttestationRecordInput,
  ManualAttestationState,
  ManualAttestationStore,
  ManualExternalSurfaceKind,
} from "./manualAttestationStore.js";
export { InMemoryManualAttestationStore } from "./manualAttestationStore.js";

/** The adapter-class kind this impl registers under. */
export const MANUAL_EXTERNAL_ADAPTER_KIND = "manual_external";

/** The provider kind the adapter stamps onto the deployRef. */
export const MANUAL_EXTERNAL_PROVIDER_KIND = "deploy.manual_external";

/** Wiring the `manual_external` adapter runs over: the attestation store + the verify seams. */
export interface ManualExternalDeployAdapterDeps {
  /**
   * The DURABLE attestation record store. Production wires
   * `PgManualAttestationStore`; tests inject the process-local
   * `InMemoryManualAttestationStore`. An in-memory default is NEVER used in
   * production wiring — a lost attestation is a silent-fail on the doctrine.
   */
  attestations: ManualAttestationStore;
  /** The URL reachability probe verify runs against the attested target. */
  urlProbe: UrlReachabilityProbe;
  /** The verify poll CADENCE (the spacing between probes; no count — poll-until-reachable). */
  poll: VerifyPollPolicy;
  /**
   * The tenant scope the adapter runs under. `deploy()` writes the attestation
   * row keyed under this org + project; `verify()` reads the row and (when it is
   * PG-backed) uses this org for the RLS-scoped read. REQUIRED: an unscoped
   * adapter would silently write cross-tenant rows / read the wrong rows.
   */
  ownerScope: { orgId: string; projectId: string };
  /**
   * The durable event store the adapter emits `deploy.pending_manual` /
   * `deploy.manual_confirmed` into. OPTIONAL — omitted only for pure-store /
   * pure-adapter unit tests that assert the persistence contract without the
   * event tail; production wiring always supplies it (so the operator-facing
   * pending-confirmation wake actually reaches the notification route).
   */
  events?: EventStore;
  /**
   * The optional per-run bindings the emitted events carry (runId + the merge
   * that produced the pending attestation). When omitted the events are appended
   * against the org/project scope alone.
   */
  runBindings?: { runId?: string };
}

/** Read the operator's declared target URL off the grant metadata, or throw LOUD. */
function declaredUrl(grant: OrgGrant): string {
  const value = grant.metadata["manualExternalUrl"];
  if (typeof value !== "string" || value === "") {
    throw new DeployAdapterConfigError(
      MANUAL_EXTERNAL_ADAPTER_KIND,
      "manualExternalUrl",
      "set the operator-declared live target URL (the deploy performed out-of-band) on the org grant metadata — there is no target to attest to and confirm",
    );
  }
  return value;
}

/** Read the operator's declared surface kind (defaults to `web_url`). */
function declaredSurfaceKind(grant: OrgGrant): ManualExternalSurfaceKind {
  const value = grant.metadata["manualExternalKind"];
  if (value === "download") {
    return "download";
  }
  if (value === undefined || value === "web_url") {
    return "web_url";
  }
  throw new DeployAdapterConfigError(
    MANUAL_EXTERNAL_ADAPTER_KIND,
    "manualExternalKind",
    `must be 'web_url' or 'download' when set (got '${JSON.stringify(value)}')`,
  );
}

/** The confirmation-route path notification consumers render as a link/CLI hint. */
export function manualExternalConfirmationPath(orgId: string, projectId: string, deploymentId: string): string {
  return `/orgs/${orgId}/projects/${projectId}/deploys/${encodeURIComponent(deploymentId)}/confirm`;
}

/**
 * The `manual_external` DeployAdapter. The operator deploys out-of-band and declares
 * the target; `deploy()` records a PENDING-CONFIRMATION attestation + emits the
 * operator-facing wake; an operator confirms via the confirmation route (see
 * `routes/deploys/index.ts`); `verify()` reads the persisted record and runs the
 * URL smoke probe only after confirmation. NEVER a silent verified.
 */
export class ManualExternalDeployAdapter implements DeployAdapter {
  readonly kind = MANUAL_EXTERNAL_ADAPTER_KIND;

  constructor(private readonly deps: ManualExternalDeployAdapterDeps) {}

  async provisionOrBind(
    grant: OrgGrant,
    projectCtx: ProjectContext,
    input: ProvisionOrBindInput,
  ): Promise<ProvisionedArtifact> {
    // Read (and validate) the operator's declared target up front — provisioning a
    // manual_external deploy with no declared target is a loud config error, not a
    // silent partial setup.
    const url = declaredUrl(grant);
    const surfaceKind = declaredSurfaceKind(grant);
    const appId = input.mode === "bind" ? input.existingResourceId : (projectCtx.projectId ?? "manual-external");
    return {
      deployRef: { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId },
      projectConfig: {
        deployProvider: MANUAL_EXTERNAL_PROVIDER_KIND,
        deployAppId: appId,
        manualExternalUrl: url,
        manualExternalKind: surfaceKind,
      },
    };
  }

  async deploy(grant: OrgGrant, ref: DeployRef, source: DeploySource): Promise<DeployResult> {
    const url = declaredUrl(grant);
    const surfaceKind = declaredSurfaceKind(grant);
    // The operator performs the deploy OUT-OF-BAND; here we RECORD a
    // PENDING-CONFIRMATION attestation (the declared target bound to the merged
    // ref) in the DURABLE store — surviving a restart, unlike the pre-fix
    // process-local `Map` (Codex H3 #20). The state is `pending_manual_confirmation`
    // (NOT a rubber-stamp "attested" — Codex H3 #21); `verify()` refuses to
    // report `verified` until an operator confirms via the confirmation route.
    const deploymentId = `manual:${ref.appId}@${source.ref}`;
    const { orgId, projectId } = this.deps.ownerScope;
    await this.deps.attestations.record({
      deploymentId,
      orgId,
      projectId,
      appId: ref.appId,
      attestation: { url, surfaceKind, source },
    });
    // Emit the operator-facing wake — the notification route surfaces it as
    // "please confirm the deploy" with a link/CLI hint to the confirmation
    // endpoint. Non-secret payload; the event may be omitted for pure-adapter
    // unit tests (see `deps.events`).
    if (this.deps.events !== undefined) {
      await this.deps.events.append({
        orgId,
        projectId,
        ...(this.deps.runBindings?.runId === undefined ? {} : { runId: this.deps.runBindings.runId }),
        eventType: "deploy.pending_manual",
        payload: {
          provider: MANUAL_EXTERNAL_PROVIDER_KIND,
          appId: ref.appId,
          repo: source.repo,
          ref: source.ref,
          deploymentId,
          url,
          surfaceKind,
          orgId,
          projectId,
          confirmationPath: manualExternalConfirmationPath(orgId, projectId, deploymentId),
          // Governing-action audit envelope: the autonomous service initiates the
          // wake; the confirming operator (on `deploy.manual_confirmed`) is the
          // human approver. No `policyVersion` at this seam — the manual_external
          // adapter has no persisted config-policy version (unlike the direct_api
          // watcher which reads it from projects.config); leaving it OFF is the
          // honest empty state (AuditEnvelope allows optional `policyVersion`).
          initiatingActor: serviceAuditActor,
        },
      });
    }
    return { deploymentId, url, state: "pending_manual_confirmation" };
  }

  async status(_grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployStatus> {
    const record = await this.loadRecord(ref, deploymentId);
    // status is a non-polling read. It reports the persisted lifecycle state so a
    // caller can distinguish "waiting on operator" from "confirmed but not
    // smoke-checked" without polling. `ready` stays FALSE until `verify()` runs
    // the URL smoke probe on a confirmed row.
    return { state: record.state, ready: false, failed: false, url: record.attestation.url };
  }

  async demoSurface(_grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DemoSurface> {
    const record = await this.loadRecord(ref, deploymentId);
    if (record.attestation.url === "") {
      throw new DeployAdapterOperationError(
        MANUAL_EXTERNAL_ADAPTER_KIND,
        `attestation '${deploymentId}' on '${ref.appId}' recorded no target URL — no surface to exercise`,
      );
    }
    return record.attestation.surfaceKind === "download"
      ? { kind: "download", artifactUrl: record.attestation.url }
      : { kind: "web_url", url: record.attestation.url };
  }

  async verify(_grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployVerification> {
    // Phase 1: wait for OPERATOR CONFIRMATION. Poll the persistent store until an
    // operator flips the row to `confirmed` via the confirmation route. NO count,
    // NO deadline (feedback_no_timeouts_progress_based) — a genuine fixed point
    // (the SAME `pending_manual_confirmation` state repeating with no operator
    // action) escalates LOUD via `pollUntilTerminal`'s stuck detection. That is
    // the "no silent verified" guarantee (Codex H3 #21): verify NEVER returns
    // `verified` for a row still in pending state.
    await pollUntilTerminal({
      readState: async () => {
        const rec = await this.loadRecord(ref, deploymentId);
        return { state: rec.state, ready: rec.state === "confirmed", failed: false };
      },
      onFailureTerminal: (state) =>
        new DeployAdapterOperationError(
          MANUAL_EXTERNAL_ADAPTER_KIND,
          `attestation '${deploymentId}' reached a FAILURE lifecycle state '${state}'`,
        ),
      onStuck: (state, polls) =>
        new DeployAdapterOperationError(
          MANUAL_EXTERNAL_ADAPTER_KIND,
          `attestation '${deploymentId}' is STUCK '${state}' — no operator confirmation received ` +
            `after ${String(polls)} polls (confirm via POST ` +
            `${manualExternalConfirmationPath(this.deps.ownerScope.orgId, this.deps.ownerScope.projectId, deploymentId)})`,
        ),
      intervalMs: this.deps.poll.intervalMs,
    });
    // Re-load the record to get the CURRENT attested URL post-confirmation.
    const record = await this.loadRecord(ref, deploymentId);
    if (record.attestation.url === "") {
      throw new DeployAdapterOperationError(
        MANUAL_EXTERNAL_ADAPTER_KIND,
        `attestation '${deploymentId}' on '${ref.appId}' recorded no target URL to confirm`,
      );
    }
    // Phase 2: CONFIRM the attested target is HTTP-reachable — the same UNBOUNDED
    // poll-until-reachable the pre-fix verify ran. The probe HTTP status IS the
    // convergence state; an unreachable target (5xx / connection-not-yet-routing)
    // is non-terminal (it may come up); the loop escalates LOUD only on a PROVEN
    // stuck non-terminal (same status repeating with no advancement).
    let lastStatus = 0;
    const { poll, pollCount } = await pollUntilTerminal({
      readState: async () => {
        const probeStatus = await this.deps.urlProbe.probe(record.attestation.url);
        lastStatus = probeStatus;
        const reachable = (probeStatus >= 200 && probeStatus < 400) || probeStatus === 401 || probeStatus === 403;
        return { state: String(probeStatus), ready: reachable, failed: false };
      },
      onFailureTerminal: (state) =>
        new DeployAdapterOperationError(
          MANUAL_EXTERNAL_ADAPTER_KIND,
          `attestation '${deploymentId}' target '${record.attestation.url}' reached a FAILURE state '${state}'`,
        ),
      onStuck: (_stuckState, polls) =>
        new DeployAdapterOperationError(
          MANUAL_EXTERNAL_ADAPTER_KIND,
          `attestation '${deploymentId}' target '${record.attestation.url}' is STUCK unreachable (HTTP ${String(lastStatus)}) ` +
            `with no advancement after ${String(polls)} polls`,
        ),
      intervalMs: this.deps.poll.intervalMs,
    });
    return { ready: true, state: "verified", url: record.attestation.url, pollCount, smokeStatus: Number(poll.state) };
  }

  private async loadRecord(ref: DeployRef, deploymentId: string): Promise<ManualAttestationRecord> {
    const record = await this.deps.attestations.read(deploymentId);
    if (record === undefined) {
      throw new DeployAdapterOperationError(
        MANUAL_EXTERNAL_ADAPTER_KIND,
        `no recorded attestation for deployment '${deploymentId}' on '${ref.appId}' (was deploy() called to record the operator's declared target?)`,
      );
    }
    return record;
  }
}
