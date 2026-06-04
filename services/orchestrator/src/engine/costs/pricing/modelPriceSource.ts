// ModelPriceSource — the REAL, MAINTAINED per-model rate source.
//
// PRINCIPLE (binding). Hindsight real spend is a metered FACT. Any COMPUTED
// figure — a notional/equivalent cost, or a forward spec/DAG estimate — must
// source its rates from a REAL, MAINTAINED source, NEVER a hardcoded table. We
// use LiteLLM's `model_prices_and_context_window.json` (the same per-model price
// data ccusage consumes: input / output / cache-read / cache-creation / batch per
// model, kept current upstream), vendored at
// `./model_prices.json` and refreshed by `scripts/refresh-model-prices.mjs`.
//
// LOUD-UNKNOWN. A model that is NOT in the source resolves to `null` — never a
// fallback guess, never a default rate. The caller MUST treat null as "unpriceable
// → record cost_usd NULL / cost_basis unknown", exactly as the cost model already
// does for subscription/self-hosted calls. There is NO hardcoded fallback here.
//
// UNITS. LiteLLM stores costs PER TOKEN (e.g. 2.5e-6 = $2.50 / 1M input tokens).
// We expose BOTH the raw per-token figure and the per-million figure so callers
// can use whichever matches their arithmetic (the existing cost model prices in
// per-million; per-token is the upstream-native value).
//
// RUNTIME LOAD. The vendored JSON is read at module load via `readFileSync` from
// `import.meta.dirname` — the same proven pattern the answerer-schema adapter uses
// — because the orchestrator build is a bare `tsc` that drops non-TS files, so the
// snapshot is copied into `dist/` by scripts/copy-orchestrator-runtime-assets.mjs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

// The vendored snapshot lives beside this module. Loaded once at import; a parse
// failure here is a LOUD build/asset error (the file is committed), never silent.
const VENDORED_FILE = resolve(import.meta.dirname, "model_prices.json");

// A single rate axis: the upstream per-token cost plus the per-million convenience
// figure (per-million = per-token × 1e6). Both are present iff upstream supplied a
// finite, non-negative number for the axis; otherwise the whole axis is null.
export interface RateAxis {
  costPerToken: number;
  costPerMillion: number;
}

// The typed per-model price. Every axis is nullable: upstream lists only the axes
// a given model actually bills (a model with no cache pricing has null cache axes).
// `input`/`output` are present for any priced chat/completion model; cache + batch
// are present only when upstream lists them.
export interface ModelPrice {
  // The model id as it appears in the source (the lookup key).
  model: string;
  // LiteLLM's `litellm_provider` for the model (e.g. "openai", "anthropic",
  // "openrouter"), or null when upstream omits it.
  provider: string | null;
  // LiteLLM's `mode` (e.g. "chat", "embedding", "image_generation"), or null.
  mode: string | null;
  // input_cost_per_token — uncached prompt tokens.
  input: RateAxis | null;
  // output_cost_per_token — completion tokens.
  output: RateAxis | null;
  // cache_read_input_token_cost — cache-READ (cache-hit) prompt tokens.
  cacheRead: RateAxis | null;
  // cache_creation_input_token_cost — cache-WRITE/creation prompt tokens
  // (Anthropic prompt-cache writes; absent for providers that do not bill it).
  cacheCreation: RateAxis | null;
  // input_cost_per_token_batches — the discounted Batch-API input rate, when listed.
  batchInput: RateAxis | null;
  // output_cost_per_token_batches — the discounted Batch-API output rate, when listed.
  batchOutput: RateAxis | null;
}

// The shape we read off each upstream entry. Everything is optional + loosely
// typed: the file mixes chat models, image models, doc/meta entries, and the
// `sample_spec` documentation key, so we validate per-field rather than assume a
// model shape. Unknown keys are ignored.
const UpstreamEntry = z
  .object({
    litellm_provider: z.string().optional(),
    mode: z.string().optional(),
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    cache_read_input_token_cost: z.number().optional(),
    cache_creation_input_token_cost: z.number().optional(),
    input_cost_per_token_batches: z.number().optional(),
    output_cost_per_token_batches: z.number().optional(),
  })
  .passthrough();

// The injectable data map: model id → raw upstream entry. Defaults to the vendored
// snapshot; a test injects a small fixture map so the source is unit-testable
// without the 1.3 MB file.
export type ModelPriceMap = Record<string, unknown>;

// Load + parse the vendored snapshot into a model map. The file is a committed
// asset, so a missing/invalid file is a LOUD failure (thrown), not a silent empty
// map — an empty map would make every model resolve to null and hide the breakage.
function loadVendoredMap(): ModelPriceMap {
  const text = readFileSync(VENDORED_FILE, "utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`modelPriceSource: vendored ${VENDORED_FILE} is not a JSON object map`);
  }
  return parsed as ModelPriceMap;
}

// Keys in the LiteLLM file that are NOT models: its own `sample_spec` doc key and
// our `_tanren_*` manifest header. Any key with a leading underscore is treated as
// metadata and skipped (defensive: future manifest keys are covered too).
function isNonModelKey(key: string): boolean {
  return key === "sample_spec" || key.startsWith("_");
}

function toRateAxis(value: unknown): RateAxis | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return { costPerToken: value, costPerMillion: value * 1_000_000 };
}

// Parse one upstream entry into a ModelPrice, or null when the entry is not a
// priceable model. An entry is priceable when it parses AND lists at least an
// input OR output per-token cost; pure-metadata / non-priced entries (e.g. an
// embedding-config row with no token cost) resolve to null (LOUD-unknown), never a
// guess.
function parseEntry(model: string, raw: unknown): ModelPrice | null {
  const parsed = UpstreamEntry.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const entry = parsed.data;
  const input = toRateAxis(entry.input_cost_per_token);
  const output = toRateAxis(entry.output_cost_per_token);
  if (input === null && output === null) {
    return null;
  }
  return {
    model,
    provider: entry.litellm_provider ?? null,
    mode: entry.mode ?? null,
    input,
    output,
    cacheRead: toRateAxis(entry.cache_read_input_token_cost),
    cacheCreation: toRateAxis(entry.cache_creation_input_token_cost),
    batchInput: toRateAxis(entry.input_cost_per_token_batches),
    batchOutput: toRateAxis(entry.output_cost_per_token_batches),
  };
}

// ModelPriceSource: a typed lookup over a maintained price map. Build it with the
// vendored snapshot (default) or an injected fixture map (tests). Lookup returns a
// typed ModelPrice or null (LOUD-unknown) — NO fallback guess.
export class ModelPriceSource {
  readonly #map: ModelPriceMap;

  // Defaults to the vendored snapshot (loaded lazily on first default construction
  // so a test that injects a fixture map never touches the 1.3 MB file). Pass an
  // explicit map to inject a fixture.
  constructor(map?: ModelPriceMap) {
    this.#map = map ?? loadVendoredMap();
  }

  // Resolve a model id to its typed price, or null when the model is not in the
  // maintained source (LOUD-unknown). Non-model keys (`sample_spec`, `_tanren_*`)
  // are never resolvable. `provider`, when given, is asserted against upstream's
  // `litellm_provider`: a mismatch is treated as not-found (null) rather than a
  // wrong-provider rate.
  lookup(model: string, provider?: string): ModelPrice | null {
    if (model === "" || isNonModelKey(model)) {
      return null;
    }
    const raw = this.#map[model];
    if (raw === undefined) {
      return null;
    }
    const price = parseEntry(model, raw);
    if (price === null) {
      return null;
    }
    if (provider !== undefined && price.provider !== null && price.provider !== provider) {
      return null;
    }
    return price;
  }

  // The set of resolvable model ids (priced models only; non-model keys excluded).
  // Useful for diagnostics / tests; not a hot path.
  models(): string[] {
    return Object.keys(this.#map).filter((key) => !isNonModelKey(key) && parseEntry(key, this.#map[key]) !== null);
  }
}

// The default source over the vendored snapshot, constructed LAZILY so merely
// importing this module (e.g. for the `ModelPrice` type, or a fixture-injecting
// test) never loads the 1.3 MB file. Production callers call `defaultModelPriceSource()`;
// tests construct `new ModelPriceSource(fixtureMap)` with a small map instead.
let cachedDefault: ModelPriceSource | undefined;
export function defaultModelPriceSource(): ModelPriceSource {
  cachedDefault ??= new ModelPriceSource();
  return cachedDefault;
}
