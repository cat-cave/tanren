// Shared OpenRouter generation-id capture for the managed CLI adapters
// (codex/claude/opencode). When a run is routed THROUGH OpenRouter (managed
// mode), the provider's response/generation events carry a top-level `id` that
// OpenRouter's `GET /api/v1/generation?id=` accepts. Capturing it lets the cost
// recorder query the REAL per-call `usage.cost` and record cost_usd as a metered
// FACT (`provider_response`) instead of leaving it NULL.
//
// OpenRouter's completion ids are prefixed `gen-`, so we recognize ONLY a
// `gen-`-prefixed top-level string id and never mistake a CLI-internal event id
// for an OpenRouter generation id. A BYOK / non-managed run surfaces no such id →
// the recorder records cost_usd = NULL (`unknown`); there is NO list-rate estimate
// (REAL SPEND IS A FACT, see engine/costs/sources.ts).
import { emptyTokenUsage, type TokenUsage } from "./types.js";

const ID_KEYS = ["id", "response_id", "responseId", "generation_id", "generationId"] as const;
const NESTED_KEYS = ["response", "generation"] as const;

// Recognize an OpenRouter generation id on one parsed event object: a `gen-`-
// prefixed top-level string under any known id key, or nested under
// `response`/`generation`. Returns undefined when none is present.
export function findOpenRouterGenerationId(event: Record<string, unknown>): string | undefined {
  for (const key of ID_KEYS) {
    const value = event[key];
    if (typeof value === "string" && value.startsWith("gen-")) {
      return value;
    }
  }
  for (const key of NESTED_KEYS) {
    const nested = event[key];
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
      const found = findOpenRouterGenerationId(nested as Record<string, unknown>);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

// Fold a captured generation id onto the token usage so the single TokenUsage the
// recorder reads carries it. When usage is absent but an id surfaced, mint a
// zero-token usage to carry the id (the recorder still records the call).
export function foldGenerationId(
  tokenUsage: TokenUsage | undefined,
  openRouterGenerationId: string | undefined,
): TokenUsage | undefined {
  if (openRouterGenerationId === undefined) {
    return tokenUsage;
  }
  return { ...(tokenUsage ?? emptyTokenUsage), openRouterGenerationId };
}
