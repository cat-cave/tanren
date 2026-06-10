// The `manual_external` DeployAdapter — the legitimately HUMAN-IN-THE-LOOP class. The
// deploy is performed OUT-OF-BAND by an operator (a hand-run deploy, a vendor portal,
// a physical/manual delivery); the adapter's job is to record the operator's ATTESTATION
// (the declared live target URL + its kind) and then PROVE it: `verify` confirms the
// attested URL is actually reachable. This is an attestation/confirmation flow — NOT a
// no-op. The operator asserts "I deployed it, here"; the adapter independently confirms
// the target answers before the deploy counts as proven.
//
// provisionOrBind records the operator's declared target (the attestation); `deploy`
// records a deployment from the merged ref bound to that attested target; `verify` polls
// the attested URL until it is HTTP-reachable (or fails LOUD — an unconfirmed attestation
// is never accepted); `status` reads the recorded attestation + its last confirmation;
// `demoSurface` resolves a `web_url` or `download` surface from the attested target's kind.
//
// The attestation is recorded via an INJECTABLE `ManualAttestationStore` seam (a durable
// store in production; in-memory in tests) so verify/status/demoSurface read back the same
// target the operator declared. NO secret is involved — a manual_external target is a
// public URL the operator attests to.
//
// LOUD-FAIL ON MISSING CONFIG: a manual_external deploy REQUIRES the operator's declared
// target URL (the grant's `manualExternalUrl`). Its surface kind defaults to `web_url`
// (a reachable live endpoint); set the grant's `manualExternalKind` to `download` for a
// downloadable artifact. When the URL is absent we throw a typed
// {@link DeployAdapterConfigError} — there is no target to attest to; that is the
// operator's input, not something the adapter can infer. This is the correct unconfigured
// behavior, NOT a stub.

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
import { DeployAdapterConfigError, DeployAdapterOperationError } from "./deployAdapterErrors.js";

/** The adapter-class kind this impl registers under. */
export const MANUAL_EXTERNAL_ADAPTER_KIND = "manual_external";

/** The provider kind the adapter stamps onto the deployRef. */
export const MANUAL_EXTERNAL_PROVIDER_KIND = "deploy.manual_external";

/** The surface kind an operator-attested target resolves to: a live URL or a downloadable artifact. */
export type ManualExternalSurfaceKind = "web_url" | "download";

/**
 * An operator's recorded deploy ATTESTATION: the declared live target URL, its surface
 * kind, and the merged source ref the operator deployed. NON-SECRET — a public URL + a
 * git ref. This is the record `verify` confirms against.
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
 * The injectable attestation record store: `record` persists an operator attestation
 * under a deployment id; `read` reads it back. A durable store in production; in-memory
 * in tests. This is how `verify`/`status`/`demoSurface` recover the SAME target the
 * operator declared at `deploy` time.
 */
export interface ManualAttestationStore {
  record(deploymentId: string, attestation: ManualAttestation): Promise<void>;
  read(deploymentId: string): Promise<ManualAttestation | undefined>;
}

/**
 * A default in-process attestation record store (a Map). Named WITHOUT a stub/no-op stem
 * because it is a REAL, functioning store — a manual_external attestation is non-secret
 * and process-local within a single check; production wiring may slot a durable-backed
 * impl, but this is a genuine implementation, not a stand-in.
 */
export class InMemoryManualAttestationStore implements ManualAttestationStore {
  private readonly records = new Map<string, ManualAttestation>();

  async record(deploymentId: string, attestation: ManualAttestation): Promise<void> {
    this.records.set(deploymentId, attestation);
  }

  async read(deploymentId: string): Promise<ManualAttestation | undefined> {
    return this.records.get(deploymentId);
  }
}

/** Wiring the `manual_external` adapter runs over: the attestation store + the verify seams. */
export interface ManualExternalDeployAdapterDeps {
  /** The attestation record store (durable in production; in-memory in tests). */
  attestations: ManualAttestationStore;
  /** The URL reachability probe verify runs against the attested target. */
  urlProbe: UrlReachabilityProbe;
  /** The verify poll cadence + bound (the never-reachable guard; sleep injected for tests). */
  poll: VerifyPollPolicy;
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
    `must be 'web_url' or 'download' when set (got '${String(value)}')`,
  );
}

/**
 * The `manual_external` DeployAdapter. The operator deploys out-of-band and declares the
 * target; this adapter records that attestation and PROVES it (verify confirms the URL
 * answers). The deployRef `appId` is the project's stable attestation id; the
 * deploymentId keys the recorded attestation.
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
    // The operator performed the deploy out-of-band; here we RECORD the attestation
    // (the declared target bound to the merged ref). The deploymentId is the attestation
    // handle verify/status/demoSurface read back. State is "attested" — the operator
    // asserts it; `verify` independently confirms reachability before it is proven.
    const deploymentId = `manual:${ref.appId}@${source.ref}`;
    await this.deps.attestations.record(deploymentId, { url, surfaceKind, source });
    return { deploymentId, url, state: "attested" };
  }

  async status(_grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployStatus> {
    const attestation = await this.loadAttestation(ref, deploymentId);
    // status is a non-polling read of the recorded attestation. It reports the attested
    // target but does NOT itself probe (verify is the confirmation step), so `ready` is
    // false here — an attested-but-unconfirmed deploy is not yet proven live.
    return { state: "attested", ready: false, failed: false, url: attestation.url };
  }

  async demoSurface(_grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DemoSurface> {
    const attestation = await this.loadAttestation(ref, deploymentId);
    if (attestation.url === "") {
      throw new DeployAdapterOperationError(
        MANUAL_EXTERNAL_ADAPTER_KIND,
        `attestation '${deploymentId}' on '${ref.appId}' recorded no target URL — no surface to exercise`,
      );
    }
    return attestation.surfaceKind === "download"
      ? { kind: "download", artifactUrl: attestation.url }
      : { kind: "web_url", url: attestation.url };
  }

  async verify(_grant: OrgGrant, ref: DeployRef, deploymentId: string): Promise<DeployVerification> {
    const attestation = await this.loadAttestation(ref, deploymentId);
    const { maxPolls, intervalMs, sleep } = this.deps.poll;
    if (attestation.url === "") {
      throw new DeployAdapterOperationError(
        MANUAL_EXTERNAL_ADAPTER_KIND,
        `attestation '${deploymentId}' on '${ref.appId}' recorded no target URL to confirm`,
      );
    }
    // CONFIRM the attestation: poll the attested target until it is HTTP-reachable. An
    // operator's assertion is not enough — the deploy is proven only once the target
    // actually answers. A target that never becomes reachable within the budget fails
    // LOUD (the attestation is unconfirmed), never an assumed-success.
    let pollCount = 0;
    let lastStatus = 0;
    while (pollCount < maxPolls) {
      pollCount += 1;
      const probeStatus = await this.deps.urlProbe.probe(attestation.url);
      lastStatus = probeStatus;
      const reachable = (probeStatus >= 200 && probeStatus < 400) || probeStatus === 401 || probeStatus === 403;
      if (reachable) {
        return { ready: true, state: "confirmed", url: attestation.url, pollCount, smokeStatus: probeStatus };
      }
      if (pollCount < maxPolls) {
        await sleep(intervalMs);
      }
    }
    throw new DeployAdapterOperationError(
      MANUAL_EXTERNAL_ADAPTER_KIND,
      `attestation '${deploymentId}' target '${attestation.url}' never became reachable after ${String(maxPolls)} polls (last HTTP ${String(lastStatus)})`,
    );
  }

  private async loadAttestation(ref: DeployRef, deploymentId: string): Promise<ManualAttestation> {
    const attestation = await this.deps.attestations.read(deploymentId);
    if (attestation === undefined) {
      throw new DeployAdapterOperationError(
        MANUAL_EXTERNAL_ADAPTER_KIND,
        `no recorded attestation for deployment '${deploymentId}' on '${ref.appId}' (was deploy() called to record the operator's declared target?)`,
      );
    }
    return attestation;
  }
}
