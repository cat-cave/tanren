export interface DashboardSession {
  userId: string;
  csrfToken: string;
  expiresAt: string;
}

export interface DashboardSessionDeps {
  orchestratorUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Server-side useSession hook for the Hono/JSX dashboard. Reads /auth/me via the
 * orchestrator and forwards the dashboard request's cookie header so the orchestrator
 * can validate the session.
 */
export async function useSession(
  cookieHeader: string | undefined,
  deps: DashboardSessionDeps
): Promise<DashboardSession | undefined> {
  if (cookieHeader === undefined || cookieHeader === "") {
    return undefined;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${deps.orchestratorUrl}/auth/me`, {
    headers: { cookie: cookieHeader, Accept: "application/json" }
  });
  if (!response.ok) {
    return undefined;
  }
  const json = (await response.json()) as DashboardSession;
  return json;
}

/**
 * True when the DEV-ONLY sign-in escape hatch is enabled (TANREN_DEV_LOGIN=1).
 * Only ever set in compose.dev.yml; compose.prod.yml MUST never set it. When on,
 * the dashboard drives the orchestrator's `local_dev` provider so an operator can
 * land authenticated without a registered GitHub OAuth app.
 */
export function devLoginEnabled(): boolean {
  return process.env.TANREN_DEV_LOGIN === "1";
}

export function loginUrl(orchestratorUrl: string, next: string = "/"): string {
  const provider = devLoginEnabled() ? "local_dev" : "github_oauth";
  const params = new URLSearchParams({ provider, next });
  return `${orchestratorUrl}/auth/login?${params.toString()}`;
}
