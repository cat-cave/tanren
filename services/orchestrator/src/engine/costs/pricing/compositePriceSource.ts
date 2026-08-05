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

// The narrow read contract the notional path needs. `ModelPriceSource` (frozen),
// `LiveModelPriceSource` and this composite all satisfy it, so the cost path can be
// typed on the CAPABILITY rather than on one concrete class.
export interface ModelPriceLookup {
  lookup(model: string, provider?: string): ModelPrice | null;
  health(): ModelPriceSourceHealth;
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

  // The composite can answer if EITHER source can. `unavailable` therefore means
  // something much stronger than "this model is unpriced": it means no price
  // source is reachable at all, which is an infrastructure fact the reason code
  // must not blame on the model.
  health(): ModelPriceSourceHealth {
    return this.#openRouter.health() === "ready" || this.#fallback.health() === "ready" ? "ready" : "unavailable";
  }

  // Trigger both legs' background refresh. Returns immediately — see
  // `costPriceSource` for why this deliberately does not wait.
  warm(): void {
    this.#openRouter.warm?.();
    this.#fallback.warm?.();
  }

  // Health of the OpenRouter leg alone. An OpenRouter-route call whose model is
  // unpriced needs to distinguish "OpenRouter does not list it" from "we could not
  // reach OpenRouter", and only this leg can answer that — the LiteLLM leg being
  // `ready` says nothing about the marketplace.
  openRouterHealth(): ModelPriceSourceHealth {
    return this.#openRouter.health();
  }
}
