// Plane-split P3: resolve the worker's RUN-STATE WRITER from the environment.
//
//   - With TANREN_DATA_PLANE_REMOTE_WRITES=1 AND the write endpoint URL +
//     data-plane mTLS certs configured, the worker routes its run-state writes
//     through the control plane: an `HttpRunStateWriter` on the SAME
//     `buildNodeMtlsFetch` channel P2 built for the claim. The data plane then
//     writes NO tenant tables directly (the P3 de-privilege end-state).
//   - Otherwise → `undefined`, so the worker uses the DEFAULT `DirectRunStateWriter`
//     (today's in-process org-scoped DB writes). The flag-OFF path is unchanged —
//     so P3 is REVERSIBLE: nothing changes unless the flag is explicitly set.
//
// The write endpoint shares the claim endpoint's host (the internal mTLS
// listener), so it reuses TANREN_CLAIM_ENDPOINT_URL by default; an override
// (TANREN_WRITE_ENDPOINT_URL) is supported for a split topology. The mTLS cert
// material is the SAME data-plane cert env the claim path uses.

import { buildNodeMtlsFetch } from "../contracts/mtlsChannelNode.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { dataPlaneMtlsCertPathsFromEnv } from "./claimClientFromEnv.js";
import { HttpRunStateWriter } from "./httpRunStateWriter.js";

/** True when the worker is configured to route its run-state writes through the control plane. */
export function remoteWritesEnabled(): boolean {
  return process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] === "1";
}

/**
 * Build the worker's remote run-state writer from env, or `undefined` to use the
 * in-process `DirectRunStateWriter`. Returns a writer ONLY when remote-writes is
 * flagged on AND the endpoint + data-plane cert material are present; a partial
 * config (flag on but missing endpoint/certs) throws loudly rather than silently
 * falling back to direct writes (which would defeat the de-privilege intent).
 */
export function buildRunStateWriterFromEnv(): RunStateWriter | undefined {
  if (!remoteWritesEnabled()) {
    return undefined;
  }
  const endpointUrl = process.env["TANREN_WRITE_ENDPOINT_URL"] ?? process.env["TANREN_CLAIM_ENDPOINT_URL"];
  if (!endpointUrl) {
    throw new Error(
      "TANREN_DATA_PLANE_REMOTE_WRITES=1 but no control-plane write endpoint is configured " +
        "(set TANREN_WRITE_ENDPOINT_URL or TANREN_CLAIM_ENDPOINT_URL) — refusing to write tenant tables directly",
    );
  }
  const certPaths = dataPlaneMtlsCertPathsFromEnv();
  if (certPaths === undefined) {
    throw new Error(
      "TANREN_DATA_PLANE_REMOTE_WRITES=1 but the data-plane mTLS cert env " +
        "(TANREN_DATA_PLANE_TLS_CERT/KEY/CA) is incomplete — refusing to post writes over an unauthenticated channel",
    );
  }
  return new HttpRunStateWriter(endpointUrl, buildNodeMtlsFetch(certPaths));
}
