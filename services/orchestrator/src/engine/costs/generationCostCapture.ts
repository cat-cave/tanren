// generationCostCapture — the run-scoped seam that turns an OpenRouter generation
// id (surfaced by a managed CLI adapter onto TokenUsage.openRouterGenerationId)
// into the REAL per-call `usage.cost`, so a managed OpenRouter run records cost_usd
// as a metered FACT (`provider_response`) instead of leaving it NULL.
//
// WHEN IT FIRES. Only a MANAGED (platform-billed OpenRouter) run captures: the
// platform IS the biller, so OpenRouter's `total_cost` is the authoritative real
// deduction. A BYOK-through-OpenRouter run does NOT capture here — under BYOK the
// real spend lands on the tenant's upstream provider invoice, not OpenRouter's
// `total_cost`, so `realProviderCostFrom` would refuse it anyway; we simply build
// no capturer for BYOK and cost_usd stays NULL (`unknown`) — NO list-rate estimate.
//
// The platform OpenRouter KEY is resolved once at build time (the run's resolved
// managed credential ref → the secret store). The capturer is then a pure
// (generationId) → Promise<number | null>: it queries `/api/v1/generation`,
// returns the platform real cost when OpenRouter reports a positive `total_cost`,
// else null (an honest no-capture — never a fabricated figure). A transport/auth
// failure is swallowed to null (best-effort: a missed capture must NOT fail the
// run — cost-unknown is an allowed state — and the call already metered tokens).
import type { SecretStore } from "../contracts/secretStore.js";
import { resolveRawProviderKey } from "../credentials/managedKey.js";
import { providerSlugForRef } from "../credentials/credentialType.js";
import { queryGenerationCost, realProviderCostFrom, type OpenRouterHttpClient } from "./openRouterCost.js";

// The capturer the cost-recording path calls per writer/answerer call: given the
// generation id the adapter surfaced, resolve the REAL platform cost or null.
export type RealProviderCostCapturer = (generationId: string) => Promise<number | null>;

export interface GenerationCostCaptureDeps {
  secrets: SecretStore;
  // The run's resolved managed credential ref (the platform OpenRouter secret-store
  // key). Under managed mode this is the platform ref; it resolves to the raw
  // OpenRouter API key the query authenticates with.
  managedCredentialRef: string;
  // The managed OpenAI-compatible endpoint base URL (e.g. https://openrouter.ai/api/v1).
  endpointBaseUrl: string;
  // The HTTP client the query runs over. Defaults to a fetch-backed client; tests
  // inject a fake (no network).
  httpClient?: OpenRouterHttpClient;
}

// Build the managed-run capturer. Resolves the platform OpenRouter key up front
// (a missing/empty ref is a LOUD failure from resolveRawProviderKey — never a
// silent degrade) and returns a capturer closed over it. Call ONLY for a managed
// run; a BYOK run gets no capturer (its cost stays NULL, no estimate).
export async function buildManagedGenerationCostCapturer(
  deps: GenerationCostCaptureDeps,
): Promise<RealProviderCostCapturer> {
  // The capturer queries OpenRouter's generation-cost API with the platform key, so
  // the managed credential MUST be an openrouter ref — require the slug LOUD (a
  // non-openrouter key would only fail opaquely at the cost HTTP call).
  if (providerSlugForRef(deps.managedCredentialRef) !== "openrouter") {
    throw new Error(
      `managed generation-cost capture requires a credential/openrouter/ ref; got ${JSON.stringify(deps.managedCredentialRef)}`,
    );
  }
  const token = await resolveRawProviderKey(deps.secrets, deps.managedCredentialRef);
  const client = deps.httpClient ?? fetchOpenRouterHttpClient();
  return async (generationId: string): Promise<number | null> => {
    if (generationId === "") {
      return null;
    }
    try {
      const cost = await queryGenerationCost(client, {
        generationId,
        token,
        billingModel: "platform",
        baseUrl: deps.endpointBaseUrl,
      });
      return realProviderCostFrom(cost);
    } catch {
      // Best-effort: a transport/auth miss must NOT fail the run. cost_usd then
      // stays NULL (`unknown`) for this call — an honest no-capture, no estimate.
      return null;
    }
  };
}

// A fetch-backed OpenRouterHttpClient (production). Bearer-authenticates the GET
// against `${baseUrl}${path}` and returns the parsed JSON body + status; the query
// layer (openRouterCost.ts) extracts `total_cost` and throws on non-200.
function fetchOpenRouterHttpClient(): OpenRouterHttpClient {
  return {
    async request(input) {
      const url = `${input.baseUrl.replace(/\/$/u, "")}${input.path}`;
      const response = await fetch(url, {
        method: input.method,
        headers: { authorization: `Bearer ${input.token}` },
      });
      const body: unknown = await response.json().catch(() => null);
      return { status: response.status, body };
    },
  };
}
