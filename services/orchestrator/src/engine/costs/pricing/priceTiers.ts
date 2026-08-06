// PRICE TIERS — the long-context rate overrides a marketplace publishes alongside a
// model's flat rates, and the parser that refuses to trust them.
//
// Split out of `modelPriceSource.ts` to keep that file under the 500-line
// architecture cap, and because tier parsing is a self-contained concern: one
// normalized shape, one validator, no knowledge of maps, health or fetching.

// One long-context price tier — the rates that apply once a call's PROMPT tokens
// reach `minPromptTokens`. Lives here (not in the OpenRouter source) so `ModelPrice`
// can carry it without this module importing a specific source, and so any future
// source that publishes tiered rates normalizes into the same shape.
export interface PriceTier {
  minPromptTokens: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  cacheReadCostPerToken?: number;
  cacheCreationCostPerToken?: number;
}

// The per-entry key a normalized upstream row carries its tiers under. Underscore-
// prefixed so it can never collide with an upstream LiteLLM field name.
export const PRICE_TIERS_KEY = "_tanren_price_tiers";

// One tier rate: finite and non-negative, or absent. A tier that restates an axis
// with a garbage value must not hand that value to the notional arithmetic as a
// trusted price — the axis is simply not restated and the model's flat rate stands.
function tierRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

// Read the normalized long-context tiers off an upstream entry. Absent (LiteLLM) or
// malformed → an empty list, i.e. "the flat rates apply always". Never throws: a
// bad tier must degrade to flat pricing, not un-price the model.
//
// Every field is re-validated here rather than trusted. The only producer today is
// `openRouterPriceSource.parseTier`, which already validates — but this function is
// reachable from ANY injected `ModelPriceMap` (fixtures, a future source, a live
// table that carried the key), and the old `tier is PriceTier` predicate checked
// only `minPromptTokens`, asserting the rate fields into existence without looking
// at them. A NEGATIVE floor is rejected too: it matches every prompt, so a single
// bad tier would silently reprice every call on the model.
export function parseTiers(raw: unknown): readonly PriceTier[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const tiers: PriceTier[] = [];
  for (const candidate of raw) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }
    const record = candidate as Record<string, unknown>;
    const floor = record["minPromptTokens"];
    if (typeof floor !== "number" || !Number.isFinite(floor) || floor < 0) {
      continue;
    }
    const input = tierRate(record["inputCostPerToken"]);
    const output = tierRate(record["outputCostPerToken"]);
    const cacheRead = tierRate(record["cacheReadCostPerToken"]);
    const cacheCreation = tierRate(record["cacheCreationCostPerToken"]);
    // A tier that restates NO axis is not a tier — it would select over the flat
    // rates and then change nothing, which is indistinguishable from absent.
    if (input === undefined && output === undefined && cacheRead === undefined && cacheCreation === undefined) {
      continue;
    }
    tiers.push({
      minPromptTokens: floor,
      ...(input !== undefined && { inputCostPerToken: input }),
      ...(output !== undefined && { outputCostPerToken: output }),
      ...(cacheRead !== undefined && { cacheReadCostPerToken: cacheRead }),
      ...(cacheCreation !== undefined && { cacheCreationCostPerToken: cacheCreation }),
    });
  }
  return tiers.sort((left, right) => left.minPromptTokens - right.minPromptTokens);
}
