// Plane-split P2: resolve the worker's job-CLAIM client from the environment.
//
//   - When the control-plane claim endpoint is configured
//     (TANREN_CLAIM_ENDPOINT_URL + the data-plane's mTLS cert env), the worker
//     claims over the mTLS endpoint — an `HttpJobClaimClient` on a
//     `buildNodeMtlsFetch` channel. The data plane no longer touches `job_queue`
//     to claim (the DB-surface shrink P2 delivers).
//   - Otherwise → `undefined`, so the worker falls back to the in-process
//     `DirectJobClaimClient` (the unchanged DB-CAS). The single-process
//     `TANREN_RUN_WORKER=1` dev path always lands here — it shares the API pool,
//     so a network claim hop would add risk for no isolation gain.
//
// CLAIM SEMANTICS ARE IDENTICAL either way: the endpoint wraps the SAME
// `JobQueue.claim`. See docs/roadmap/saas-rls-and-plane-split-plan.md (P2).

import { HttpJobClaimClient, type JobClaimClient } from "../contracts/jobClaim.js";
import { buildNodeMtlsFetch, type MtlsCertPaths } from "../contracts/mtlsChannelNode.js";

/** Resolve the data plane's mTLS cert paths from env, or `undefined` when unset. */
export function dataPlaneMtlsCertPathsFromEnv(): MtlsCertPaths | undefined {
  const certPath = process.env["TANREN_DATA_PLANE_TLS_CERT"];
  const keyPath = process.env["TANREN_DATA_PLANE_TLS_KEY"];
  const caPath = process.env["TANREN_DATA_PLANE_TLS_CA"];
  if (!certPath || !keyPath || !caPath) {
    return undefined;
  }
  return { certPath, keyPath, caPath };
}

/**
 * Build the worker's claim client from env, or `undefined` to use the in-process
 * direct DB-CAS. Requires BOTH the endpoint URL and the data-plane cert material;
 * if either is missing the worker stays on the direct path (and a partial config
 * — endpoint set but no certs — throws loudly rather than silently claiming over
 * an unauthenticated channel).
 */
export function buildClaimClientFromEnv(): JobClaimClient | undefined {
  const endpointUrl = process.env["TANREN_CLAIM_ENDPOINT_URL"];
  if (!endpointUrl) {
    return undefined;
  }
  const certPaths = dataPlaneMtlsCertPathsFromEnv();
  if (certPaths === undefined) {
    throw new Error(
      "TANREN_CLAIM_ENDPOINT_URL is set but the data-plane mTLS cert env " +
        "(TANREN_DATA_PLANE_TLS_CERT/KEY/CA) is incomplete — refusing to claim over an unauthenticated channel",
    );
  }
  return new HttpJobClaimClient(endpointUrl, buildNodeMtlsFetch(certPaths));
}
