import type { SecretStore } from "../contracts/secretStore.js";
import { validateCredentialRef } from "./codexAuth.js";

// SaaS Tier-B #5: the shared MANAGED-mode key resolver every CLI materializer
// uses. In managed mode the run resolves a PLATFORM-owned, plain
// OpenAI-compatible API-key credential (e.g. `credential/openrouter/platform/…`)
// whose stored secret is the raw key string `sk-or-…`, NOT a per-CLI auth
// bundle. Each CLI then routes THROUGH OpenRouter per OpenRouter's coding-agent
// cookbooks, with this single key placed into that CLI's auth file/env.
//
// This resolver is deliberately CLI-agnostic and NOT a per-CLI bundle validator:
// the managed ref is a generic provider ref (`credential/openrouter/…`), never
// `credential/codex/`, `credential/claude/`, or `credential/opencode/`, so the
// per-CLI ref/bundle validators would (correctly) reject it. We validate only
// the generic ref grammar and that the key is non-empty.
//
// No-fallback directive: a missing ref or an empty/whitespace-only key is a LOUD
// hard failure — never a silent degrade. The key VALUE is never logged or
// returned in any redacted/result shape; it goes ONLY into the per-run auth
// file/env the caller writes for the exec.
export async function resolveManagedOpenRouterKey(secrets: SecretStore, rawRef: string): Promise<string> {
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
