// Shared HTTP client for the CLI. Lives in its own module (not main.ts) so the
// per-verb command modules under commands/ can call `request`/`jsonRequest`
// without importing main.ts — main.ts imports commands/dispatch.ts, which
// imports those command modules, so a main.ts-hosted client would close an
// import cycle.
import { authHeaders } from "./auth/index.js";

// CANONICAL orchestrator public base URL (`TANREN_PUBLIC_BASE_URL`) — the single
// name for the orchestrator's reachable address, shared with the orchestrator's
// OAuth redirect base and the dashboard's App-install href. The old CLI-only
// `TANREN_ORCHESTRATOR_URL` name is deleted.
export const orchestratorUrl = process.env["TANREN_PUBLIC_BASE_URL"] ?? "http://localhost:3100";

function mergeAuthHeaders(init: RequestInit | undefined, auth: Record<string, string>): RequestInit | undefined {
  if (Object.keys(auth).length === 0) {
    return init;
  }
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(auth)) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return { ...init, headers };
}

export async function request(path: string, init?: RequestInit) {
  const auth = await authHeaders();
  const finalInit = mergeAuthHeaders(init, auth);
  const response = await fetch(`${orchestratorUrl}${path}`, finalInit);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<unknown>;
}

export async function jsonRequest(
  path: string,
  body: unknown,
  options: { method?: "POST" | "PATCH" | "PUT" | "DELETE" } = {},
) {
  return await request(path, {
    method: options.method ?? "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
