// Plane-split P2: the control-plane INTERNAL mTLS listener. A SEPARATE HTTPS
// server from the public API (`main.ts`, plain HTTP on ORCHESTRATOR_PORT) that
// serves ONLY the internal `/internal/*` surface — today the `/internal/claim-job`
// endpoint the data-plane worker claims through. Keeping it on its own port +
// its own mutually-authenticated TLS context means the claim endpoint is NEVER
// reachable on the public surface and ALWAYS requires a trusted client cert.
//
// Wiring (all by env, so dev self-signed certs and prod real certs use the same
// seam):
//   - TANREN_INTERNAL_MTLS_PORT       — the internal listener port (default 3110)
//   - TANREN_INTERNAL_TLS_CERT/KEY/CA — the control plane's server cert + key +
//                                       the CA that signs trusted data-plane certs
// When the cert env is unset the internal listener does NOT start (single-process
// dev / the in-process `TANREN_RUN_WORKER=1` path needs no network claim). See
// docs/roadmap/saas-rls-and-plane-split-plan.md (plane-split P2).

import { createServer } from "node:https";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type pg from "pg";
import { type MtlsCertPaths, NodeMtlsPeerVerifier, nodeMtlsServerOptions } from "./engine/contracts/mtlsChannelNode.js";
import { createInternalClaimRoutes } from "./routes/internal/claimJob.js";

export const DEFAULT_INTERNAL_MTLS_PORT = 3110;

/** Resolve the internal listener's cert paths from env, or `undefined` when unset. */
export function internalMtlsCertPathsFromEnv(): MtlsCertPaths | undefined {
  const certPath = process.env["TANREN_INTERNAL_TLS_CERT"];
  const keyPath = process.env["TANREN_INTERNAL_TLS_KEY"];
  const caPath = process.env["TANREN_INTERNAL_TLS_CA"];
  if (!certPath || !keyPath || !caPath) {
    return undefined;
  }
  return { certPath, keyPath, caPath };
}

/** Build the internal control-plane Hono app (the `/internal/*` surface). */
export function buildInternalApp(deps: { pool: pg.Pool }): Hono {
  const app = new Hono();
  // The Node verifier reads the TLS-validated client cert off the inbound
  // socket; the mTLS server below already rejected an untrusted cert at the
  // handshake, so this is defense-in-depth + the peer-identity surface.
  app.route("/", createInternalClaimRoutes({ pool: deps.pool, verifier: new NodeMtlsPeerVerifier() }));
  return app;
}

/**
 * Start the internal mTLS listener when configured. Returns `false` (and starts
 * nothing) when the cert env is unset — the in-process dev path claims directly,
 * so no internal channel is needed. The HTTPS server REQUIRES a client cert
 * (`requestCert` + `rejectUnauthorized`), so only a trusted data-plane peer can
 * even open a connection.
 */
export function startInternalMtlsServer(deps: { pool: pg.Pool }): boolean {
  const certPaths = internalMtlsCertPathsFromEnv();
  if (certPaths === undefined) {
    return false;
  }
  const port = Number(process.env["TANREN_INTERNAL_MTLS_PORT"] ?? DEFAULT_INTERNAL_MTLS_PORT);
  const app = buildInternalApp({ pool: deps.pool });
  const tlsOptions = nodeMtlsServerOptions(certPaths);
  serve({
    fetch: app.fetch,
    port,
    createServer,
    serverOptions: tlsOptions,
  });
  console.log(`internal mTLS control-plane listening on :${port} (claim endpoint)`);
  return true;
}
