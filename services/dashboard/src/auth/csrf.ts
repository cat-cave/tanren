/**
 * Inbound browser→dashboard CSRF verification for state-changing BFF writes.
 *
 * Session cookies alone are not enough for defense-in-depth: without this gate
 * the BFF would mint orchestrator `x-csrf-token` from `/auth/me` for any
 * cookie-authenticated browser POST (form or JSON), acting as a CSRF-token
 * minting proxy. When a session cookie is present and `/auth/me` yields a
 * non-empty `csrfToken`, the request must present the same value via
 * `x-csrf-token` header and/or form field `csrf` (alias `csrfToken`).
 *
 * local-dev actor mode (no session cookie / empty token) skips the gate — same
 * posture as outbound `clientDepsFor`.
 */

import { timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import type { ShellDeps } from "../app/mountShell.js";
import { formField } from "../routes/formField.js";
import { useSession } from "./session.js";

/** Header name (matches orchestrator `CSRF_HEADER`). */
export const CSRF_HEADER = "x-csrf-token";

/** Primary form field name for server-rendered POSTs (works without JS). */
export const CSRF_FORM_FIELD = "csrf";

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING.has(method.toUpperCase());
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Read the CSRF token the browser presented: header first (JSON islands), then
 * form fields for pure HTML posts.
 */
export async function readPresentedCsrf(c: Context): Promise<string | undefined> {
  const header = c.req.header(CSRF_HEADER)?.trim();
  if (header !== undefined && header !== "") {
    return header;
  }

  const contentType = c.req.header("content-type") ?? "";
  // JSON bodies do not carry form fields; only form-encoded / multipart do.
  if (!contentType.includes("application/x-www-form-urlencoded") && !contentType.includes("multipart/form-data")) {
    return undefined;
  }

  try {
    const form = await c.req.parseBody();
    const primary = formField(form, CSRF_FORM_FIELD).trim();
    if (primary !== "") return primary;
    const alias = formField(form, "csrfToken").trim();
    if (alias !== "") return alias;
  } catch {
    // Unreadable body → treat as missing token.
  }
  return undefined;
}

/**
 * Resolve the expected session CSRF for this request (cookie → `/auth/me`).
 * Returns `undefined` when there is no cookie-authenticated session (local-dev
 * actor / unauthenticated) — inbound CSRF is not required in those modes.
 */
export async function resolveExpectedCsrf(
  c: Context,
  deps: ShellDeps,
  fetchImpl?: typeof fetch,
): Promise<string | undefined> {
  const cookieHeader = c.req.header("cookie");
  if (cookieHeader === undefined || cookieHeader === "") {
    return undefined;
  }
  const sessionDeps =
    fetchImpl === undefined
      ? { orchestratorUrl: deps.orchestratorUrl }
      : { orchestratorUrl: deps.orchestratorUrl, fetchImpl };
  const session = await useSession(cookieHeader, sessionDeps);
  const token = session?.csrfToken;
  if (token === undefined || token === "") {
    return undefined;
  }
  return token;
}

/**
 * Verify inbound CSRF for a state-changing dashboard request.
 *
 * @returns a 403 Response when the gate fails; `null` when the request may proceed.
 */
export async function rejectIfInboundCsrfInvalid(
  c: Context,
  deps: ShellDeps,
  fetchImpl?: typeof fetch,
): Promise<Response | null> {
  if (!isStateChangingMethod(c.req.method)) {
    return null;
  }

  const expected = await resolveExpectedCsrf(c, deps, fetchImpl);
  if (expected === undefined) {
    return null;
  }

  const presented = await readPresentedCsrf(c);
  if (presented === undefined || !safeEqual(presented, expected)) {
    return c.json({ error: "csrf_token_invalid" }, 403);
  }
  return null;
}
