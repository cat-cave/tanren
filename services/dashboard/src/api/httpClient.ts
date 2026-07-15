/**
 * HTTP transport base for the orchestrator product client.
 *
 * Holds the request-forwarding plumbing every typed method on
 * `OrchestratorClient` shares: the orchestrator base URL, the inbound cookie
 * header (forwarded for session auth), and the two defensive JSON helpers.
 * `getJson` swallows network + parse failures (→ `undefined`); `sendJson`
 * serves every write caller (POST/PATCH/PUT/DELETE, optional body — content-type
 * is only set when a body is present). Typed write callers can mark a response
 * body required so a 2xx with an empty or malformed body is surfaced as failure
 * instead of being treated as a successful-but-undefined contract.
 *
 * Split out of `orchestrator.ts` so the product surface stays under the
 * 500-line architecture cap; it is a pure transport detail with no product
 * semantics of its own.
 */

export interface OrchestratorClientDeps {
  orchestratorUrl: string;
  /** Inbound dashboard request cookie header, forwarded for session auth. */
  cookieHeader?: string;
  /**
   * Session CSRF token from `/auth/me`. Required for state-changing session
   * requests (POST/PATCH/PUT/DELETE) against the orchestrator; omitted only for
   * local-dev actor mode where the orchestrator skips the CSRF gate.
   */
  csrfToken?: string;
  fetchImpl?: typeof fetch;
}

export interface SendJsonOptions {
  expectBody?: boolean;
}

export abstract class OrchestratorHttpClient {
  protected readonly orchestratorUrl: string;
  protected readonly cookieHeader: string | undefined;
  protected readonly csrfToken: string | undefined;
  protected readonly fetchImpl: typeof fetch;

  constructor(deps: OrchestratorClientDeps) {
    this.orchestratorUrl = deps.orchestratorUrl;
    this.cookieHeader = deps.cookieHeader;
    this.csrfToken = deps.csrfToken;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  protected headers(extra?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.cookieHeader !== undefined && this.cookieHeader !== "") {
      base["cookie"] = this.cookieHeader;
    }
    return base;
  }

  protected async getJson<T>(path: string): Promise<T | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || !response.ok) {
      return undefined;
    }
    return (await response.json().catch(() => {})) as T | undefined;
  }

  protected async sendJson<T = unknown>(
    method: "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    options: SendJsonOptions = {},
  ): Promise<{ ok: boolean; status: number; body: T | undefined }> {
    const writeHeaders: Record<string, string> = body === undefined ? {} : { "content-type": "application/json" };
    // Session-auth state-changing routes require x-csrf-token (orchestrator auth
    // middleware). Forward when the BFF resolved a session; local-dev actor mode
    // has no session and skips the gate.
    if (this.csrfToken !== undefined && this.csrfToken !== "") {
      writeHeaders["x-csrf-token"] = this.csrfToken;
    }
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      method,
      headers: this.headers(writeHeaders),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {});
    if (response === undefined) {
      return { ok: false, status: 0, body: undefined };
    }
    // JSON `null` is a parsed body but not a usable product payload — treat as
    // missing when the caller required a body (same fail-closed as empty/204).
    const raw: unknown = await response.json().catch(() => {});
    const json = raw === null || raw === undefined ? undefined : (raw as T);
    if (response.ok && options.expectBody === true && json === undefined) {
      return { ok: false, status: response.status, body: undefined };
    }
    return { ok: response.ok, status: response.status, body: json };
  }
}
