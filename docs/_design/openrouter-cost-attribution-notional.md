<!-- cspell:ignore Twnkf -->

# The notional cost axis: live OpenRouter pricing, and why every null now says why

Status: design + implementation (XHE-931).
Scope: `services/orchestrator/src/engine/costs/pricing/**`, `costs/notional.ts`,
`costs/recorder.ts`, `engine/observability/timed*Adapter.ts`.

Companion to [`openrouter-cost-attribution.md`](./openrouter-cost-attribution.md),
which covers the REAL metered axis and why it is blocked upstream. This document
also **corrects that document's §6**, which claimed the notional axis had been
recovered when it had not.

Tanren records two dollar figures per call:

- **real spend** (`cost_records.cost_usd`) — a METERED FACT or NULL. There is no
  list-rate table behind it, by design.
- **notional value** (`notional_cost_usd`) — the COMPUTED value of the call's
  tokens at the model's list price, for every billing mode.

The owner's requirement, in his words: _"There should not be a static price
catalog… all pricing is MANDATORY to be up to date, live. OpenRouter has live
pricing, in the response. Cost can NEVER be allowed to be null if we're using
OpenRouter."_ And on why there are two figures at all: _"It's belt and suspenders.
We should know in advance the rough pricing (after all, OpenRouter is a
marketplace), and then in hindsight know the true specific price and providers."_

Measured on a live run — a BYOK OpenRouter deployment whose org config pins
`defaultLlm.model = "openai/gpt-5.6-luna"`:

```json
{
  "cli": "codex",
  "model": "",
  "provider": "openrouter",
  "costUsd": null,
  "notionalCostUsd": null,
  "costBasis": "unknown",
  "billingMode": "per_token"
}
```

46 rows, 46 null costs, 100% unattributed against a ≤5% criterion. **Both halves
were dead** — including the notional half, which is the one that is supposed to
still work when metering cannot.

Four things are established below: the metered half is genuinely blocked upstream
(§1, re-verified structurally); the model id was destroyed in transit (§2); the
price source could not have priced it anyway (§3); and every remaining null now
carries a reason (§4).

## 1. Why the metered half is still unreachable — re-verified, harder

Earlier work established this behaviourally: a live `codex exec --json` capture plus
a MITM read of OpenRouter's wire showed codex _did not_ emit the generation id on one
run. Re-verified here **structurally**, against the shipped binary
(`codex-cli 0.145.0`, `@openai/codex-darwin-arm64`), which is a stronger claim and
costs nothing to reproduce:

```console
$ strings -a .../bin/codex | grep -o -E ".{140}turn\.completed.{140}"
…input_tokens cached_input_tokens cache_write_input_tokens output_tokens
reasoning_output_tokens … id type thread.started turn.started turn.completed
turn.failed item.started item.updated item.completed …
```

Two facts fall out of the serde string tables:

1. **The exec-JSON event vocabulary is closed and complete**: `thread.started`,
   `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.updated`,
   `item.completed`. There is no raw/passthrough variant.
2. **`TokenUsage` has no cost field.** Its members are exactly `input_tokens`,
   `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`,
   `reasoning_output_tokens`, `total_tokens`. A grep for any `cost` key in codex's
   OTEL namespace (`codex.turn.token_usage.*`) or serde tables returns **nothing**.

So codex does not merely decline to print OpenRouter's `usage.cost` — **the type it
deserializes usage into cannot hold it.** No flag, no env var, and no config can
surface a field the struct does not have. The route stays correctly classified as one that cannot produce a per-call
real-spend fact.

**One new lead, reported as a lead and not a solution.** The binary does contain
`last_model_response_id`, emitted as a `tracing` event field at
`core/src/client.rs:2005` (alongside `last_model_request_id` at :1967) — used
internally for websocket incremental-request reuse ("incremental request failed, no
previous response id"). On the Responses API that value _is_ the provider's
`response.id`, which on OpenRouter is the `gen-…` id tanren needs.

It is **not** exposed as an exec-JSON event or an OTEL attribute — only as a
diagnostic log line. Scraping it would mean depending on `RUST_LOG`, a log format
with no compatibility contract, and an internal field name, then correlating lines
to calls. I could not verify it end-to-end here (it needs a live codex call, and
this box is running a bench job), and I am not shipping an unverified log-scrape
into the column reserved for metered facts. Recorded in §9 as a follow-up to
evaluate _if_ upstream declines — ranked below the shim, because the shim at least
has a contract.

**Verdict, unchanged and now better evidenced: the metered half is an upstream
constraint. Nothing in this PR pretends otherwise.**

## 2. Where the model was lost: the observability decorators

`createCodexWriter` sets `model: recordedCodexModel(deps)` correctly
(`providers/codex.ts:92`, `:195`). Eight cost call sites read `adapter.model ?? ""`.
Every one of them read `""`.

`adapterSelector` never returns a bare adapter. Every writer and answerer is wrapped:

```ts
// observability/timedWriterAdapter.ts — BEFORE
return {
  kind: inner.kind,
  cli: inner.cli,
  authRef: inner.authRef,
  runWriter: (opts) => timed(…),
};
```

The decorator **rebuilds the adapter as a fresh object literal**, so any field it
forgets to copy does not exist as far as production is concerned. It forgot `model`.
`timedAnswererAdapter` has the same shape — and had already been patched once to
forward `lastTokenUsage`, which is the same bug found and fixed for a different field
without generalizing.

This is a whole-class hazard, not a typo: a copying decorator silently drops every
future field too. The fix forwards `model` (spread-conditionally, so an adapter that
genuinely declares none keeps the property _absent_ rather than gaining an explicit
`undefined`), and `tests/adapterModelPropagation.test.ts` pins the seam in both
directions.

**Why no test caught it.** The decorator's unit tests asserted only timing. The codex
adapter's unit tests built the adapter _directly_. The seam between them — the only
seam production uses — was untested from both sides. The change that introduced `WriterAdapter.model` was verified at
`createCodexWriter` and at the recorder, and never through the composition.

### 2b. A second, independent model defect (named, not fixed here)

`resolveCredentials.ts:298-303` hardcodes `model: "default"` for `providerMode ===
"managed"`, ignoring the org's configured `defaultLlm`. `resolveCodexOpenRouterModel`
only substitutes when the model is `undefined`, so managed runs pin the literal
string `"default"` into `config.toml` **and** into `cost_records.model`.

Out of scope here (this deployment is BYOK, where the org's real id does reach the
adapter). It is no longer silent: `"default"` is not a model any price source lists,
so it now records `notionalReason: "model_not_listed"` and fires
`cost.notional_unpriced` naming the id — which is exactly how an operator should
find it.

## 3. Why a real model id still would not have priced anything

Fixing §11 alone recovers nothing, because the price source cannot price the id.

`pricing/modelPriceSource.ts` sources rates from LiteLLM's
`model_prices_and_context_window.json`, live-fetched on a TTL with a vendored
snapshot as an offline seed. For an OpenRouter route it is the wrong source twice
over:

1. **Wrong key space.** Tanren records the id it sends OpenRouter,
   `openai/gpt-5.6-luna`. LiteLLM keys OpenRouter routes as
   `openrouter/<vendor>/<model>` and carries ~95 of them. Measured against the
   vendored table: 2 749 keys, and **no key matching `luna` at all**. The lookup
   misses by construction.
2. **Wrong authority.** OpenRouter is a marketplace. It sets the price tanren is
   charged, publishes it live, and changes it without telling LiteLLM.

Measured 2026-08-04, `GET https://openrouter.ai/api/v1/models` (public, **no
credential**), 338 models:

```json
{
  "id": "openai/gpt-5.6-luna",
  "pricing": {
    "prompt": "0.0000001",
    "completion": "0.0000006",
    "input_cache_read": "0.00000001",
    "input_cache_write": "0.000000125",
    "overrides": [
      {
        "min_prompt_tokens": 272000,
        "prompt": "0.0000002",
        "completion": "0.0000009",
        "input_cache_read": "0.00000002",
        "input_cache_write": "0.00000025"
      }
    ]
  }
}
```

The seller quotes its own price, live, for the exact id tanren sends.

### 3.1 What is implemented

**`pricing/openRouterPriceSource.ts`** — a live source over `/api/v1/models`,
normalizing into the same upstream-entry shape `parseEntry` already understands, so
it reuses `LiveModelPriceSource` wholesale (TTL cache, single-flight refresh,
synchronous non-blocking `lookup`, fire-and-forget background fetch).

- **No vendored seed, deliberately.** The LiteLLM source ships a 1.3 MB committed
  snapshot as an offline fallback. This one ships nothing: there is deliberately
  nothing to go stale. A committed snapshot of a marketplace's prices is precisely
  the static catalog the requirement forbids.
- **`"-1"` is refused, not coerced.** OpenRouter prices its auto-routers
  (`openrouter/auto-beta`, `openrouter/fusion`) at `"-1"` — a sentinel for "depends
  which model the router picks". Parsing it as a rate would invent a _negative_ cost
  and corrupt any sum over the column. Rejected → the model is unpriceable, which is
  the truth.
- **Long-context tiers are honored.** 44 of 338 models carry `overrides`. Ignoring
  them under-states cost roughly 2× on exactly the long-context calls an agent
  harness makes most. Tier selection compares against **all three prompt buckets**,
  not `inputTokens` alone — a 200k-uncached + 100k-cached call is a 300k-prompt call.
  Tier rates override the flat rate **per axis**, since overrides commonly restate
  prompt+completion but not the cache axes.
- **No credential.** `/api/v1/models` is public. This path never reads, holds, or
  transmits the OpenRouter API key, and a test asserts no auth header is sent.

**`pricing/compositePriceSource.ts`** — OpenRouter first, LiteLLM behind it. Not
gated on a caller-declared provider flag but on _whether the marketplace lists the
id_: when both have it the seller wins, when OpenRouter does not sell it (a
direct-vendor route) it falls through. The caller's provider assertion is passed to
LiteLLM but **not** to the OpenRouter leg, whose rows are all stamped `openrouter` —
asserting a caller's `"openai"` against it would reject the very row wanted.

**Failure is bounded and loud, never silent and never blocking.** A failed fetch
keeps the prior table and logs; it never throws into a cost call. A cold start is warmed at
run setup (`warmCostPriceSource`), which **triggers** the background refresh and
returns immediately — it does NOT wait. Awaiting a bounded warm was the obvious
design and is forbidden: `no-arbitrary-timeouts` bans wall-clock deadlines and there
is no progress signal to build a sign-of-life primitive from for a single HTTP GET.
Fire-and-forget is better regardless — an unreachable price API can then never delay,
hang or fail a run. Rows that land before the table does record
`price_source_unavailable` — an infrastructure fault, explicitly _not_ a fact about
the model, and repriceable later.

## 4. Making null loud: a reason on every row

The alarm was guarded by `context.model !== ""` — so the 100%-of-production case
(a real, token-bearing call with no model id) recorded NULL and **emitted nothing**.
The escape hatch added for fake fixtures was silencing the one state most worth
alarming on.

`computeNotionalUsd` now returns `{usd, reason}` over a closed enum, recorded to
`cost_source_raw.notionalReason` and stamped on **every** `cost.resolved`:

| reason                     | meaning                                           | loud |
| -------------------------- | ------------------------------------------------- | ---- |
| `priced`                   | list price × tokens                               | no   |
| `ccusage`                  | the CLI's own figure, which outranks a list rate  | no   |
| `model_id_absent`          | a real call with no model id — a TANREN DEFECT    | yes  |
| `model_not_listed`         | sources reachable; no one lists this id           | yes  |
| `price_source_unavailable` | no source reachable — INFRASTRUCTURE, repriceable | yes  |
| `unattributed_credential`  | unrecognized ref (already narrated)               | no   |
| `no_tokens`                | legitimately empty                                | no   |

"Why is this null" becomes `cost_source_raw->>'notionalReason'`, a SQL query rather
than an investigation. The three that mean _a gap an operator can act on_ fire
`cost.notional_unpriced` with a machine-readable `reasonCode` and prose naming that
gap's own remedy. `no_tokens` and `unattributed_credential` stay quiet, so the alarm
keeps its precision.

`notionalReasonIsLoud` is a **type predicate**, so the event's closed `reasonCode`
enum is a compile-time guarantee: adding a reason without deciding whether it is loud
is a type error at the emission site, not a runtime schema rejection that would drop
the very event explaining the null.

The `no_tokens` branch is judged on the **five billable buckets**, not on
`totalTokens` — which is an independent provider-reported field that can contradict
them. A provider reporting `total_tokens: 0` alongside real buckets would otherwise
short-circuit a billable call into a silent `no_tokens`, reintroducing the exact
failure being removed. (Found by mutation-adjacent review: four existing tests were
passing impossible fixtures whose `totalTokens` was 0 while buckets were not, invisible
until a branch read the field.)

## 5. What remains unattributable, restated

1. **Real metered `cost_usd` on any codex route is still NULL.** Upstream constraint,
   now proven at the level of codex's type definitions (§1). Unchanged by this PR.
2. **A budgeted codex→OpenRouter project still cannot run** and is still refused at
   setup. Notional is not spend and must never be summed by the budget gate.
3. **Non-codex adapters still declare no `model`** (claude, opencode, aider, pi,
   reasonix set it on their exec path but not on the adapter object), so their rows
   record `model_id_absent`. Now loud and enumerable per cli rather than invisible —
   deliberately named rather than half-fixed.
4. **Managed mode's `"default"` pseudo-id** (§2b) — named, loud, not fixed here.
5. **A model OpenRouter genuinely does not list** stays `model_not_listed`. That is a
   fact, not a gap.

What this PR _does_ recover: the notional axis, on the route this deployment actually
runs, from the seller's own live quote — which is the number the owner asked to have
"in advance", and the only number available at all while the metered half is upstream.
