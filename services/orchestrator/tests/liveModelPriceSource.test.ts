import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LiveModelPriceSource,
  liveFetchEnabled,
  type ModelPriceFetcher,
  type ModelPriceMap,
} from "../src/engine/costs/pricing/modelPriceSource.js";

// A tiny SEED map (the offline/vendored fallback stand-in): one priced model. It
// deliberately does NOT list `gpt-5.6-luna` — a freshly-released model — so we can
// prove the LIVE fetch self-heals it without a human refresh.
const seedMap: ModelPriceMap = {
  "seed-model": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 1e-6,
    output_cost_per_token: 2e-6,
  },
};

// The LIVE upstream table: it prices the brand-new `gpt-5.6-luna`, AND re-prices
// `seed-model` at a different rate, so a live hit is distinguishable from the seed.
const liveMap: ModelPriceMap = {
  "seed-model": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 5e-6,
    output_cost_per_token: 9e-6,
  },
  "gpt-5.6-luna": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 3e-6,
    output_cost_per_token: 6e-6,
  },
};

// A second live revision (for the TTL-expiry refetch case): a further price move.
const liveMapV2: ModelPriceMap = {
  "gpt-5.6-luna": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 4e-6,
    output_cost_per_token: 8e-6,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LiveModelPriceSource — live fetch + TTL cache with vendored-seed fallback", () => {
  it("live hit → the LIVE price (a new model absent from the seed is self-healed)", async () => {
    const fetcher = vi.fn<ModelPriceFetcher>(async () => liveMap);
    const source = new LiveModelPriceSource({ seed: seedMap, fetcher, ttlMs: 1000, now: () => 0 });

    // Before the first fetch completes, a read serves the SEED synchronously
    // (the new model is not yet known → null; no await pushed onto the caller).
    expect(source.lookup("gpt-5.6-luna")).toBeNull();
    expect(source.lookup("seed-model")?.input?.costPerToken).toBe(1e-6);

    await source.ensureFresh();

    // After the live refresh, the new model is priced AND the seed price is
    // superseded by the live one.
    expect(source.lookup("gpt-5.6-luna")?.input?.costPerToken).toBe(3e-6);
    expect(source.lookup("seed-model")?.input?.costPerToken).toBe(5e-6);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fetch fails → falls back to the vendored SEED (never null for a seeded model), loud-not-fatal", async () => {
    const onRefreshError = vi.fn<(error: unknown) => void>();
    const fetcher = vi.fn<ModelPriceFetcher>(async () => {
      throw new Error("upstream 503 / offline");
    });
    const source = new LiveModelPriceSource({ seed: seedMap, fetcher, ttlMs: 1000, now: () => 0, onRefreshError });

    // ensureFresh never throws even though the fetch rejected.
    await expect(source.ensureFresh()).resolves.toBeUndefined();

    // The seeded model still prices from the fallback table.
    expect(source.lookup("seed-model")?.input?.costPerToken).toBe(1e-6);
    // The failure was surfaced (loud) but not thrown.
    expect(onRefreshError).toHaveBeenCalledTimes(1);
  });

  it("neither live NOR seed → null (LOUD-unknown preserved, never a guessed rate)", async () => {
    const fetcher = vi.fn<ModelPriceFetcher>(async () => liveMap);
    const source = new LiveModelPriceSource({ seed: seedMap, fetcher, ttlMs: 1000, now: () => 0 });
    await source.ensureFresh();

    // A model in neither table is still unpriceable.
    expect(source.lookup("model-in-no-table-at-all")).toBeNull();
  });

  it("TTL expiry → refetch (and NO refetch within the TTL window)", async () => {
    const clock = { t: 0 };
    let nextMap: ModelPriceMap = liveMap;
    const fetcher = vi.fn<ModelPriceFetcher>(async () => nextMap);
    const source = new LiveModelPriceSource({ seed: seedMap, fetcher, ttlMs: 1000, now: () => clock.t });

    await source.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(source.lookup("gpt-5.6-luna")?.input?.costPerToken).toBe(3e-6);

    // Still inside the TTL window → a read does NOT trigger a refetch.
    clock.t = 999;
    await source.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(source.lookup("gpt-5.6-luna")?.input?.costPerToken).toBe(3e-6);

    // TTL elapsed → the next read refetches and swaps in the new upstream table.
    clock.t = 1000;
    nextMap = liveMapV2;
    await source.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(source.lookup("gpt-5.6-luna")?.input?.costPerToken).toBe(4e-6);
  });

  it("a failed refresh backs off one full TTL before retrying (no per-read hammering)", async () => {
    const clock = { t: 0 };
    const fetcher = vi.fn<ModelPriceFetcher>(async () => {
      throw new Error("offline");
    });
    const source = new LiveModelPriceSource({ seed: seedMap, fetcher, ttlMs: 1000, now: () => clock.t });

    await source.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Repeated reads inside the TTL do NOT re-hit the failing upstream.
    source.lookup("seed-model");
    source.lookup("seed-model");
    await source.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Only after the TTL elapses does it retry.
    clock.t = 1000;
    await source.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Throughout the outage the seeded model keeps pricing from the fallback table.
    expect(source.lookup("seed-model")?.input?.costPerToken).toBe(1e-6);
  });

  it("an infinite TTL FREEZES the source — it never fetches (the disabled/offline posture)", async () => {
    const fetcher = vi.fn<ModelPriceFetcher>(async () => liveMap);
    const source = new LiveModelPriceSource({
      seed: seedMap,
      fetcher,
      ttlMs: Number.POSITIVE_INFINITY,
      now: () => 0,
    });

    source.lookup("seed-model");
    await source.ensureFresh();
    expect(fetcher).not.toHaveBeenCalled();
    // It behaves exactly like the frozen vendored source.
    expect(source.lookup("seed-model")?.input?.costPerToken).toBe(1e-6);
    expect(source.lookup("gpt-5.6-luna")).toBeNull();
  });

  it("a HUNG fetch does not latch out every later refresh for the process lifetime", async () => {
    // The single-flight latch is correct for a fetch that FINISHES. For one that
    // never settles it was a permanent kill: `#inFlight` stayed non-null, every
    // later stale read returned early, and the table froze for the rest of the
    // process. On the OpenRouter leg — which ships no seed by design — that means
    // every OpenRouter model records `price_source_unavailable` forever, and the
    // run-end reprice cannot recover it either. Silent, permanent, and invisible
    // because it never fails anything: `lookup` stays synchronous, so runs keep
    // going and only the accounting axis dies.
    //
    // The fix is NOT a wall-clock abort (`no-arbitrary-timeouts` forbids one, and
    // killing the socket is not what is needed). The LATCH expires on the ordinary
    // refresh cadence: once a full TTL has passed with no result, the next stale
    // read supersedes the stuck attempt. The stuck fetch is simply abandoned.
    const clock = { t: 0 };
    let hangs = 0;
    const fetcher = vi.fn<ModelPriceFetcher>(async () => {
      hangs += 1;
      // The first attempt never settles. The second returns normally.
      if (hangs === 1) return new Promise<ModelPriceMap>(() => {});
      return liveMap;
    });
    const source = new LiveModelPriceSource({ seed: seedMap, fetcher, ttlMs: 1000, now: () => clock.t });

    source.lookup("seed-model");
    expect(fetcher).toHaveBeenCalledTimes(1);
    // Within the interval the latch still holds — one stuck attempt must not become
    // a hot retry loop on every lookup.
    clock.t = 999;
    source.lookup("seed-model");
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A full interval later, the stuck attempt is superseded.
    clock.t = 1000;
    await source.ensureFresh();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(source.lookup("gpt-5.6-luna")?.input?.costPerToken).toBe(3e-6);
  });

  it("a superseded fetch that finally returns cannot overwrite the newer table", async () => {
    // Ordering, not just liveness: the abandoned attempt is holding a table that is
    // by construction OLDER than the one that replaced it.
    const clock = { t: 0 };
    let release: ((map: ModelPriceMap) => void) | undefined;
    let call = 0;
    const fetcher = vi.fn<ModelPriceFetcher>(async () => {
      call += 1;
      if (call === 1) {
        return new Promise<ModelPriceMap>((resolve) => {
          release = resolve;
        });
      }
      return liveMapV2;
    });
    const source = new LiveModelPriceSource({ seed: seedMap, fetcher, ttlMs: 1000, now: () => clock.t });

    source.lookup("seed-model");
    clock.t = 1000;
    await source.ensureFresh();
    expect(source.lookup("gpt-5.6-luna")?.input?.costPerToken).toBe(4e-6);

    // The stale attempt finally answers, with the older revision.
    release?.(liveMap);
    await Promise.resolve();
    await Promise.resolve();
    expect(source.lookup("gpt-5.6-luna")?.input?.costPerToken).toBe(4e-6);
  });

  it("reports `unavailable` for a table whose every row is unresolvable", async () => {
    // `health()` answers "can this source resolve a lookup", and a key-existence
    // check answered a different question. A table of rows that all fail
    // `parseEntry` — an upstream schema change, a truncated document — resolves
    // NOTHING, yet reported `ready`, so every null was blamed on the model.
    const unparseable = new LiveModelPriceSource({
      seed: { broken: {}, "also-broken": { litellm_provider: "openai" } },
      fetcher: vi.fn<ModelPriceFetcher>(async () => liveMap),
      ttlMs: Number.POSITIVE_INFINITY,
      now: () => 0,
    });
    expect(unparseable.health()).toBe("unavailable");
    // Non-vacuous: one resolvable row is enough.
    expect(
      new LiveModelPriceSource({
        seed: seedMap,
        fetcher: vi.fn<ModelPriceFetcher>(async () => liveMap),
        ttlMs: Number.POSITIVE_INFINITY,
        now: () => 0,
      }).health(),
    ).toBe("ready");
  });

  it("NEVER touches the network in the unit-test path (injected fetcher only; global fetch untouched)", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch");
    const fetcher = vi.fn<ModelPriceFetcher>(async () => liveMap);
    const source = new LiveModelPriceSource({ seed: seedMap, fetcher, ttlMs: 1000, now: () => 0 });

    await source.ensureFresh();
    source.lookup("gpt-5.6-luna");

    expect(globalFetch).not.toHaveBeenCalled();
    // And the prod live-fetch gate is OFF under the vitest runner, so the default
    // singleton would never fetch during `just fast-check` either.
    expect(liveFetchEnabled()).toBe(false);
  });
});
