// The injectable HTTP transport the deploy provisioners run over. A
// thin `request` seam so the Vercel/Fly provisioners are unit-tested against a
// SCRIPTED fake (no real Vercel/Fly calls in CI) while production wires the real
// `fetch`-backed transport. Mirrors the injectable-client shape the cloud
// allocators (`HetznerClient`) and the `VaultSecretStore` (`fetchImpl`) already
// use: the provisioner owns the API shape; the transport owns only HTTP.

/** A single HTTP request the deploy provisioners issue against a provider API. */
export interface DeployHttpRequest {
  method: "GET" | "POST" | "DELETE";
  /** Absolute URL (the provisioner composes it from the provider's API base). */
  url: string;
  headers: Record<string, string>;
  /** JSON-serializable request body, when the method carries one. */
  body?: unknown;
}

/** The parsed HTTP response the transport returns. */
export interface DeployHttpResponse {
  status: number;
  ok: boolean;
  /** Parsed JSON body (or `undefined` for an empty/non-JSON body). */
  json: unknown;
  /** Raw text body, used only to enrich error messages. */
  text: string;
}

/**
 * The transport seam. `request` performs ONE HTTP call and returns its parsed
 * result. It NEVER throws on a non-2xx — the provisioner inspects `status`/`ok`
 * so it can distinguish "already exists" (find-or-create) from a real failure.
 */
export interface DeployHttpTransport {
  request(req: DeployHttpRequest): Promise<DeployHttpResponse>;
}

/**
 * The default per-request timeout (ms) for an outbound deploy-provider call. Bounds
 * EVERY Vercel/Fly HTTP call so a hung provider endpoint can never wedge a run
 * indefinitely (a merged run is terminal — there is no later wake to recover a hang).
 * An elapsed timeout aborts the fetch, surfacing as a LOUD throw the caller treats as
 * a request failure (never a silent stall).
 */
export const DEFAULT_DEPLOY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Production transport backed by the global `fetch`. The bearer token is supplied
 * by the caller (resolved from the SecretStore against the org grant's
 * `credentialRef`), never read from the environment here and never logged. Every
 * request is bounded by {@link DEFAULT_DEPLOY_REQUEST_TIMEOUT_MS} via an AbortSignal,
 * so a hung provider endpoint aborts LOUD rather than hanging the deploy path.
 */
export function fetchDeployTransport(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_DEPLOY_REQUEST_TIMEOUT_MS,
): DeployHttpTransport {
  return {
    async request(req: DeployHttpRequest): Promise<DeployHttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetchImpl(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown;
        try {
          json = text === "" ? undefined : JSON.parse(text);
        } catch {
          json = undefined;
        }
        return { status: response.status, ok: response.ok, json, text };
      } catch (error) {
        // An abort (timeout) or a transport-level failure surfaces LOUD — the
        // provisioner treats a thrown request as a hard failure (→ deploy.failed),
        // never a silent stall. Re-tag an abort so the message names the timeout.
        if (controller.signal.aborted) {
          throw new Error(`deploy transport: request to '${req.url}' timed out after ${String(timeoutMs)}ms`, {
            cause: error,
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
