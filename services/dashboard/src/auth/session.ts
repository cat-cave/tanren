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
  deps: DashboardSessionDeps,
): Promise<DashboardSession | undefined> {
  if (cookieHeader === undefined || cookieHeader === "") {
    return undefined;
  }
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = await fetchImpl(`${deps.orchestratorUrl}/auth/me`, {
    headers: { cookie: cookieHeader, Accept: "application/json" },
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
  return process.env["TANREN_DEV_LOGIN"] === "1";
}

export function loginUrl(orchestratorUrl: string, next: string = "/"): string {
  const provider = devLoginEnabled() ? "local_dev" : "github_oauth";
  const params = new URLSearchParams({ provider, next });
  return `${orchestratorUrl}/auth/login?${params.toString()}`;
}

const STATE_COOKIE = "tanren_oauth_state";

export interface DevLoginHandshakeResult {
  /** The raw `Set-Cookie` value for `tanren_session` to re-emit on the dashboard origin. */
  sessionSetCookie: string;
  /** The dashboard-relative path to redirect the browser to once the cookie is set. */
  next: string;
}

export class DevLoginHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevLoginHandshakeError";
  }
}

/** Extract the value of a single `name=` cookie from one Set-Cookie header value. */
function cookieValueFromSetCookie(setCookie: string, name: string): string | undefined {
  // A Set-Cookie value starts with `name=value; attr; attr`. We only need the
  // first segment (the pair), and only when the name matches.
  const firstPair = setCookie.split(";", 1)[0]?.trim() ?? "";
  const eq = firstPair.indexOf("=");
  if (eq === -1) {
    return undefined;
  }
  if (firstPair.slice(0, eq) !== name) {
    return undefined;
  }
  return firstPair.slice(eq + 1);
}

/**
 * Find the first Set-Cookie header (across one-or-more raw header values) that
 * sets `name`, returning the whole raw Set-Cookie string (attributes intact).
 */
function findSetCookie(setCookies: string[], name: string): string | undefined {
  for (const raw of setCookies) {
    if (cookieValueFromSetCookie(raw, name) !== undefined) {
      return raw;
    }
  }
  return undefined;
}

/**
 * Read the (possibly multiple) Set-Cookie header values off a fetch Response in a
 * way that works whether the runtime exposes `getSetCookie()` (undici) or only the
 * folded `get("set-cookie")`. Returns one entry per cookie where possible.
 */
function readSetCookies(headers: Headers): string[] {
  const getSetCookie = (headers as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const all = getSetCookie.call(headers);
    if (all.length > 0) {
      return all;
    }
  }
  const folded = headers.get("set-cookie");
  return folded === null ? [] : [folded];
}

/**
 * DEV-ONLY server-side (BFF) auth handshake against the orchestrator's `local_dev`
 * provider. Runs the entire login → callback exchange from the dashboard against the
 * internal `orchestratorUrl`, so the browser never has to reach a docker-internal
 * hostname. Returns the orchestrator's `tanren_session` Set-Cookie (to be re-emitted
 * verbatim on the dashboard's own origin) plus the dashboard-relative `next` path.
 *
 * Because `local_dev`'s exchangeCode returns a fixed identity with no external
 * round-trip and `tanren_session` is host-scoped to `localhost` (shared across ports),
 * the cookie the dashboard emits is valid for both the dashboard and orchestrator.
 *
 * Throws {@link DevLoginHandshakeError} on any non-redirect/non-2xx response or when
 * the expected cookies are absent; callers should surface a generic /signin error
 * (never leak the internal orchestrator URL to the browser).
 */
export async function devLoginHandshake(
  orchestratorUrl: string,
  next: string = "/",
  fetchImpl: typeof fetch = fetch,
): Promise<DevLoginHandshakeResult> {
  // Step 1 — drive the orchestrator login. local_dev 302s straight to the callback
  // URL (carrying state+code) and sets the oauth-state cookie.
  const loginParams = new URLSearchParams({ provider: "local_dev", next });
  const loginResponse = await fetchImpl(`${orchestratorUrl}/auth/login?${loginParams.toString()}`, {
    redirect: "manual",
    headers: { Accept: "application/json" },
  });
  if (loginResponse.status !== 302 && loginResponse.status !== 303) {
    throw new DevLoginHandshakeError(`login step returned ${loginResponse.status}`);
  }
  const location = loginResponse.headers.get("location");
  if (location === null || location === "") {
    throw new DevLoginHandshakeError("login step missing Location header");
  }
  const stateSetCookie = findSetCookie(readSetCookies(loginResponse.headers), STATE_COOKIE);
  if (stateSetCookie === undefined) {
    throw new DevLoginHandshakeError("login step missing oauth-state cookie");
  }
  const stateValue = cookieValueFromSetCookie(stateSetCookie, STATE_COOKIE);
  if (stateValue === undefined) {
    throw new DevLoginHandshakeError("could not parse oauth-state cookie");
  }

  // The Location is the callback URL (may be relative to the orchestrator). Parse
  // state/code/provider out of it and rebuild against the INTERNAL base so we never
  // depend on the orchestrator's externally-advertised host.
  const callbackUrl = new URL(location, orchestratorUrl);
  const state = callbackUrl.searchParams.get("state");
  const code = callbackUrl.searchParams.get("code");
  const provider = callbackUrl.searchParams.get("provider") ?? "local_dev";
  if (state === null || code === null) {
    throw new DevLoginHandshakeError("callback URL missing state/code");
  }

  // Step 2 — complete the callback, forwarding the state cookie so the orchestrator's
  // state-match check passes. local_dev mints the session and 200s with the session
  // Set-Cookie.
  const callbackParams = new URLSearchParams({ provider, state, code });
  const callbackResponse = await fetchImpl(`${orchestratorUrl}/auth/callback?${callbackParams.toString()}`, {
    redirect: "manual",
    headers: {
      Accept: "application/json",
      Cookie: `${STATE_COOKIE}=${stateValue}`,
    },
  });
  if (!callbackResponse.ok) {
    throw new DevLoginHandshakeError(`callback step returned ${callbackResponse.status}`);
  }
  const sessionSetCookie = findSetCookie(readSetCookies(callbackResponse.headers), "tanren_session");
  if (sessionSetCookie === undefined) {
    throw new DevLoginHandshakeError("callback step missing session cookie");
  }

  return { sessionSetCookie, next };
}
