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

export function loginUrl(orchestratorUrl: string, next: string = "/"): string {
  const params = new URLSearchParams({ provider: "github_oauth", next });
  return `${orchestratorUrl}/auth/login?${params.toString()}`;
}
