// Resolve the worker's job-CLAIM client from the environment.
//
//   - When the control-plane claim endpoint is configured
//     (TANREN_CLAIM_ENDPOINT_URL + the data-plane's mTLS cert env), the worker
//     claims over the mTLS endpoint — an `HttpJobClaimClient` on a
//     `buildNodeMtlsFetch` channel. The data plane no longer touches `job_queue`
//     to claim (the DB-surface shrink the control-plane claim delivers).
//   - Otherwise → `undefined`, so the worker falls back to the in-process
//     `DirectJobClaimClient` (the unchanged DB-CAS). The single-process
//     `TANREN_RUN_WORKER=1` dev path always lands here — it shares the API pool,
//     so a network claim hop would add risk for no isolation gain.
//
// The flag-off direct-DB fallback is a DEV affordance ONLY: a STANDALONE
// (de-privileged data-plane) worker that boots without the mTLS claim endpoint
// would silently revert to the direct DB path — exactly the privilege the split
// removes. `assertStandaloneClaimMtlsConfigured` makes that a LOUD boot failure;
// the in-process dev path stays on the silent direct-DB fallback by design.
//
// CLAIM SEMANTICS ARE IDENTICAL either way: the endpoint wraps the SAME
// `JobQueue.claim`. See ROADMAP.md.

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

/**
 * Assert the STANDALONE (de-privileged data-plane) worker has its mTLS claim
 * endpoint configured — throw a LOUD boot error otherwise. A standalone worker
 * that boots with no `TANREN_CLAIM_ENDPOINT_URL` would silently revert to the
 * DIRECT `job_queue` DB-CAS, re-acquiring the very privilege the plane split
 * removes. Called ONLY for `mode: "standalone"`; the in-process dev path keeps
 * the documented silent direct-DB fallback (it shares the API's pool).
 */
export function assertStandaloneClaimMtlsConfigured(): void {
  if (!process.env["TANREN_CLAIM_ENDPOINT_URL"]) {
    throw new Error(
      "A standalone data-plane worker requires the mTLS claim endpoint (TANREN_CLAIM_ENDPOINT_URL " +
        "+ TANREN_DATA_PLANE_TLS_CERT/KEY/CA) — refusing to boot the de-privileged worker on the direct " +
        "job_queue DB-CAS fallback (that fallback is the in-process dev path only). Configure the endpoint, " +
        "or run the worker in-process (TANREN_RUN_WORKER=1) for single-process dev.",
    );
  }
  // The endpoint is set; the cert ENV must also be present (the partial-config
  // case — endpoint set, certs unset — is a misconfigured channel). We check
  // PRESENCE here (not a file read): `bootRunWorker` then constructs the real
  // mTLS client, which reads + validates the cert files on the live boot path.
  if (dataPlaneMtlsCertPathsFromEnv() === undefined) {
    throw new Error(
      "A standalone data-plane worker has TANREN_CLAIM_ENDPOINT_URL set but the data-plane mTLS cert env " +
        "(TANREN_DATA_PLANE_TLS_CERT/KEY/CA) is incomplete — refusing to claim over an unauthenticated channel.",
    );
  }
}
