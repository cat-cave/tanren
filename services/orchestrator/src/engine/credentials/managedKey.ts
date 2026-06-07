import type { SecretStore } from "../contracts/secretStore.js";
import { validateCredentialRef } from "./codexAuth.js";

// The shared RAW-PROVIDER-KEY resolver every CLI materializer uses for a plain
// API-key credential (as opposed to a per-CLI auth bundle). Two callers:
//   - MANAGED mode (SaaS Tier-B #5): a PLATFORM-owned OpenRouter key
//     (`credential/openrouter/platform/…`) every tenant routes THROUGH OpenRouter
//     with, per OpenRouter's coding-agent cookbooks.
//   - BYOK api_key (the credential-redesign widening): the TENANT's own raw
//     provider key — OpenRouter (`credential/openrouter/…`), Anthropic
//     (`credential/anthropic/…`), or OpenAI (`credential/openai-api/…`) — placed
//     into that CLI's provider env var.
//
// Either way the stored secret is the raw key string (`sk-…`), NOT a per-CLI
// bundle. The resolver is deliberately CLI- and provider-agnostic and NOT a
// bundle validator: the ref is a generic provider ref, never `credential/codex/`,
// `credential/claude/`, or `credential/opencode/`, so the per-CLI ref/bundle
// validators would (correctly) reject it. We validate only the generic ref
// grammar and that the key is non-empty.
//
// No-fallback directive: a missing ref or an empty/whitespace-only key is a LOUD
// hard failure — never a silent degrade. The key VALUE is never logged or
// returned in any redacted/result shape; it goes ONLY into the per-run auth
// file/env the caller writes for the exec.
export async function resolveRawProviderKey(secrets: SecretStore, rawRef: string): Promise<string> {
  const ref = validateCredentialRef(rawRef);
  const secret = await secrets.get(ref);
  if (secret === undefined) {
    throw new Error(`missing managed LLM credential ref: ${ref}`);
  }
  const apiKey = secret.value.trim();
  if (apiKey === "") {
    throw new Error(`managed LLM credential ref ${ref} resolved to an empty api key`);
  }
  return apiKey;
}
