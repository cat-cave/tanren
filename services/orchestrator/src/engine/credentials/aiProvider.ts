// Wave-2 operator API: the "Connect AI provider" credential model.
//
// THE GAP this closes: to drive an LLM today an operator either imports an
// `opaque` credential — which `classifyAuthRef` (engine/costs/sources.ts) does
// NOT price (cost_usd stays NULL, so the budget gate can't meter it) — or has a
// platform operator hand-seed the managed OpenRouter key into Vault. Neither is
// the clean "paste my key and have it work AND be cost-tracked" route a real
// settings screen offers.
//
// The fix is purely about the REF PREFIX the secret lands under. Cost
// classification keys on the leading `credential/<slug>/` segment:
//   credential/openrouter/   → per_token / openrouter
//   credential/anthropic/    → per_token / anthropic
//   credential/openai-api/   → per_token / openai
//   credential/codex/        → subscription / openai (the ChatGPT bundle)
// So a connected BYOK key MUST be stored under the slug that matches its
// provider, and then `classifyAuthRef` prices every run that resolves it. This
// module owns that provider→slug mapping + the tenant-namespaced ref derivation,
// and is the single source of truth both the route and its cost-classification
// test consult (so the two can never drift).

import { classifyAuthRef } from "../costs/sources.js";

/** The BYOK LLM providers a user can connect over the API. */
export const AI_PROVIDERS = ["openrouter", "anthropic", "openai", "codex"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * How each provider's secret is delivered:
 *   - "api_key": a raw token (OpenRouter/Anthropic/OpenAI). Stored as the secret
 *     VALUE directly under the classifiable ref.
 *   - "auth_bundle": the Codex ChatGPT JSON auth bundle, validated + stored via
 *     the existing `storeCodexAuthBundle` import path.
 */
export type AiProviderSecretKind = "api_key" | "auth_bundle";

interface AiProviderSpec {
  /** The `credential/<slug>/...` slug — MUST be the prefix `classifyAuthRef` keys on. */
  slug: string;
  secretKind: AiProviderSecretKind;
}

// The slug for each provider is exactly the prefix `classifyAuthRef` recognizes
// (asserted at module load by `assertProviderSlugsClassify` below), so a
// connected ref is ALWAYS cost-metered. `openai` maps to the `openai-api` slug
// because that is the per-token API-key prefix (bare `credential/openai/` is NOT
// recognized); `codex` maps to the subscription ChatGPT-bundle prefix.
const PROVIDER_SPECS: Record<AiProvider, AiProviderSpec> = {
  openrouter: { slug: "openrouter", secretKind: "api_key" },
  anthropic: { slug: "anthropic", secretKind: "api_key" },
  openai: { slug: "openai-api", secretKind: "api_key" },
  codex: { slug: "codex", secretKind: "auth_bundle" },
};

export function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

export function aiProviderSecretKind(provider: AiProvider): AiProviderSecretKind {
  return PROVIDER_SPECS[provider].secretKind;
}

/** A single Vault ref path segment: letters/digits plus `._-`, never empty. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export interface DeriveAiProviderRefInput {
  provider: AiProvider;
  scope: "org" | "me";
  ownerId: string;
  /** The trailing, human-chosen segment (e.g. "default", "prod-key"). */
  name: string;
}

/**
 * Build the tenant-namespaced, COST-CLASSIFIABLE Vault ref for a connected
 * provider: `credential/<slug>/<scope>/<ownerId>/<name>`. Mirrors
 * `deriveCredentialRef` (refNamespace.ts) but keys the slug off the PROVIDER so
 * the ref prefix matches `classifyAuthRef` — that prefix match is the whole
 * point (it is what makes the key cost-metered). The `name` is the only
 * caller-influenced segment and is validated to a single safe path segment so it
 * cannot smuggle extra `/` segments out of the tenant prefix.
 */
export function deriveAiProviderRef(input: DeriveAiProviderRefInput): string {
  const slug = PROVIDER_SPECS[input.provider].slug;
  if (!SEGMENT.test(input.ownerId)) {
    throw new Error("ai-provider owner id is not a safe ref segment");
  }
  const name = input.name.trim();
  if (!SEGMENT.test(name)) {
    throw new Error("ai-provider credential name must be a single safe path segment");
  }
  return `credential/${slug}/${input.scope}/${input.ownerId}/${name}`;
}

/**
 * The human-readable `<billing_mode>/<provider>` label the connect route returns
 * so the operator KNOWS the budget gate will meter the connected key. Derived
 * from the AUTHORITATIVE classifier over the derived ref — not hard-coded — so it
 * is impossible for the returned label to disagree with how runs are actually
 * priced. A non-`per_token`/`subscription` classification (i.e. the ref does not
 * actually classify) is a hard error, never a silently-wrong label.
 */
export function classifiedAsLabel(ref: string): string {
  const classification = classifyAuthRef(ref);
  if (classification.billingMode !== "per_token" && classification.billingMode !== "subscription") {
    throw new Error(
      `connected ai-provider ref ${JSON.stringify(ref)} did not classify as a metered credential (got ${classification.billingMode}); the ref prefix must match a cost-classified provider`,
    );
  }
  return `${classification.billingMode}/${classification.provider}`;
}

/**
 * Module-load invariant: every provider slug MUST produce a ref that
 * `classifyAuthRef` recognizes as a metered (`per_token`/`subscription`)
 * credential. If a future edit renames a slug out from under the cost classifier
 * (the exact silent-budget-hole this whole module exists to prevent), the
 * service fails to boot rather than connecting un-metered keys.
 */
function assertProviderSlugsClassify(): void {
  for (const provider of AI_PROVIDERS) {
    const probe = deriveAiProviderRef({ provider, scope: "org", ownerId: "probe", name: "probe" });
    // Throws if the probe ref does not classify as metered.
    classifiedAsLabel(probe);
  }
}

assertProviderSlugsClassify();
