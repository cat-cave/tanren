// The canonical CREDENTIAL-TYPE taxonomy: how a stored LLM credential delivers
// its auth to a harness. This is the third axis the credential model must keep
// separate from `provider` (the cost slug) and `cli`/harness (the runner):
//
//   provider (cost slug)  : openrouter | anthropic | openai-api | codex   → classifyAuthRef
//   harness / cli (runner): codex,claude (full-role) | opencode,aider,…  → harnessCapability
//   credential-type (HERE): how the secret is delivered to whichever harness runs it
//
// Conflating these three is exactly what made multi-provider BYOK a facade: a
// stored `credential/anthropic/…` api_key could be connected but never routed,
// because the default path assumed a Codex ChatGPT bundle. This module owns the
// credential-type vocabulary and the ref→type inference; `harnessCapability.ts`
// owns which credential-types each harness can consume.

/**
 * How a credential's secret is delivered to a harness:
 *   - `api_key`            — a raw provider API key (OpenRouter/Anthropic/OpenAI/…),
 *                            delivered via the harness's provider env var.
 *   - `codex_chatgpt_bundle` — the Codex ChatGPT `auth.json` token bundle.
 *   - `claude_cli_bundle`    — the Claude CLI `.credentials.json` token bundle.
 *   - `opencode_bundle`      — the opencode CLI auth bundle.
 */
export type CredentialType = "api_key" | "codex_chatgpt_bundle" | "claude_cli_bundle" | "opencode_bundle";

export const CREDENTIAL_TYPES: readonly CredentialType[] = [
  "api_key",
  "codex_chatgpt_bundle",
  "claude_cli_bundle",
  "opencode_bundle",
] as const;

// The `credential/<slug>/…` prefixes that map to a bundle credential-type. Every
// other recognized LLM provider slug (openrouter/anthropic/openai-api) is a raw
// `api_key`. Kept in lockstep with refNamespace.ts KIND_SLUG (the bundle slugs)
// and aiProvider.ts PROVIDER_SPECS (the api_key slugs); the conformance test
// pins both sides so a renamed slug cannot silently fall through to `api_key`.
const BUNDLE_SLUG_TYPES: Record<string, CredentialType> = {
  codex: "codex_chatgpt_bundle",
  claude: "claude_cli_bundle",
  opencode: "opencode_bundle",
};

// The api_key provider slugs (the per-token cost-classified LLM providers). A
// ref under one of these prefixes delivers a raw key, not a bundle.
const API_KEY_SLUGS: ReadonlySet<string> = new Set(["openrouter", "anthropic", "openai-api"]);

/**
 * The `credential/<slug>/…` PROVIDER SLUG of a ref (e.g. `openrouter`,
 * `anthropic`, `openai-api`, `codex`), or `null` when the ref is not a
 * `credential/<slug>/…` ref at all. This is the SINGLE place that parses the slug
 * out of a ref — `credentialTypeForRef` (the credential-type axis) and the
 * api_key delivery dispatch (which env var / config a raw key is delivered as)
 * both consult it, since for an `api_key` the bare type is too coarse: codex
 * delivers openrouter/openai-api but NOT anthropic, and claude delivers anthropic
 * but NOT openrouter/openai-api, so the matrix must gate on the slug too.
 */
export function providerSlugForRef(ref: string): string | null {
  const match = /^credential\/([^/]+)\//u.exec(ref);
  return match?.[1] ?? null;
}

/**
 * Infer the CredentialType of a stored credential from its Vault ref prefix, or
 * `null` when the ref is not an LLM credential (e.g. `credential/github/…`,
 * `credential/opaque/…`). Loud-by-omission: an unrecognized LLM-looking slug
 * returns `null` rather than defaulting to a type, so a caller that needs a
 * concrete type must fail rather than guess.
 */
export function credentialTypeForRef(ref: string): CredentialType | null {
  const slug = providerSlugForRef(ref);
  if (slug === null) {
    return null;
  }
  const bundleType = BUNDLE_SLUG_TYPES[slug];
  if (bundleType !== undefined) {
    return bundleType;
  }
  if (API_KEY_SLUGS.has(slug)) {
    return "api_key";
  }
  return null;
}
