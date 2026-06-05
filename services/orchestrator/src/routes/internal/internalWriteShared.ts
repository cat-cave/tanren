// The shared deps + peer-authn helper the internal write routes
// use. Extracted from `runStateWrites.ts` so both it and the lifecycle routes
// (`runStateLifecycleWrites.ts`) can import them WITHOUT a circular dependency.

import type { Context } from "hono";
import type pg from "pg";
import type { MtlsPeerVerifier } from "../../engine/contracts/mtlsChannel.js";

export interface RunStateWriteRouteDeps {
  /** The control-plane pool the org-scoped writes run on (the worker holds none under). */
  pool: pg.Pool;
  /** Authenticates the inbound mTLS peer; an unverified caller is 401. */
  verifier: MtlsPeerVerifier;
}

/**
 * True when the inbound mTLS peer verifies. Shared by every internal write
 * endpoint (the writes + the lifecycle routes) so the
 * 401-before-any-DB-work authn is one helper. An unverified caller is rejected
 * before any DB access.
 */
export function verifyInternalPeer(verifier: MtlsPeerVerifier, c: Context): boolean {
  const incoming = (c.env as { incoming?: { socket?: unknown } } | undefined)?.incoming;
  return verifier.verify({ headers: c.req.raw.headers, socket: incoming?.socket }) !== undefined;
}
