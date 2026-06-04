// Per-implementation invocations of the CostResolver conformance suite. Both
// the in-memory FakeCostResolver and the PRODUCTION resolution path
// (resolveCostSource + computeCostUsd from engine/costs/sources.ts, the
// canonical cost model the CostRecorder persists) are run through the SAME
// behavior spec.
//
// The contract's `CostResolver.resolve` keys off provider/model, but the
// production model resolves a credential AUTH-REF + CLI into a billing mode and
// a cost basis. `ProductionCostResolver` is the thin adapter that bridges them:
// it is constructed with the credential situation (authRef, cli, and the real
// ccusage dollar figure when one was reported) and maps the contract's disjoint
// token buckets into TokenUsage, then defers to the exact functions the
// CostRecorder uses. No logic is duplicated; the adapter only re-shapes I/O.
// A future resolver (e.g. a Rust impl via its test shim) gets contract coverage
// by adding one harness block here.
import type { CostResolution, CostResolutionInput, CostResolver } from "../../src/engine/contracts/costResolver.js";
import type { TokenUsage } from "../../src/engine/providers/types.js";
import { computeCostUsd, resolveCostSource, type AttributionInput } from "../../src/engine/costs/sources.js";
import { FakeCostResolver } from "../../src/engine/contracts/costResolver.js";
import { describeCostResolverConformance, type Scenario } from "./costResolverConformance.js";

interface CredentialSituation {
  authRef: string;
  cli: AttributionInput["cli"];
  ccusageCostUsd?: number | null;
  // The provider's OWN authoritative per-call charge (OpenRouter's `usage.cost`):
  // when present, the resolution is `provider_response` real spend.
  realProviderCostUsd?: number | null;
}

// Adapter over the canonical cost model. One instance = one credential
// situation (the production path resolves cost from the auth-ref + CLI + the
// real ccusage figure, none of which live on the contract input). Mapping the
// contract's CostResolutionInput token fields into TokenUsage is the only
// reshaping; pricing/attribution is delegated verbatim to sources.ts.
class ProductionCostResolver implements CostResolver {
  constructor(private readonly situation: CredentialSituation) {}

  async resolve(input: CostResolutionInput): Promise<CostResolution> {
    const tokens: TokenUsage = {
      inputTokens: input.inputTokens,
      cachedInputTokens: input.cachedInputTokens,
      cacheCreationTokens: input.cacheCreationTokens,
      outputTokens: input.outputTokens,
      reasoningOutputTokens: input.reasoningOutputTokens,
      totalTokens: input.totalTokens,
    };
    const source = resolveCostSource({
      cli: this.situation.cli,
      authRef: this.situation.authRef,
      ccusageCostUsd: this.situation.ccusageCostUsd ?? null,
      realProviderCostUsd: this.situation.realProviderCostUsd ?? null,
      rawUsage: { provider: input.provider, model: input.model },
    });
    const costUsd = computeCostUsd(source, tokens);
    return {
      costUsd,
      billingMode: source.billingMode,
      costBasis: source.costBasis,
      raw: { provider: source.provider, model: input.model },
    };
  }
}

// Token usage with a non-trivial spread across the disjoint buckets so the
// provider_pricing math (input/cache/output/reasoning rates) is actually
// exercised, not a zero-token no-op.
const PRICED_TOKENS = {
  inputTokens: 1_000_000,
  cachedInputTokens: 500_000,
  cacheCreationTokens: 100_000,
  outputTokens: 250_000,
  reasoningOutputTokens: 50_000,
  totalTokens: 1_900_000,
} as const;

function makeInput(provider: string, model: string): CostResolutionInput {
  return { provider, model, ...PRICED_TOKENS };
}

// --- FakeCostResolver -------------------------------------------------------
// The fake is honest by construction: self_hosted billing, unknown basis,
// null cost — the canonical "no reliable dollar basis" state.
describeCostResolverConformance("FakeCostResolver", {
  make: (): CostResolver => new FakeCostResolver(),
  scenarios: [
    {
      name: "fake resolver always reports honest-unknown self-hosted cost",
      input: makeInput("anything", "any-model"),
      expectBillingMode: "self_hosted",
      expectCostBasis: "unknown",
      expectNullCost: true,
    },
  ],
});

// --- ProductionCostResolver (canonical sources.ts model) --------------------
// One scenario per reachable (billing mode × cost basis) path through
// resolveCostSource + computeCostUsd. Each scenario carries the credential
// situation (authRef/cli/ccusage) inline; its (provider, model) pair is unique
// so the harness can route resolve() back to the right situation.
//
// The `credits` basis is NOT reachable from a single resolve(): it is stamped
// only by the run-level reconcile/apportion pass
// (CostRecorder.reconcileRunCostFromCredits), so it is exercised by the
// recorder's own tests, not this single-call contract.
interface ProductionScenario extends Scenario {
  readonly situation: CredentialSituation;
}

const productionScenarios: readonly ProductionScenario[] = [
  {
    // per_token API key with NO captured real-spend fact → honest-null/unknown.
    // REAL SPEND IS A FACT: there is no list-rate table to invent a figure from. A
    // BYOK anthropic key's real charge lands on the upstream invoice we cannot read.
    name: "per_token Anthropic API key with no fact is honest-null (no list-rate table)",
    input: makeInput("anthropic", "claude-sonnet"),
    situation: { authRef: "credential/anthropic/default", cli: "claude" },
    expectBillingMode: "per_token",
    expectCostBasis: "unknown",
    expectNullCost: true,
  },
  {
    // per_token OpenRouter key with NO captured generation cost → honest-null too.
    // A managed OpenRouter run that captured `usage.cost` is the separate
    // provider_response scenario below.
    name: "per_token OpenRouter key with no captured cost is honest-null",
    input: makeInput("openrouter", "deepseek-chat"),
    situation: { authRef: "credential/openrouter/default", cli: "opencode" },
    expectBillingMode: "per_token",
    expectCostBasis: "unknown",
    expectNullCost: true,
  },
  {
    // OpenRouter's OWN authoritative per-call charge (usage.cost) is the REAL
    // deduction — it OUTRANKS the static table AND ccusage and prices as
    // provider_response. The most accurate real-spend basis.
    name: "OpenRouter authoritative usage.cost prices as provider_response (real charge)",
    input: makeInput("openrouter", "deepseek-real-cost"),
    situation: { authRef: "credential/openrouter/platform/default", cli: "aider", realProviderCostUsd: 0.0421 },
    expectBillingMode: "per_token",
    expectCostBasis: "provider_response",
  },
  {
    // A real positive ccusage figure OUTRANKS the static table (PROJECT_BRIEF
    // §4): basis becomes ccusage and the dollar figure is the ccusage value.
    name: "positive ccusage figure outranks the table and prices as ccusage",
    input: makeInput("openai", "gpt-5-codex-api"),
    situation: { authRef: "credential/openai-api/default", cli: "codex", ccusageCostUsd: 1.2345 },
    expectBillingMode: "per_token",
    expectCostBasis: "ccusage",
  },
  {
    // Codex/ChatGPT subscription bundle → subscription-window dollars, no fixed
    // token denominator, so cost is honestly null with an unknown basis.
    name: "subscription Codex bundle is honest-null (subscription window)",
    input: makeInput("openai-sub", "gpt-5-codex-sub"),
    situation: { authRef: "credential/codex/pro", cli: "codex" },
    expectBillingMode: "subscription",
    expectCostBasis: "unknown",
    expectNullCost: true,
  },
  {
    // Self-hosted endpoint → no per-call dollar basis → honest-null/unknown.
    name: "self-hosted endpoint has no per-call basis (honest-null)",
    input: makeInput("self-hosted", "local-qwen"),
    situation: { authRef: "credential/self-hosted/local-qwen", cli: "opencode" },
    expectBillingMode: "self_hosted",
    expectCostBasis: "unknown",
    expectNullCost: true,
  },
  {
    // An empty/unrecognized auth-ref → unknown classification → self_hosted
    // billing, unknown basis, null cost. It NEVER throws and NEVER fabricates. An
    // UNRECOGNIZED non-empty ref is a different, LOUD case (BUDGET-SAFETY C1) —
    // it is `unattributed`, covered by costsAttribution.test.ts, not honest-null.
    name: "empty (no-credential) auth-ref degrades to honest-null self-hosted",
    input: makeInput("unknown-provider", "unknown-model"),
    situation: { authRef: "", cli: "fake" },
    expectBillingMode: "self_hosted",
    expectCostBasis: "unknown",
    expectNullCost: true,
  },
];

// Route a resolve() input back to its credential situation. The spec drives
// each scenario by its declared `input`, and every scenario's (provider, model)
// pair is unique, so the pair identifies the situation unambiguously.
function findSituation(resolveInput: CostResolutionInput): CredentialSituation {
  const match = productionScenarios.find(
    (scenario) => scenario.input.provider === resolveInput.provider && scenario.input.model === resolveInput.model,
  );
  if (match === undefined) {
    throw new Error(`no production scenario for provider=${resolveInput.provider} model=${resolveInput.model}`);
  }
  return match.situation;
}

describeCostResolverConformance("ProductionCostResolver", {
  make: (): CostResolver => ({
    resolve: async (resolveInput: CostResolutionInput): Promise<CostResolution> =>
      new ProductionCostResolver(findSituation(resolveInput)).resolve(resolveInput),
  }),
  scenarios: productionScenarios,
});
