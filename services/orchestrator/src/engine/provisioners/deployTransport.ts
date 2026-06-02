// The injectable HTTP transport the deploy provisioners run over (P-INT-4). A
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
 * Production transport backed by the global `fetch`. The bearer token is supplied
 * by the caller (resolved from the SecretStore against the org grant's
 * `credentialRef`), never read from the environment here and never logged.
 */
export function fetchDeployTransport(fetchImpl: typeof fetch = fetch): DeployHttpTransport {
  return {
    async request(req: DeployHttpRequest): Promise<DeployHttpResponse> {
      const response = await fetchImpl(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, ok: response.ok, json, text };
    },
  };
}
