/**
 * thick-Forge conversation client surface, split out of
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

/**
 * (write-action approval): a write the Forge answerer proposed, awaiting
 * a human decision. The dashboard renders pending proposals as live
 * approve/reject cards; executed/rejected/failed are terminal states.
 */
export type ForgeProposalStatus = "pending" | "approved" | "rejected" | "executed" | "failed";
export interface ForgeActionProposal {
  id: string;
  orgId: string;
  threadId: string;
  proposingTurnId: string;
  toolName: string;
  args: Record<string, unknown>;
  rationale: string;
  status: ForgeProposalStatus;
  proposedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  result: unknown;
  error: string | null;
}

export interface ForgeAskScope {
  /** project-scoped thread when set; otherwise an org-wide thread. */
  projectId?: string;
  runId?: string;
}

export interface ForgeAskResponse {
  threadId: string;
  answer: ForgeAnswer;
  toolsUsed: string[];
  /** pending write proposals the answerer raised this turn. */
  proposals: ForgeActionProposal[];
}

/** Structured failure at the public askForge boundary (never silent undefined). */
export interface ForgeAskFailure {
  error: string;
}

export type ForgeAskResult = ForgeAskResponse | ForgeAskFailure;

/** The outcome of an approve/reject decision (write-action approval). */
export interface ForgeProposalDecisionResponse {
  /** The proposal in its post-decision state, when the orchestrator returned it. */
  proposal?: ForgeActionProposal;
  // `already_decided` is the idempotent 409 (carries currentStatus); `denied`
  // is an authz refusal; both keep a double-approve from re-executing.
  outcome: "decided" | "already_decided" | "denied" | "not_found" | "failed";
  currentStatus?: string;
}

interface TurnPayload {
  render?: ForgeAnswer;
}

export abstract class OrchestratorForgeConversationClient extends OrchestratorRecoveryClient {
  /**
   * Ask Forge a question. Creates a thread for the scope, then runs one
   * conversation exchange. Failures return `{ error }` — never undefined success.
   */
  async askForge(
    orgId: string,
    question: string,
    scope: ForgeAskScope = {},
    threadId?: string,
  ): Promise<ForgeAskResult> {
    const resolvedThreadId = threadId ?? (await this.ensureThread(orgId, scope));
    if (resolvedThreadId === undefined) {
      return { error: "forge_thread_unavailable" };
    }
    const result = await this.sendJson<{
      forgeTurn?: TurnPayload;
      toolsUsed?: string[];
      proposals?: ForgeActionProposal[];
    }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads/${encodeURIComponent(resolvedThreadId)}/ask`,
      { question },
      { expectBody: true },
    );
    // 200 {} / missing forgeTurn.render is not a successful ask — fail closed.
    const render = result.body?.forgeTurn?.render;
    if (!result.ok || render === undefined || typeof render.body !== "string") {
      return { error: "forge_ask_failed" };
    }
    return {
      threadId: resolvedThreadId,
      answer: render,
      toolsUsed: result.body?.toolsUsed ?? [],
      proposals: result.body?.proposals ?? [],
    };
  }

  /**
   * Approve or reject a proposed write action (write-action approval).
   * On approve the orchestrator re-validates + authz's the APPROVING operator
   * and executes the write; the response carries the post-decision proposal.
   * An already-decided proposal returns `already_decided` (the idempotent 409)
   * so the caller never double-applies; an authz refusal returns `denied`.
   */
  async decideForgeProposal(
    orgId: string,
    proposalId: string,
    decision: "approve" | "reject",
  ): Promise<ForgeProposalDecisionResponse> {
    const result = await this.sendJson<{ proposal?: ForgeActionProposal; status?: string }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/proposals/${encodeURIComponent(proposalId)}/${decision}`,
      undefined,
      { expectBody: true },
    );
    if (result.ok) {
      // Incomplete 200 bodies (e.g. {}) must not masquerade as decided.
      const proposal = result.body?.proposal;
      if (proposal === undefined || typeof proposal !== "object") {
        return { outcome: "failed" };
      }
      return { proposal, outcome: "decided" };
    }
    if (result.status === 409) {
      return { outcome: "already_decided", currentStatus: result.body?.status };
    }
    if (result.status === 403) {
      return { outcome: "denied" };
    }
    if (result.status === 404) {
      return { outcome: "not_found" };
    }
    return { outcome: "failed" };
  }

  /** Create a Forge thread for the requested scope. `undefined` on failure. */
  private async ensureThread(orgId: string, scope: ForgeAskScope): Promise<string | undefined> {
    const body =
      scope.runId !== undefined && scope.projectId !== undefined
        ? { scope: "run", projectId: scope.projectId, runId: scope.runId }
        : scope.projectId === undefined
          ? { scope: "org" }
          : { scope: "project", projectId: scope.projectId };
    const thread = await this.sendJson<{ id?: string }>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/forge/threads`,
      body,
      { expectBody: true },
    );
    return thread.ok ? thread.body?.id : undefined;
  }
}
