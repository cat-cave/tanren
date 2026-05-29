import { readAuth, writeAuth, type StoredAuth } from "./store.js";

export interface LoginOptions {
  orchestratorUrl: string;
  token?: string;
  name?: string;
  /** Override the underlying fetch implementation (used in tests). */
  fetchImpl?: typeof fetch;
  /** Optional callback to print the browser URL (returned by /auth/cli/start). */
  onAuthorizeUrl?: (authorizeUrl: string) => void;
  /** Path to the auth file; defaults to ~/.config/tanren/auth.json. */
  authFile?: string;
}

export interface LoginResult {
  auth: StoredAuth;
  authorizeUrl?: string;
}

/**
 * `tanren auth login` flow:
 * - If a raw token is supplied via --token, persist it directly.
 * - Otherwise, ask the orchestrator to start the CLI flow, surface the authorize URL to the
 *   user, and accept the token returned from /auth/cli/complete (run via the dashboard).
 */
export async function login(options: LoginOptions): Promise<LoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (options.token !== undefined && options.token !== "") {
    const auth: StoredAuth = {
      orchestratorUrl: options.orchestratorUrl,
      token: options.token,
      name: options.name,
      createdAt: new Date().toISOString(),
    };
    await writeAuth(auth, options.authFile);
    return { auth };
  }
  const startResponse = await fetchImpl(`${options.orchestratorUrl}/auth/cli/start`, {
    headers: { Accept: "application/json" },
  });
  if (!startResponse.ok) {
    throw new Error(`failed to start CLI auth: ${startResponse.status}`);
  }
  const start = (await startResponse.json()) as { authorizeUrl: string; completeUrl: string };
  options.onAuthorizeUrl?.(start.authorizeUrl);
  throw new CliLoginIncomplete(start.authorizeUrl, start.completeUrl);
}

export class CliLoginIncomplete extends Error {
  constructor(
    readonly authorizeUrl: string,
    readonly completeUrl: string,
  ) {
    super(
      `Open ${authorizeUrl} in your browser to sign in, then call POST ${completeUrl} with your session cookie to mint a token. Paste the returned token with --token.`,
    );
  }
}

export async function authHeaders(): Promise<Record<string, string>> {
  const auth = await readAuth();
  if (auth === undefined || auth.token === "") {
    return {};
  }
  return { Authorization: `Bearer ${auth.token}` };
}
