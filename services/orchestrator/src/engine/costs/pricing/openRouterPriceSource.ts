// OpenRouterPriceSource — LIVE per-model list pricing, from OpenRouter itself.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A CATALOG.
// The notional axis prices tokens at the model's LIST rate. Until now the only
// rate source was LiteLLM's `model_prices_and_context_window.json`
// (`modelPriceSource.ts`). That is the wrong source for an OpenRouter route, for
// two independent reasons:
//
//   1. WRONG KEY SPACE. Tanren records the id it actually sends OpenRouter —
//      `openai/gpt-5.6-luna`. LiteLLM keys OpenRouter routes as
//      `openrouter/<vendor>/<model>` and carries only ~95 of them. The id tanren
//      records is not a key in that file, so the lookup misses by construction.
//   2. WRONG AUTHORITY. OpenRouter is a MARKETPLACE. It sets the price tanren is
//      actually charged, it publishes that price live, and it changes it without
//      telling LiteLLM. A third-party mirror of a marketplace's prices is a
//      snapshot of someone else's snapshot.
//
// Measured, 2026-08-04: `GET https://openrouter.ai/api/v1/models` lists 338 models
// including `openai/gpt-5.6-luna` with full pricing. The LiteLLM table has NO entry
// matching it (no `luna` key at all). So on the route this codebase actually runs,
// the LiteLLM source can only ever return null.
//
// NO STATIC CATALOG. Unlike the LiteLLM source, this one ships NO vendored seed.
// There is deliberately nothing to go stale: the table is empty until the first
// live fetch succeeds, and an empty table resolves to null WITH A REASON
// (`price_source_unavailable`), never a guessed rate and never a silent null. A
// committed snapshot of a marketplace's prices would be exactly the thing the
// design forbids.
//
// NON-BLOCKING. It reuses `LiveModelPriceSource`, so `lookup` stays synchronous
// and a refresh is a fire-and-forget background fetch. A slow or down OpenRouter
// never blocks a run — it degrades the NOTIONAL axis and says so. Callers that
// want the table warm before the first priced call (run setup) `await ensureFresh()`.
//
// PUBLIC ENDPOINT. `/api/v1/models` needs NO credential. This module never reads,
// holds, or transmits the OpenRouter API key.

import { createLogger } from "../../observability/logger.js";
import {
  LiveModelPriceSource,
  type ModelPriceMap,
  type ModelPriceSourceHealth,
  PRICE_TIERS_KEY,
  type PriceTier,
  ttlMsFromEnv,
} from "./modelPriceSource.js";

// OpenRouter's public model catalogue. No auth header, no key, no tenant scope.
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// The provider slug tanren classifies an OpenRouter credential as, and the value
// stamped on every normalized entry so `ModelPriceSource.lookup`'s provider
// assertion matches instead of rejecting the row.
export const OPENROUTER_PROVIDER = "openrouter";

// OpenRouter publishes prices as PER-TOKEN DECIMAL STRINGS ("0.0000001"), the same
// unit LiteLLM uses as a number. Parse strictly: a non-numeric, non-finite or
// NEGATIVE value is NOT a price and must not become one.
//
// Negative is not hypothetical. OpenRouter lists its auto-routers
// (`openrouter/auto-beta`, `openrouter/fusion`) at `"-1"` — a sentinel meaning
// "priced by whichever model the router picks", i.e. genuinely unknown in advance.
// Coercing `-1` into a rate would invent a negative cost. Rejecting it makes the
// model unpriceable, which is the truth.
function parseRate(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parseTier(raw: unknown): PriceTier | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const floor = record["min_prompt_tokens"];
  // A tier with no numeric floor cannot be selected against a token count, so it
  // is dropped rather than applied unconditionally.
  if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0) {
    return null;
  }
  const input = parseRate(record["prompt"]);
  const output = parseRate(record["completion"]);
  const cacheRead = parseRate(record["input_cache_read"]);
  const cacheCreation = parseRate(record["input_cache_write"]);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheCreation === undefined) {
    return null;
  }
  return {
    minPromptTokens: floor,
    ...(input !== undefined && { inputCostPerToken: input }),
    ...(output !== undefined && { outputCostPerToken: output }),
    ...(cacheRead !== undefined && { cacheReadCostPerToken: cacheRead }),
    ...(cacheCreation !== undefined && { cacheCreationCostPerToken: cacheCreation }),
  };
}

// Normalize OpenRouter's `/models` body into the SAME upstream-entry shape
// `modelPriceSource.parseEntry` already understands (`input_cost_per_token`,
// `output_cost_per_token`, `cache_read_input_token_cost`,
// `cache_creation_input_token_cost`, `litellm_provider`, `mode`), plus the tier
// extension. Reusing that shape is what lets this source drop into the existing
// `LiveModelPriceSource` / `ModelPrice` machinery with no parallel type hierarchy.
//
// LOUD on a malformed document: a body that is not `{data: [...]}` THROWS, so the
// refresh treats it as a failed fetch and keeps the previous table, rather than
// silently installing an empty one (which would null every model at once).
export function normalizeOpenRouterModels(payload: unknown): ModelPriceMap {
  if (typeof payload !== "object" || payload === null) {
    throw new TypeError("openRouterPriceSource: /models body is not a JSON object");
  }
  const data = (payload as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) {
    throw new TypeError("openRouterPriceSource: /models body has no `data` array");
  }
  const map: ModelPriceMap = {};
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const pricing = record["pricing"];
    if (typeof id !== "string" || id === "" || typeof pricing !== "object" || pricing === null) {
      continue;
    }
    const rates = pricing as Record<string, unknown>;
    const input = parseRate(rates["prompt"]);
    const output = parseRate(rates["completion"]);
    // No usable input OR output rate → not a priceable model (the `-1` auto-router
    // sentinel lands here). Omitted entirely so `lookup` returns null-with-reason.
    if (input === undefined && output === undefined) {
      continue;
    }
    const cacheRead = parseRate(rates["input_cache_read"]);
    const cacheCreation = parseRate(rates["input_cache_write"]);
    const rawTiers = rates["overrides"];
    const tiers = Array.isArray(rawTiers)
      ? rawTiers
          .map((override) => parseTier(override))
          .filter((tier): tier is PriceTier => tier !== null)
          // Ascending by floor so tier selection can scan for the last match.
          .sort((left, right) => left.minPromptTokens - right.minPromptTokens)
      : [];
    map[id] = {
      litellm_provider: OPENROUTER_PROVIDER,
      mode: "chat",
      ...(input !== undefined && { input_cost_per_token: input }),
      ...(output !== undefined && { output_cost_per_token: output }),
      ...(cacheRead !== undefined && { cache_read_input_token_cost: cacheRead }),
      ...(cacheCreation !== undefined && { cache_creation_input_token_cost: cacheCreation }),
      ...(tiers.length > 0 && { [PRICE_TIERS_KEY]: tiers }),
    };
  }
  return map;
}

// The prod fetcher. A non-2xx or a body that does not normalize THROWS — caught by
// `LiveModelPriceSource#refresh`, which keeps the prior table and reports the
// failure through `onRefreshError`. Never throws into a cost call.
export async function fetchOpenRouterPriceMap(fetchImpl: typeof fetch = fetch): Promise<ModelPriceMap> {
  const response = await fetchImpl(OPENROUTER_MODELS_URL, {
    // Identify ourselves; OpenRouter asks callers to. No credential is sent.
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `openRouterPriceSource: live fetch failed (status ${response.status}) for ${OPENROUTER_MODELS_URL}`,
    );
  }
  const parsed: unknown = await response.json();
  const map = normalizeOpenRouterModels(parsed);
  // An empty table from a 200 is upstream drift (a schema change), not a valid
  // "OpenRouter sells nothing". Throw so the prior table is kept and the operator
  // sees a refresh failure instead of every model silently going unpriced.
  if (Object.keys(map).length === 0) {
    throw new Error(`openRouterPriceSource: ${OPENROUTER_MODELS_URL} returned no priceable models`);
  }
  return map;
}

// Is the live fetch enabled? Mirrors `modelPriceSource.liveFetchEnabled` — OFF under
// vitest / NODE_ENV=test so unit runs are offline and deterministic, and an operator
// kill switch. There is NO vendored fallback here, so disabling it means the
// OpenRouter notional axis reports `price_source_unavailable` rather than a stale
// price — which is the honest posture for a source whose whole point is liveness.
export function openRouterLiveFetchEnabled(): boolean {
  if (process.env["VITEST"] !== undefined) {
    return false;
  }
  if (process.env["NODE_ENV"] === "test") {
    return false;
  }
  if (process.env["TANREN_OPENROUTER_PRICE_LIVE"] === "0") {
    return false;
  }
  return true;
}

// The process-wide singleton, so the TTL cache is shared across every cost call
// in the process rather than re-fetched per run.
let cached: LiveModelPriceSource | undefined;

export function openRouterPriceSource(): LiveModelPriceSource {
  if (cached === undefined) {
    const enabled = openRouterLiveFetchEnabled();
    const logger = createLogger("costs.openRouterPrice");
    cached = new LiveModelPriceSource({
      // NO vendored seed, by design (see the header). The table starts EMPTY and is
      // only ever populated by a successful live fetch.
      seed: {},
      fetcher: async () => fetchOpenRouterPriceMap(),
      ttlMs: enabled ? ttlMsFromEnv() : Number.POSITIVE_INFINITY,
      onRefreshError: (error) => {
        logger.warn(
          "live OpenRouter price refresh failed; notional cost for OpenRouter models will report price_source_unavailable until it succeeds",
          { url: OPENROUTER_MODELS_URL },
          error,
        );
      },
    });
  }
  return cached;
}

// Re-exported for the composite source's health reporting.
export type { ModelPriceSourceHealth };
