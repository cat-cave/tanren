/**
 * HTTP transport base for the orchestrator product client.
 *
 * Holds the request-forwarding plumbing every typed method on
 * `OrchestratorClient` shares: the orchestrator base URL, the inbound cookie
 * header (forwarded for session auth), and the two defensive JSON helpers.
 * `getJson` swallows network + parse failures (→ `undefined`); `sendJson`
 * serves every write caller (POST/PATCH/DELETE, optional body — content-type is
 * only set when a body is present). Both degrade to an empty/undefined result
 * so a page never 500s when one panel's data source is unavailable.
 *
 * Split out of `orchestrator.ts` so the product surface stays under the
 * 500-line architecture cap; it is a pure transport detail with no product
 * semantics of its own.
 */

export interface OrchestratorClientDeps {
  orchestratorUrl: string;
  /** Inbound dashboard request cookie header, forwarded for session auth. */
  cookieHeader?: string;
  fetchImpl?: typeof fetch;
}

export abstract class OrchestratorHttpClient {
  protected readonly orchestratorUrl: string;
  protected readonly cookieHeader: string | undefined;
  protected readonly fetchImpl: typeof fetch;

  constructor(deps: OrchestratorClientDeps) {
    this.orchestratorUrl = deps.orchestratorUrl;
    this.cookieHeader = deps.cookieHeader;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  protected headers(extra?: Record<string, string>): Record<string, string> {
    const base: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.cookieHeader !== undefined && this.cookieHeader !== "") {
      base.cookie = this.cookieHeader;
    }
    return base;
  }

  protected async getJson<T>(path: string): Promise<T | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      headers: this.headers()
    }).catch(() => undefined);
    if (response === undefined || !response.ok) {
      return undefined;
    }
    return (await response.json().catch(() => undefined)) as T | undefined;
  }

  protected async sendJson<T = unknown>(
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<{ ok: boolean; status: number; body: T | undefined }> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).catch(() => undefined);
    if (response === undefined) {
      return { ok: false, status: 0, body: undefined };
    }
    const json = (await response.json().catch(() => undefined)) as T | undefined;
    return { ok: response.ok, status: response.status, body: json };
  }
}
