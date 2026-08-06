// CompositeModelPriceSource — route each model id to the source that actually
// knows its price, and report WHY when none does.
//
// Two live sources now exist and they are not interchangeable:
//
//   - `openRouterPriceSource()` — OpenRouter's own `/api/v1/models`, keyed by the
//     marketplace id tanren actually sends (`openai/gpt-5.6-luna`). AUTHORITATIVE
//     for an OpenRouter route: it is the seller quoting its own list price.
//   - `liveModelPriceSource()` — LiteLLM, keyed by that project's own id space.
//     Covers the direct-vendor routes (a bare `gpt-5.6-luna` on a native OpenAI
//     key, an Anthropic key, …) that OpenRouter does not sell and so does not list.
//
// PRECEDENCE. OpenRouter first, LiteLLM second — for every lookup, not just ones
// tagged `openrouter`. That is deliberate: when both list a model, the marketplace
// tanren is billed by is the better authority than a third-party mirror, and when
// OpenRouter does not list it (a direct-vendor route) the lookup simply falls
// through. Precedence by data, not by a caller-declared provider flag — the same
// correction §4.4 made to the upstream-billed decision.
//
// PROVIDER ASSERTION. `lookup(model, provider)` is passed through unchanged to
// LiteLLM, but NOT to the OpenRouter source: every OpenRouter row is stamped
// `litellm_provider: "openrouter"`, so asserting a caller-supplied provider like
// `"openai"` against it would reject the very row we want. OpenRouter's key space
// is already provider-qualified (`openai/…`, `anthropic/…`) — the id IS the
// assertion.

import type { ModelPrice, ModelPriceSourceHealth } from "./modelPriceSource.js";
import { OPENROUTER_PROVIDER } from "./openRouterPriceSource.js";

// The narrow read contract the notional path needs. `ModelPriceSource` (frozen),
// `LiveModelPriceSource` and this composite all satisfy it, so the cost path can be
// typed on the CAPABILITY rather than on one concrete class.
export interface ModelPriceLookup {
  lookup(model: string, provider?: string): ModelPrice | null;
  // ROUTE-AWARE, and it has to be. Over a multi-leg source "can a price source
  // answer at all" is not one question: only the leg that is AUTHORITATIVE for the
  // route can say whether a null means "not listed" or "not asked". Callers pass
  // the SAME provider hint they passed to `lookup`. A single-table source ignores
  // it.
  health(provider?: string): ModelPriceSourceHealth;
  // Trigger a background refresh if the table is stale. Never waits, never throws.
  // A frozen/offline source implements it as a no-op.
  warm?(): void;
}

export class CompositeModelPriceSource implements ModelPriceLookup {
  readonly #openRouter: ModelPriceLookup;
  readonly #fallback: ModelPriceLookup;

  constructor(openRouter: ModelPriceLookup, fallback: ModelPriceLookup) {
    this.#openRouter = openRouter;
    this.#fallback = fallback;
  }

  lookup(model: string, provider?: string): ModelPrice | null {
    // The marketplace's own quote wins when it has one. No provider assertion —
    // see the header.
    const marketplace = this.#openRouter.lookup(model);
    if (marketplace !== null) {
      return marketplace;
    }
    return this.#fallback.lookup(model, provider);
  }

  // Health for THIS ROUTE, not for the union.
  //
  // The OR was a real bug, and it defeated the entire point of splitting
  // `price_source_unavailable` from `model_not_listed`. The LiteLLM leg is seeded
  // from the vendored 1.3 MB snapshot, so it is `ready` from the first millisecond
  // of the process and can NEVER be `unavailable`. Under an OR, therefore, the
  // composite reported `ready` unconditionally — so an OpenRouter-route call made
  // before the first `/api/v1/models` fetch landed (every call in a cold process,
  // which `costPriceSource` explicitly does not wait for) was recorded as
  // `model_not_listed`: an outage wearing a verdict's clothing, and not repriceable
  // by intent.
  //
  // An OpenRouter route is answerable only by the marketplace leg — the LiteLLM
  // table does not carry the marketplace key space at all, which is reason 1 this
  // source exists. So its health IS the OpenRouter leg's health. Every other route
  // is answerable by either leg, and keeps the union.
  health(provider?: string): ModelPriceSourceHealth {
    if (provider === OPENROUTER_PROVIDER) {
      return this.#openRouter.health();
    }
    return this.#openRouter.health() === "ready" || this.#fallback.health() === "ready" ? "ready" : "unavailable";
  }

  // Trigger both legs' background refresh. Returns immediately — see
  // `costPriceSource` for why this deliberately does not wait.
  warm(): void {
    this.#openRouter.warm?.();
    this.#fallback.warm?.();
  }
}
