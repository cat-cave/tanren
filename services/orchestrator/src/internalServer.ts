// The control-plane INTERNAL mTLS listener. A SEPARATE HTTPS
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
// ROADMAP.md.

import { createServer } from "node:https";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type pg from "pg";
import { type MtlsCertPaths, NodeMtlsPeerVerifier, nodeMtlsServerOptions } from "./engine/contracts/mtlsChannelNode.js";
import { createInternalClaimRoutes } from "./routes/internal/claimJob.js";
import { createInternalRunStateWriteRoutes } from "./routes/internal/runStateWrites.js";
import { parsedEnv } from "./envSchema.js";
import { createLogger } from "./engine/observability/logger.js";

const log = createLogger("internal-mtls");

// The internal mTLS listener port (default 3110) is owned by envSchema.ts
// (parsedEnv.TANREN_INTERNAL_MTLS_PORT) — validated as a port once at boot.

/** Resolve the internal listener's cert paths from the validated env, or `undefined` when unset. */
export function internalMtlsCertPathsFromEnv(): MtlsCertPaths | undefined {
  const certPath = parsedEnv.TANREN_INTERNAL_TLS_CERT;
  const keyPath = parsedEnv.TANREN_INTERNAL_TLS_KEY;
  const caPath = parsedEnv.TANREN_INTERNAL_TLS_CA;
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
  const verifier = new NodeMtlsPeerVerifier();
  app.route("/", createInternalClaimRoutes({ pool: deps.pool, verifier }));
  // The run-state WRITE endpoints (append-event / record-cost /
  // finalize-run) the remote-writes worker posts its tenant writes to.
  app.route("/", createInternalRunStateWriteRoutes({ pool: deps.pool, verifier }));
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
  const port = parsedEnv.TANREN_INTERNAL_MTLS_PORT;
  const app = buildInternalApp({ pool: deps.pool });
  const tlsOptions = nodeMtlsServerOptions(certPaths);
  serve({
    fetch: app.fetch,
    port,
    createServer,
    serverOptions: tlsOptions,
  });
  log.info("internal mTLS control-plane listening (claim + run-state-write endpoints)", { port });
  return true;
}
