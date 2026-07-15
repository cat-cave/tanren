/**
 * candidate-inbox client. A STANDALONE client over the shared HTTP
 * transport (`OrchestratorHttpClient`) — not folded into the product
 * `OrchestratorClient` inheritance chain — so the inbox surface owns its own
 * api module per the screen-isolation lesson. The inbox route instantiates it
 * directly with the forwarded cookie header.
 *
 * Calls map 1:1 onto the orchestrator inbox routes:
 *   snapshot         → GET  /orgs/:orgId/inbox
 *   ingest           → POST /orgs/:orgId/inbox/sources/:sourceId/ingest
 *   accept           → POST /orgs/:orgId/inbox/candidates/:id/accept
 *   fold/dismiss/dup → POST /orgs/:orgId/inbox/candidates/:id/{fold,dismiss,close-duplicate}
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type { Candidate, InboxSnapshot } from "./inboxTypes.js";
import { decodeWith, InboxCandidateResponseSchema } from "./writeResponseSchemas.js";

export class InboxClient extends OrchestratorHttpClient {
  private base(orgId: string): string {
    return `/orgs/${encodeURIComponent(orgId)}/inbox`;
  }

  /** The source list + candidate stream for the org. */
  async snapshot(orgId: string): Promise<InboxSnapshot | undefined> {
    return this.getJson<InboxSnapshot>(this.base(orgId));
  }

  /** Pull → triage → upsert a source's candidates. */
  async ingest(orgId: string, sourceId: string): Promise<{ ok: boolean }> {
    const r = await this.sendJson("POST", `${this.base(orgId)}/sources/${encodeURIComponent(sourceId)}/ingest`);
    return { ok: r.ok };
  }

  /** Accept → discovery: create the spec(s) + resolve the candidate. */
  async accept(
    orgId: string,
    candidateId: string,
    input: {
      proposals: unknown[];
      placementKind: string;
      placementLabel: string;
    },
  ): Promise<{ ok: boolean; candidate?: Candidate }> {
    const r = await this.sendJson<{ candidate?: Candidate }>(
      "POST",
      `${this.base(orgId)}/candidates/${encodeURIComponent(candidateId)}/accept`,
      input,
      { expectBody: true, decode: (value) => decodeWith(InboxCandidateResponseSchema, value) },
    );
    return {
      ok: r.ok,
      ...(r.body?.candidate === undefined ? {} : { candidate: r.body.candidate }),
    };
  }

  /** Fold / dismiss / close-as-duplicate — the three status-transition actions. */
  async resolve(
    orgId: string,
    candidateId: string,
    verb: "fold" | "dismiss" | "close-duplicate",
  ): Promise<{ ok: boolean; candidate?: Candidate }> {
    const r = await this.sendJson<{ candidate?: Candidate }>(
      "POST",
      `${this.base(orgId)}/candidates/${encodeURIComponent(candidateId)}/${verb}`,
      undefined,
      { expectBody: true, decode: (value) => decodeWith(InboxCandidateResponseSchema, value) },
    );
    return {
      ok: r.ok,
      ...(r.body?.candidate === undefined ? {} : { candidate: r.body.candidate }),
    };
  }
}
