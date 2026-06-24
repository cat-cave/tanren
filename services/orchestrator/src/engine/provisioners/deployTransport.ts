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
 * The default per-request ABORT window (ms) for ONE outbound deploy-provider HTTP call —
 * the blessed connect/response-establishment bound (feedback_no_timeouts_progress_based:
 * a single-request fetch abort is NOT a poll/attempt budget over converging work). Bounds
 * EVERY Vercel/Fly call so a hung provider socket can never wedge a run indefinitely (a
 * merged run is terminal — no later wake to recover a hang). The abort surfaces as a LOUD
 * throw the caller treats as a request failure (never a silent stall). It does NOT cap how
 * many polls verify issues — that loop is unbounded poll-until-terminal.
 */
export const DEFAULT_DEPLOY_REQUEST_ABORT_MS = 30_000;

/**
 * Production transport backed by the global `fetch`. The bearer token is supplied
 * by the caller (resolved from the SecretStore against the org grant's
 * `credentialRef`), never read from the environment here and never logged. Every
 * request is bounded by {@link DEFAULT_DEPLOY_REQUEST_ABORT_MS} via an AbortSignal,
 * so a hung provider endpoint aborts LOUD rather than hanging the deploy path.
 */
export function fetchDeployTransport(
  fetchImpl: typeof fetch = fetch,
  abortMs: number = DEFAULT_DEPLOY_REQUEST_ABORT_MS,
): DeployHttpTransport {
  return {
    async request(req: DeployHttpRequest): Promise<DeployHttpResponse> {
      const controller = new AbortController();
      // Blessed connect/response-establishment bound on ONE outbound deploy-provider
      // HTTP call (per the DEFAULT_DEPLOY_REQUEST_ABORT_MS docstring above): not a
      // poll/attempt budget over converging work — a discrete one-shot request whose
      // only outcomes are (response | abort), so the abort cannot truncate legitimate work.
      const timer = setTimeout(() => {
        // arch-allow: timeout-class — see comment above
        controller.abort();
      }, abortMs);
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
        // An abort (the per-request window elapsed) or a transport-level failure surfaces
        // LOUD — the provisioner treats a thrown request as a hard failure (→ deploy.failed),
        // never a silent stall. Re-tag an abort so the message names the elapsed window.
        if (controller.signal.aborted) {
          throw new Error(`deploy transport: request to '${req.url}' aborted after ${String(abortMs)}ms`, {
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
