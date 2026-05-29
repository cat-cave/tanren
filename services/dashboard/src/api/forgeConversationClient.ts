/**
 * P3-0010 thick-Forge conversation client surface, split out of
 * `orchestrator.ts` so the product client stays under the 500-line architecture
 * cap (same split rationale as `recoveryClient.ts`). Lands on
 * `OrchestratorClient` via inheritance.
 *
 * `askForge` drives the ⌘K chat morph: it ensures a Forge thread exists for the
 * scope (creating one on first ask) and POSTs the operator's question to the
 * orchestrator's LLM-backed conversation endpoint
 * (`POST /orgs/:orgId/forge/threads/:threadId/ask`), returning the forge turn's
 * ForgeAnswer render. The session cookie is forwarded by the shared helpers so
 * the orchestrator URL stays server-side.
 */

import { OrchestratorRecoveryClient } from "./recoveryClient.js";
import type { ForgeAnswer } from "./types.js";

export interface ForgeAskScope {
  /** project-scoped thread when set; otherwise an org-wide thread. */
  projectId?: string;
  runId?: string;
}

export interface ForgeAskResponse {
  threadId: string;
  answer: ForgeAnswer;
  toolsUsed: string[];
}

interface TurnPayload {
  render?: ForgeAnswer;
}

export abstract class OrchestratorForgeConversationClient extends OrchestratorRecoveryClient {
  /**
   * Ask Forge a question. Creates a thread for the scope, then runs one
   * conversation exchange. `threadId` is returned so a follow-up can continue
   * the same thread. `undefined` on failure so the palette degrades gracefully.
   */
  async askForge(
    orgId: string,
    question: string,
    scope: ForgeAskScope = {},
    threadId?: string,
  ): Promise<ForgeAskResponse | undefined> {
    const resolvedThreadId = threadId ?? (await this.ensureThread(orgId, scope));
    if (resolvedThreadId === undefined) {
      return undefined;
    }
    const result = await this.sendJson<{ forgeTurn?: TurnPayload; toolsUsed?: string[] }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads/${encodeURIComponent(resolvedThreadId)}/ask`,
      { question },
    );
    const render = result.body?.forgeTurn?.render;
    if (!result.ok || render === undefined) {
      return undefined;
    }
    return { threadId: resolvedThreadId, answer: render, toolsUsed: result.body?.toolsUsed ?? [] };
  }

  /** Create a Forge thread for the requested scope. `undefined` on failure. */
  private async ensureThread(orgId: string, scope: ForgeAskScope): Promise<string | undefined> {
    const body =
      scope.runId !== undefined && scope.projectId !== undefined
        ? { scope: "run", projectId: scope.projectId, runId: scope.runId }
        : scope.projectId !== undefined
          ? { scope: "project", projectId: scope.projectId }
          : { scope: "org" };
    const thread = await this.sendJson<{ id?: string }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads`,
      body,
    );
    return thread.ok ? thread.body?.id : undefined;
  }
}
