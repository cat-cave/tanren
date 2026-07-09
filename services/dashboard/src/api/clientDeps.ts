/**
 * Shared BFF client construction: cookie forward + **outbound** session CSRF.
 *
 * Every dashboard→orchestrator state-changing call must send `x-csrf-token`
 * when `/auth/me` yields a session. local-dev actor mode (no session) omits the
 * token so the orchestrator CSRF gate is skipped — never invent a placeholder.
 *
 * Inbound browser→dashboard CSRF is enforced separately (`rejectIfInboundCsrfInvalid`
 * middleware) so this helper never mints outbound CSRF for an unauthenticated
 * cross-site form post. Resolves CSRF via a probe `OrchestratorClient.session()`
 * (same as the #822 onboarding path) rather than the cookie-gated `useSession`
 * helper, so a mock or actor that answers `/auth/me` without a browser cookie
 * still works.
 */

import type { Context } from "hono";
import type { ShellDeps } from "../app/mountShell.js";
import type { OrchestratorClientDeps } from "./httpClient.js";
import { OrchestratorClient } from "./orchestrator.js";

/** Optional CSRF fragment for client deps (omit when empty / missing). */
export function csrfTokenDeps(csrfToken: string | undefined): Pick<OrchestratorClientDeps, "csrfToken"> {
  if (csrfToken === undefined || csrfToken === "") return {};
  return { csrfToken };
}

/**
 * Resolve orchestrator client deps for a dashboard request: forward the
 * inbound cookie and, when `/auth/me` yields a session, the CSRF token.
 */
export async function clientDepsFor(
  c: Context,
  deps: ShellDeps,
  fetchImpl?: typeof fetch,
): Promise<OrchestratorClientDeps> {
  const cookieHeader = c.req.header("cookie");
  const base: OrchestratorClientDeps = {
    orchestratorUrl: deps.orchestratorUrl,
    cookieHeader,
  };
  if (fetchImpl !== undefined) {
    base.fetchImpl = fetchImpl;
  }
  const session = await new OrchestratorClient(base).session();
  return {
    ...base,
    ...csrfTokenDeps(session?.csrfToken),
  };
}
