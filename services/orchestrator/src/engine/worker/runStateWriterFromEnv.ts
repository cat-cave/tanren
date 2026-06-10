// Resolve the worker's RUN-STATE WRITER from the environment.
//
//   - With TANREN_DATA_PLANE_REMOTE_WRITES=1 AND the write endpoint URL +
//     data-plane mTLS certs configured, the worker routes its run-state writes
//     through the control plane: an `HttpRunStateWriter` on the SAME
//     `buildNodeMtlsFetch` channel used for the claim. The data plane then
//     writes NO tenant tables directly (the full de-privilege end-state).
//   - Otherwise → `undefined`, so the worker uses the DEFAULT `DirectRunStateWriter`
//     (today's in-process org-scoped DB writes). The flag-OFF path is unchanged —
//     so the cutover is REVERSIBLE: nothing changes unless the flag is set.
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

/**
 * Assert the STANDALONE (de-privileged data-plane) worker has remote run-state
 * writes configured — throw a LOUD boot error otherwise. With remote-writes off
 * the worker writes the tenant tables DIRECTLY; for the de-privileged data plane
 * (the `tanren_dataplane` role, no tenant write grant) that is both wrong and a
 * silent privilege regression. Called ONLY for `mode: "standalone"`; the
 * in-process dev path keeps the documented direct-write default.
 */
export function assertStandaloneRemoteWritesConfigured(): void {
  if (!remoteWritesEnabled()) {
    throw new Error(
      "A standalone data-plane worker requires remote run-state writes (TANREN_DATA_PLANE_REMOTE_WRITES=1 " +
        "+ the write endpoint + TANREN_DATA_PLANE_TLS_CERT/KEY/CA) — refusing to boot the de-privileged worker " +
        "on direct tenant-table writes (that default is the in-process dev path only). Enable remote writes, " +
        "or run the worker in-process (TANREN_RUN_WORKER=1) for single-process dev.",
    );
  }
  // Remote-writes is on; the write endpoint + cert ENV must also be present (the
  // partial-config cases). We check PRESENCE here (not a file read); `bootRunWorker`
  // then constructs the real mTLS writer, which reads + validates the cert files.
  const endpointUrl = process.env["TANREN_WRITE_ENDPOINT_URL"] ?? process.env["TANREN_CLAIM_ENDPOINT_URL"];
  if (!endpointUrl) {
    throw new Error(
      "A standalone data-plane worker has TANREN_DATA_PLANE_REMOTE_WRITES=1 but no control-plane write " +
        "endpoint is configured (set TANREN_WRITE_ENDPOINT_URL or TANREN_CLAIM_ENDPOINT_URL) — " +
        "refusing to write tenant tables directly.",
    );
  }
  if (dataPlaneMtlsCertPathsFromEnv() === undefined) {
    throw new Error(
      "A standalone data-plane worker has TANREN_DATA_PLANE_REMOTE_WRITES=1 but the data-plane mTLS cert env " +
        "(TANREN_DATA_PLANE_TLS_CERT/KEY/CA) is incomplete — refusing to post writes over an unauthenticated channel.",
    );
  }
}
