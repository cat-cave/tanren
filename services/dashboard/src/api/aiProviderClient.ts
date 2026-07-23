/**
 * "Connect AI provider" client. A STANDALONE client over the shared HTTP
 * transport (`OrchestratorHttpClient`) — not folded into the product
 * `OrchestratorClient` chain — so this run-default surface owns its own api
 * module (the screen-isolation lesson; `orchestrator.ts` is near the 500-line
 * cap). Calls map 1:1 onto the orchestrator ai-provider routes:
 *   connect → POST /orgs/:orgId/ai-provider  { provider, apiKey?|authJson?, makeDefault }
 *   list    → GET  /orgs/:orgId/ai-provider   { providerMode, providers[] }
 *
 * Connecting with `makeDefault: true` flips the org's `providerMode → "byok"` and
 * writes the default LLM routing entry a run resolves — the whole point (storing a
 * credential alone never made it the run default). Secret VALUES are write-only:
 * never sent back, never rendered.
 */

import { OrchestratorHttpClient } from "./httpClient.js";

/** The BYOK LLM providers a user can connect (mirror of orchestrator AI_PROVIDERS). */
export const AI_PROVIDER_KINDS = ["openrouter", "anthropic", "openai", "codex"] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/** One connected provider as returned by GET (values never exposed). */
export interface ConnectedProvider {
  provider: AiProviderKind;
  ref: string;
  classifiedAs: string;
  isDefault: boolean;
}

export interface ConnectedProvidersList {
  providerMode: string;
  providers: ConnectedProvider[];
}

export interface ConnectResult {
  provider: AiProviderKind;
  ref: string;
  classifiedAs: string;
  isDefault: boolean;
}

export interface ConnectInput {
  provider: AiProviderKind;
  /** Raw API key for openrouter/anthropic/openai (write-only). */
  apiKey?: string;
  /** Codex ChatGPT auth bundle JSON (write-only). */
  authJson?: string;
  /** Trailing ref segment; defaults to "default" server-side. */
  name?: string;
  /** Wire it as the org's run default (flips providerMode → byok). Defaults true. */
  makeDefault?: boolean;
}

export class AiProviderClient extends OrchestratorHttpClient {
  /** Connect a BYOK LLM provider; with `makeDefault` it becomes the run default. */
  async connect(
    orgId: string,
    input: ConnectInput,
  ): Promise<{ ok: boolean; status: number; body: ConnectResult | undefined; error?: string }> {
    const r = await this.sendJson<ConnectResult>("POST", `/orgs/${encodeURIComponent(orgId)}/ai-provider`, input, {
      expectBody: true,
    });
    if (!r.ok) {
      const errBody = r.body as { error?: string; message?: string } | undefined;
      return { ok: false, status: r.status, body: undefined, error: errBody?.message ?? errBody?.error };
    }
    return { ok: true, status: r.status, body: r.body };
  }

  /** List connected providers + the org's provider mode. `undefined` on read failure. */
  async list(orgId: string): Promise<ConnectedProvidersList | undefined> {
    return this.getJson<ConnectedProvidersList>(`/orgs/${encodeURIComponent(orgId)}/ai-provider`);
  }
}
