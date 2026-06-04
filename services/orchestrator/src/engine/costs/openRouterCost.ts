// openRouterCost — the post-call query that captures OpenRouter's OWN
// authoritative per-call charge, the only provider surface that hands back a
// REAL-dollar figure per generation.
//
// WHAT OPENROUTER RETURNS. After a completion, OpenRouter exposes the actual
// amount it deducted from the account balance via
// `GET /api/v1/generation?id=<generationId>`:
//   - `total_cost`         — the REAL charge in credits/USD for that generation,
//                            computed by OpenRouter from the provider's native
//                            token usage with NO inference markup, so it ≈ the
//                            real provider charge. This is what we want.
//   - `usage`              — OpenRouter's own usage figure (informational).
//   - `cache_discount`     — any cache savings already folded into total_cost.
// The same figure rides on a streamed/non-streamed completion's `usage.cost`
// when `usage: { include: true }` is requested; this client is the post-call
// fetch for the (common) case where the harness only learns the generation id
// afterward. It feeds `CostRecorder.record`'s `realProviderCostUsd` →
// cost_basis `provider_response`, which OUTRANKS the static rate table.
//
// REACHABILITY TODAY (honest gap, see CostRecordContext.realProviderCostUsd):
// Tanren runs models through CLI adapters (codex/aider/pi/opencode) that do NOT
// surface OpenRouter's generation id in their output, so there is no id to query
// per call right now. This client is the REAL, tested capture path the moment an
// adapter (or the managed OpenAI-compatible shim) surfaces that id; until then an
// OpenRouter per_token row prices from the static table and is flagged
// `estimateOnly` (LOUD) — it is NEVER silently presented as the real deduction.
//
// BYOK CAVEAT. Under bring-your-own-key (the tenant's own upstream provider key
// behind OpenRouter), OpenRouter's `total_cost` is its ROUTING/credit figure, not
// the tenant's upstream bill — the real spend lands on the upstream provider's
// invoice. So a BYOK call's `total_cost` is NOT the full real spend. This client
// therefore takes an explicit `billingModel` and, for `byok`, returns a result
// FLAGGED `upstreamBilled: true` (and refuses to assert it as authoritative real
// spend) so the caller never records a partial figure as the real deduction.

// One generation's cost as OpenRouter reports it. `totalCostUsd` is the real
// platform charge; `upstreamBilled` marks a BYOK call whose real spend is on the
// upstream provider's bill (so totalCostUsd is NOT the authoritative real spend).
export interface OpenRouterGenerationCost {
  generationId: string;
  totalCostUsd: number;
  upstreamBilled: boolean;
}

// The injectable transport (mirrors the inbox connectors' HttpClient shape) so
// tests drive it with a fake — no live OpenRouter key, no network.
export interface OpenRouterHttpRequest {
  method: "GET";
  path: string;
  token: string;
  baseUrl: string;
}

export interface OpenRouterHttpResponse {
  status: number;
  body: unknown;
}

export interface OpenRouterHttpClient {
  request(input: OpenRouterHttpRequest): Promise<OpenRouterHttpResponse>;
}

export interface OpenRouterCostQueryInput {
  // The generation id from the completion (OpenRouter's response `id`). The CLI
  // adapters do not surface this yet — see this module's REACHABILITY note.
  generationId: string;
  // The resolved OpenRouter API key (the platform key for managed, the tenant's
  // for a tenant-imported OpenRouter credential).
  token: string;
  // 'platform' — OpenRouter is the biller, so total_cost IS the real spend.
  // 'byok'     — an upstream provider is the real biller; total_cost is the
  //              routing figure only, so it is flagged upstreamBilled and is NOT
  //              the authoritative real spend.
  billingModel: "platform" | "byok";
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// queryGenerationCost fetches one generation's REAL OpenRouter charge. Returns
// the cost when OpenRouter reports a positive `total_cost`, else null (an absent/
// non-positive figure is an honest no-capture — NEVER a fabricated $0). Throws on
// a non-200 so a transport/auth failure is LOUD, not a silent miss.
export async function queryGenerationCost(
  client: OpenRouterHttpClient,
  input: OpenRouterCostQueryInput,
): Promise<OpenRouterGenerationCost | null> {
  if (input.generationId === "") {
    throw new Error("openRouterCost: generationId is required");
  }
  const baseUrl = input.baseUrl ?? DEFAULT_BASE_URL;
  const response = await client.request({
    method: "GET",
    path: `/generation?id=${encodeURIComponent(input.generationId)}`,
    token: input.token,
    baseUrl,
  });
  if (response.status !== 200) {
    throw new Error(`openRouterCost: query failed (status ${response.status}) for generation ${input.generationId}`);
  }
  const totalCostUsd = extractTotalCost(response.body);
  if (totalCostUsd === null) {
    return null;
  }
  return {
    generationId: input.generationId,
    totalCostUsd,
    // BYOK: the real spend is on the upstream provider's bill, so this figure is
    // NOT the authoritative real deduction — flag it so the caller never records
    // it as `provider_response` real spend.
    upstreamBilled: input.billingModel === "byok",
  };
}

// The authoritative real-spend figure to record as `provider_response`, or null
// when none is available. A BYOK figure is DELIBERATELY null here: its
// total_cost is not the upstream bill, so it must NOT set real spend (it would
// undercount the actual charge). Only a platform-billed positive figure is the
// real deduction.
export function realProviderCostFrom(cost: OpenRouterGenerationCost | null): number | null {
  if (cost === null || cost.upstreamBilled) {
    return null;
  }
  return cost.totalCostUsd > 0 ? cost.totalCostUsd : null;
}

// Pull OpenRouter's real per-generation charge out of a `/api/v1/generation`
// body. OpenRouter wraps the row under `data`; `total_cost` is the real charge.
// Tolerant by contract: a missing/non-finite/non-positive figure → null (an
// honest no-capture, never a fabricated $0).
function extractTotalCost(body: unknown): number | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  const data = record["data"];
  const row = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : record;
  const candidate = row["total_cost"] ?? row["cost"];
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
    return null;
  }
  return candidate;
}
