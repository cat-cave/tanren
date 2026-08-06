// ModelPriceSource — the REAL, MAINTAINED per-model rate source.
//
// PRINCIPLE (binding). Hindsight real spend is a metered FACT. Any COMPUTED
// figure — a notional/equivalent cost, or a forward spec/DAG estimate — must
// source its rates from a REAL, MAINTAINED source, NEVER a hardcoded table. We
// use LiteLLM's `model_prices_and_context_window.json` (the same per-model price
// data ccusage consumes: input / output / cache-read / cache-creation / batch per
// model, kept current upstream).
//
// LIVE, NOT FROZEN (self-healing). The maintained source is fetched LIVE from
// LiteLLM upstream on a short TTL (default 1h, `TANREN_MODEL_PRICE_TTL_SECONDS`),
// so a NEWLY-RELEASED model is priced automatically — no human refresh, no dead
// window where a real model resolves to `null`. See `LiveModelPriceSource`. The
// vendored `./model_prices.json` is DEMOTED to an OFFLINE SEED: it seeds the table
// at startup (pricing works before the first fetch and when upstream is down) and
// is refreshed as a committed baseline by `scripts/refresh-model-prices.mjs`. The
// plain `ModelPriceSource` below is the frozen, offline lookup over whatever map it
// is handed — the seed, or an injected fixture in tests.
//
// FALLBACK CHAIN (never a guess). live fetch → (on fetch/parse failure OR offline)
// the vendored seed / prior-live table → only then `null`. A stale-but-real vendored
// price is ALWAYS preferred over `null`; a live price over stale.
//
// LOUD-UNKNOWN. A model in NEITHER the live table NOR the vendored seed resolves to
// `null` — never a fallback guess, never a default rate. The caller MUST treat null
// as "unpriceable → cost_usd NULL / cost_basis unknown", exactly as the cost model
// already does for subscription/self-hosted calls. No hardcoded fallback here.
//
// UNITS. LiteLLM stores costs PER TOKEN (e.g. 2.5e-6 = $2.50 / 1M input tokens).
// We expose BOTH the raw per-token figure and the per-million figure so callers
// can use whichever matches their arithmetic (the existing cost model prices in
// per-million; per-token is the upstream-native value).
//
// RUNTIME LOAD. The vendored seed JSON is read at module load via `readFileSync`
// from `import.meta.dirname` — the same proven pattern the answerer-schema adapter
// uses — because the orchestrator build is a bare `tsc` that drops non-TS files, so
// the snapshot is copied into `dist/` by scripts/copy-orchestrator-runtime-assets.mjs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { createLogger } from "../../observability/logger.js";
import { PRICE_TIERS_KEY, parseTiers, type PriceTier } from "./priceTiers.js";

// The vendored SEED lives beside this module. Loaded once at import; a parse
// failure here is a LOUD build/asset error (the file is committed), never silent.
const VENDORED_FILE = resolve(import.meta.dirname, "model_prices.json");

// The LiteLLM upstream URL the live fetch (and `scripts/refresh-model-prices.mjs`)
// pulls the maintained per-model price data from. Kept in lockstep with the
// script's `SOURCE_URL` — a raw-GitHub JSON object map of models.
export const LITELLM_PRICE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Default live-refresh TTL: 1 hour. A new model shows up within this window with
// no human refresh. Overridable via `TANREN_MODEL_PRICE_TTL_SECONDS`.
const DEFAULT_TTL_SECONDS = 3600;

// Re-exported so importers keep one site for the price vocabulary (see priceTiers.ts).
export { PRICE_TIERS_KEY, type PriceTier } from "./priceTiers.js";

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
  // LONG-CONTEXT TIERS, ascending by `minPromptTokens`: a marketplace price is not
  // always a single rate (`openai/gpt-5.6-luna` doubles its prompt rate above
  // 272 000 prompt tokens). The arithmetic selects the highest tier the call's
  // prompt tokens reach; empty means the flat rates always apply. LiteLLM has no
  // equivalent, so it is always empty for that source.
  tiers: readonly PriceTier[];
}

// The shape we read off each upstream entry. Everything optional + loosely typed:
// the file mixes chat models, image models, doc/meta entries and the `sample_spec`
// key, so we validate per-field. Unknown keys pass through.
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

// Coerce parsed JSON into a model map, or throw LOUD when it is not an object map.
// Shared by the vendored-seed load and the live fetch so both reject a malformed
// document rather than degrade to an empty map (which nulls every model silently).
function coerceModelMap(parsed: unknown, whence: string): ModelPriceMap {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`modelPriceSource: ${whence} is not a JSON object map`);
  }
  return parsed as ModelPriceMap;
}

// Load + parse the vendored SEED into a model map. The file is a committed asset,
// so a missing/invalid file is a LOUD failure (thrown), not a silent empty map.
export function loadVendoredMap(): ModelPriceMap {
  const text = readFileSync(VENDORED_FILE, "utf8");
  return coerceModelMap(JSON.parse(text), `vendored ${VENDORED_FILE}`);
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
    // `UpstreamEntry` is `.passthrough()`, so the tier key survives the parse and
    // there is no need to re-read (and re-cast) the raw input.
    tiers: parseTiers(entry[PRICE_TIERS_KEY]),
  };
}

// ModelPriceSource: a typed lookup over a maintained price map. Build it with the
// vendored snapshot (default) or an injected fixture map (tests). Lookup returns a
// typed ModelPrice or null (LOUD-unknown) — NO fallback guess.
export class ModelPriceSource {
  #map: ModelPriceMap;

  // Defaults to the vendored seed (loaded lazily on first default construction
  // so a test that injects a fixture map never touches the 1.3 MB file). Pass an
  // explicit map to inject a fixture.
  constructor(map?: ModelPriceMap) {
    this.#map = map ?? loadVendoredMap();
  }

  // Swap the backing table. Used by `LiveModelPriceSource` on a successful live
  // refresh to install the fresh upstream map over the seed. The base class is
  // otherwise immutable; this is the ONE mutation point, kept `protected` so only
  // a subclass (never a caller) can re-point the table.
  protected replaceMap(map: ModelPriceMap): void {
    this.#map = map;
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

  // Can this source answer a lookup at all right now?
  //
  // This separates "OpenRouter does not list this model" from "we have not been able
  // to ASK OpenRouter". Both produce a null price; only one is a fact about the
  // model, and collapsing them makes an outage indistinguishable from a verdict.
  //
  // The base (frozen) source is `ready` whenever it has a priced row (it never
  // fetches, so it is never "warming").
  //
  // A single-table source has no routes to distinguish, so it ignores the
  // `provider` hint `ModelPriceLookup` carries for the composite.
  health(_provider?: string): ModelPriceSourceHealth {
    return this.tableIsPopulated() ? "ready" : "unavailable";
  }

  // A frozen source never fetches, so warming it is a no-op. Declared here so every
  // `ModelPriceSource` satisfies the `ModelPriceLookup` warm contract uniformly.
  warm(): void {}

  // Can the backing table RESOLVE a lookup? Not merely "has a key": a table whose
  // rows all fail `parseEntry` (upstream schema change, truncated fixture) answers
  // nothing, yet a key-existence check reported `ready` and blamed every null on
  // the model. Short-circuits, so the normal case costs one parse.
  protected tableIsPopulated(): boolean {
    return Object.keys(this.#map).some((key) => !isNonModelKey(key) && parseEntry(key, this.#map[key]) !== null);
  }

  // The set of resolvable model ids (priced models only; non-model keys excluded).
  // Diagnostics / tests; `tableIsPopulated`'s predicate without the short circuit.
  models(): string[] {
    return Object.keys(this.#map).filter((key) => !isNonModelKey(key) && parseEntry(key, this.#map[key]) !== null);
  }
}

// The default source over the vendored SEED, constructed LAZILY so merely
// importing this module (e.g. for the `ModelPrice` type, or a fixture-injecting
// test) never loads the 1.3 MB file. This is the FROZEN, offline, deterministic
// source: it NEVER fetches. It is the default parameter for the notional/recorder
// call sites (so a unit test with no injected source is deterministic + offline),
// and the source the vendored-snapshot self-test exercises. Production wires the
// LIVE source (`liveModelPriceSource()`) explicitly on the cost path instead.
let cachedDefault: ModelPriceSource | undefined;
export function defaultModelPriceSource(): ModelPriceSource {
  cachedDefault ??= new ModelPriceSource();
  return cachedDefault;
}

// Whether a price source can currently answer lookups.
//   ready       — it has a populated table (live, or a real offline seed).
//   unavailable — it has NO table: never fetched successfully and has no seed. A
//                 null lookup from an `unavailable` source says nothing about the
//                 model, only about the source.
export type ModelPriceSourceHealth = "ready" | "unavailable";

// A function that fetches + parses the maintained price map from upstream. Injected
// so tests drive a deterministic (network-free) fake; prod uses `fetchLiteLlmPriceMap`.
export type ModelPriceFetcher = () => Promise<ModelPriceMap>;

export interface LiveModelPriceSourceOptions {
  // The offline SEED / fallback table the source starts from (and falls back to on
  // a failed fetch). Defaults to the vendored snapshot. Tests pass a small map.
  seed?: ModelPriceMap;
  // The upstream fetch. On success its map REPLACES the current table; on
  // failure the current table (seed or prior-live) is kept.
  fetcher: ModelPriceFetcher;
  // Refresh interval in ms. `Number.POSITIVE_INFINITY` FREEZES the source (it
  // never becomes stale → never fetches) — the disabled/offline posture.
  ttlMs: number;
  // Clock seam (tests inject a fake clock to drive TTL expiry deterministically).
  now?: () => number;
  // Loud-but-non-fatal hook for a failed refresh. Prod logs a structured warn; a
  // refresh failure is NEVER thrown into the caller (we keep serving the fallback).
  onRefreshError?: (error: unknown) => void;
}

// LiveModelPriceSource — a live-fetching cache over the maintained upstream price
// table, with the vendored seed as the offline fallback.
//
// SEAM. It EXTENDS `ModelPriceSource`, so every caller typed on `ModelPriceSource`
// (recorder, `computeNotionalUsd`) accepts it with no signature change; `lookup`
// stays SYNCHRONOUS (the whole notional call path is sync). The live refresh runs
// as a fire-and-forget background fetch triggered lazily on a stale read: the read
// returns the CURRENT table immediately (seed, or the last successful live map),
// and a completed fetch swaps in fresh data for subsequent reads. No await is
// pushed onto callers, and a slow/hung upstream never blocks a lookup.
export class LiveModelPriceSource extends ModelPriceSource {
  readonly #fetcher: ModelPriceFetcher;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #onRefreshError: ((error: unknown) => void) | undefined;
  // The last time a refresh COMPLETED (success or failure). `-Infinity` = never
  // fetched, so the first stale-check on a finite TTL warms the table.
  #lastRefreshAt = Number.NEGATIVE_INFINITY;
  // The in-flight refresh, or null. One at a time — a second stale read while a
  // fetch is running does NOT stack a second fetch.
  #inFlight: Promise<void> | null = null;
  // When the in-flight refresh STARTED. The latch above is right for a fetch that
  // FINISHES and a permanent kill for one that never does: a hung socket leaves
  // `#inFlight` non-null forever, every later stale read returns early, and the
  // table freezes for the process lifetime — on the seedless OpenRouter leg that is
  // `price_source_unavailable` on every row, permanently, with nothing failing.
  // NOT fixed with a wall-clock abort (`no-arbitrary-timeouts`, and killing the
  // socket is not the need). The LATCH expires on the ordinary refresh cadence: one
  // full TTL with no result and the next stale read supersedes the stuck attempt.
  #inFlightStartedAt = Number.NEGATIVE_INFINITY;
  // Monotonic attempt id: only the CURRENT attempt may install a table or clear the
  // latch, so a superseded fetch that finally returns cannot overwrite newer data.
  #attempt = 0;

  constructor(options: LiveModelPriceSourceOptions) {
    super(options.seed ?? loadVendoredMap());
    this.#fetcher = options.fetcher;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? (() => Date.now());
    this.#onRefreshError = options.onRefreshError;
  }

  // Lazily kicks a background refresh when the table is stale, then serves the
  // CURRENT table synchronously (fresh-if-refreshed, else the fallback).
  override lookup(model: string, provider?: string): ModelPrice | null {
    this.#scheduleRefreshIfStale();
    return super.lookup(model, provider);
  }

  // Stale once a full TTL has elapsed since the last completed refresh. A
  // non-finite TTL FREEZES the source (never stale) — the disabled/offline mode.
  #isStale(): boolean {
    if (!Number.isFinite(this.#ttlMs)) {
      return false;
    }
    return this.#now() - this.#lastRefreshAt >= this.#ttlMs;
  }

  // May a new attempt start? Nothing running, or one running a full interval.
  #mayStartRefresh(): boolean {
    if (this.#inFlight === null) {
      return true;
    }
    return this.#now() - this.#inFlightStartedAt >= this.#ttlMs;
  }

  #scheduleRefreshIfStale(): void {
    if (!this.#isStale() || !this.#mayStartRefresh()) {
      return;
    }
    this.#attempt += 1;
    const attempt = this.#attempt;
    this.#inFlightStartedAt = this.#now();
    const running = this.#refresh(attempt).finally(() => {
      // Only the CURRENT attempt clears the latch.
      if (this.#attempt === attempt) {
        this.#inFlight = null;
      }
    });
    this.#inFlight = running;
    // Fire-and-forget: `#refresh` already swallows its own errors, but guard the
    // promise chain so a stray rejection can never surface as an unhandled one.
    running.catch(() => {});
  }

  async #refresh(attempt: number): Promise<void> {
    try {
      const map = await this.#fetcher();
      // A SUPERSEDED attempt (hung past a full interval, then replaced) must not
      // install its now-older table, nor re-stamp the clock below. It returned; it
      // just no longer speaks for this source.
      if (this.#attempt !== attempt) {
        return;
      }
      // Only a well-formed object map replaces the table; a malformed one throws
      // here and is caught below → the fallback table is kept.
      this.replaceMap(map);
    } catch (error) {
      // Fetch/parse failed OR offline → KEEP the current table (the live-or-seed
      // fallback). NEVER null it out, NEVER throw into the caller. Loud, not fatal.
      this.#onRefreshError?.(error);
    } finally {
      // Stamp the completion (success OR failure) so a persistent outage backs off a
      // full TTL between attempts. A superseded attempt does not move the clock.
      if (this.#attempt === attempt) {
        this.#lastRefreshAt = this.#now();
      }
    }
  }

  // Trigger a background refresh when the table is stale, WITHOUT waiting for it.
  // The lazy path already does this on the first lookup; calling it at run setup
  // just starts the fetch earlier, so fewer opening calls land on a cold table.
  // Returns immediately and never throws — `#refresh` owns its own errors.
  override warm(): void {
    this.#scheduleRefreshIfStale();
  }

  // Await any needed refresh, for a deterministic test assertion or an optional
  // eager warm at bootstrap. Never throws (the refresh handles its own errors).
  async ensureFresh(): Promise<void> {
    this.#scheduleRefreshIfStale();
    if (this.#inFlight !== null) {
      await this.#inFlight;
    }
  }
}

// The prod fetcher: pull the maintained map from LiteLLM upstream over the global
// `fetch`. A non-2xx or a non-object body throws (caught by the refresh → seed
// fallback).
async function fetchLiteLlmPriceMap(): Promise<ModelPriceMap> {
  const response = await fetch(LITELLM_PRICE_URL);
  if (!response.ok) {
    throw new Error(`modelPriceSource: live fetch failed (status ${response.status}) for ${LITELLM_PRICE_URL}`);
  }
  const parsed: unknown = await response.json();
  return coerceModelMap(parsed, `live ${LITELLM_PRICE_URL}`);
}

// Is the live fetch enabled? OFF under the unit-test runner (vitest sets `VITEST`)
// and `NODE_ENV=test`, so `just fast-check` is fully offline + deterministic. An
// explicit `TANREN_MODEL_PRICE_LIVE=0` is an operator kill switch (freeze to the
// vendored seed). Otherwise ON (prod self-heals).
export function liveFetchEnabled(): boolean {
  if (process.env["VITEST"] !== undefined) {
    return false;
  }
  if (process.env["NODE_ENV"] === "test") {
    return false;
  }
  if (process.env["TANREN_MODEL_PRICE_LIVE"] === "0") {
    return false;
  }
  return true;
}

// The refresh TTL in ms from `TANREN_MODEL_PRICE_TTL_SECONDS` (default 1h). A
// missing/blank/non-positive value falls back to the default rather than freezing.
// Exported so every live price source (LiteLLM, OpenRouter) shares one TTL policy.
export function ttlMsFromEnv(): number {
  const raw = process.env["TANREN_MODEL_PRICE_TTL_SECONDS"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_TTL_SECONDS * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return DEFAULT_TTL_SECONDS * 1000;
  }
  return seconds * 1000;
}

// The production LIVE source, constructed LAZILY as a process-wide singleton so the
// in-memory cache + its TTL are shared across every cost call. When the live fetch
// is disabled (tests / kill switch) the TTL is infinite → it FREEZES to the
// vendored seed and never touches the network — byte-identical to the frozen
// default source. Prod cost wiring passes THIS to `CostRecorder`.
let cachedLive: LiveModelPriceSource | undefined;
export function liveModelPriceSource(): LiveModelPriceSource {
  if (cachedLive === undefined) {
    const enabled = liveFetchEnabled();
    const logger = createLogger("costs.modelPrice");
    cachedLive = new LiveModelPriceSource({
      fetcher: fetchLiteLlmPriceMap,
      ttlMs: enabled ? ttlMsFromEnv() : Number.POSITIVE_INFINITY,
      onRefreshError: (error) => {
        logger.warn("live model-price refresh failed; serving vendored/prior-live fallback", {}, error);
      },
    });
  }
  return cachedLive;
}
