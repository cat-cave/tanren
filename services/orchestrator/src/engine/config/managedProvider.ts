import { z } from "zod";

// SaaS Tier-B #5: the BYOK-vs-managed provider seam.
//
// A run's LLM credential normally comes from the TENANT (bring-your-own-key:
// the org/project imports its own Codex/Claude/OpenRouter credential). A
// HOSTING layer may instead want to offer a platform-provided LLM — an
// OpenRouter-style shell where every tenant runs against the platform's single
// OpenRouter key and the platform meters + bills the usage. That is the
// "managed" mode.
//
// This module is ONLY the OSS-side toggle + endpoint plumbing. It exposes:
//   - `providerMode` ("byok" | "managed"), default "byok" so existing
//     deployments are untouched;
//   - the platform credential ref + endpoint the managed mode points the
//     harness at.
// WHO is allowed managed mode, the actual platform OpenRouter API key, and the
// pricing/billing are all HOSTING concerns that live outside this repo. The OSS
// only knows how to SELECT the platform credential ref (a secret-store entry the
// hosting layer provisions) and how to point an OpenAI-compatible harness at the
// managed endpoint. A self-hosted deployment that sets nothing stays BYOK.

// The two provider-credential sources a run can resolve from.
//   byok    — the tenant's own imported credential (today's behavior).
//   managed — a platform-owned credential the hosting layer provisions.
export const ProviderMode = z.enum(["byok", "managed"]);
export type ProviderMode = z.infer<typeof ProviderMode>;

// The default platform OpenRouter credential ref. This is just the secret-store
// KEY the hosting layer writes the platform OpenRouter API key under; the OSS
// never sees the key itself, only selects this ref. It is classified by the
// cost path (engine/costs/sources.ts) as `credential/openrouter/` → per_token /
// openrouter. A managed run records cost_usd as a metered FACT (`provider_response`)
// from OpenRouter's real `usage.cost` (queried per the surfaced generation id) —
// not from any list-rate table (there is none).
export const DEFAULT_MANAGED_CREDENTIAL_REF = "credential/openrouter/platform/default";

// OpenRouter's OpenAI-API-compatible base URL. The harness adapters point their
// OpenAI-compatible endpoint flag (e.g. aider `--openai-api-base`) here when
// running managed so the platform key drives an OpenRouter model.
export const DEFAULT_MANAGED_ENDPOINT = "https://openrouter.ai/api/v1";

// The managed-provider configuration block. Optional everywhere: when absent the
// managed defaults apply (so a hosting layer can flip `providerMode: "managed"`
// with zero further config and get the platform OpenRouter shell). `.strict()`
// so it round-trips untouched in JSONB with no migration.
//
//   credentialRef — the platform-owned secret-store ref the managed run resolves
//                   instead of the tenant's credential. Defaults to
//                   DEFAULT_MANAGED_CREDENTIAL_REF.
//   endpoint      — the OpenAI-compatible base URL the harness is pointed at when
//                   running managed. Defaults to DEFAULT_MANAGED_ENDPOINT.
export const ManagedProviderConfig = z
  .object({
    credentialRef: z.string().min(1).default(DEFAULT_MANAGED_CREDENTIAL_REF),
    endpoint: z.string().min(1).default(DEFAULT_MANAGED_ENDPOINT),
  })
  .strict();
export type ManagedProviderConfig = z.infer<typeof ManagedProviderConfig>;

// Produces the fully-defaulted managed-provider config (platform OpenRouter ref
// + endpoint). Used when an org selects managed mode but binds no explicit
// override block.
export function defaultManagedProviderConfig(): ManagedProviderConfig {
  return ManagedProviderConfig.parse({});
}

// The endpoint override a harness adapter applies for a run. `byok` runs resolve
// to `undefined` (no override — behavior identical to today); `managed` runs
// resolve to the managed endpoint so an OpenAI-compatible harness points at
// OpenRouter with the platform key.
export interface HarnessEndpointOverride {
  /** OpenAI-compatible base URL (e.g. aider `--openai-api-base`). */
  baseUrl: string;
}

// Resolves the harness endpoint override for a provider mode. Pure + injectable
// so adapter tests can assert the OUTCOME (override present for managed, absent
// for byok) without a live endpoint.
export function resolveHarnessEndpointOverride(
  mode: ProviderMode,
  managed?: ManagedProviderConfig,
): HarnessEndpointOverride | undefined {
  if (mode !== "managed") {
    return undefined;
  }
  return { baseUrl: (managed ?? defaultManagedProviderConfig()).endpoint };
}
