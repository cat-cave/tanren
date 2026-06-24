// Shared types + error class for the GCP allocator. Extracted from
// `gcpAllocator.ts` so the production fetch client (`gcpFetchClient.ts`) can
// import them without a circular `allocator ↔ client` dependency.

/**
 * Typed error for GCP Compute Engine provisioning failures, so callers (and
 * tests) can distinguish allocator faults from generic errors. Optionally
 * carries a `cause` so a convergence-class throw wrapped into this allocator's
 * error keeps the inner stuck-signature / probe-count diagnostic accessible.
 */
export class GcpAllocatorError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GcpAllocatorError";
  }
}

/**
 * Minimal injectable HTTP client over the GCP Compute Engine v1 API. Only the
 * shapes the allocator needs are modeled. Tests inject a fake; production uses
 * `fetchGcpComputeClient`.
 *
 * GCP provisioning is asynchronous: `insertInstance` returns a zone Operation
 * that must be polled to completion via `getZoneOperation`, after which
 * `getInstance` exposes the RUNNING state and external IP.
 */
export interface GcpComputeClient {
  insertInstance(input: GcpInsertInstanceInput): Promise<GcpOperation>;
  getZoneOperation(operationName: string): Promise<GcpOperation>;
  getInstance(instanceName: string): Promise<GcpInstance>;
  deleteInstance(instanceName: string): Promise<void>;
}

export interface GcpInsertInstanceInput {
  /** Instance name, DNS-1035 safe (lowercase, digits, dashes). */
  name: string;
  /** Machine type short name, e.g. `e2-small`. */
  machineType: string;
  /** Source image, e.g. `projects/cos-cloud/global/images/family/cos-stable`. */
  sourceImage: string;
  /** SSH username authorized on the instance. */
  sshUsername: string;
  /** Runner SSH public key, injected via instance metadata. */
  sshPublicKey: string;
  /** GCE labels applied to the instance (used to trace it back to a run). */
  labels?: Record<string, string>;
}

/** A GCP long-running zone operation. */
export interface GcpOperation {
  name: string;
  /** PENDING | RUNNING | DONE */
  status: string;
  /** Present when the operation failed. */
  error?: string;
}

export interface GcpInstance {
  name: string;
  /** PROVISIONING | STAGING | RUNNING | STOPPING | TERMINATED */
  status: string;
  externalIp?: string;
}
