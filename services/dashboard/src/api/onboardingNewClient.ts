/**
 * P3-0015 greenfield-onboarding client. A STANDALONE client over the shared
 * HTTP transport (`OrchestratorHttpClient`) — not folded into the product
 * `OrchestratorClient` chain — so the greenfield surface owns its own api module
 * (the P3-0014/P2B isolation lesson). Two calls map 1:1 onto the orchestrator
 * onboarding routes:
 *   round  → POST /orgs/:orgId/onboarding/interview/round
 *   derive → POST /orgs/:orgId/onboarding/interview/derive
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type { DeriveResult, InterviewCapture, InterviewRoundResult } from "./onboardingNewTypes.js";

export class OnboardingNewClient extends OrchestratorHttpClient {
  /** Run one interview round; returns the next question + updated capture. */
  async round(
    orgId: string,
    input: { round: number; answer: string; capture: InterviewCapture },
  ): Promise<{ ok: boolean; status: number; result: InterviewRoundResult | undefined }> {
    const r = await this.sendJson<InterviewRoundResult>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/onboarding/interview/round`,
      input,
    );
    return { ok: r.ok, status: r.status, result: r.body };
  }

  /** Derive the product graph (project + personas/behaviors/milestones/specs). */
  async derive(
    orgId: string,
    input: { capture: InterviewCapture; repoUrl?: string },
  ): Promise<{ ok: boolean; status: number; result: DeriveResult | undefined }> {
    const r = await this.sendJson<DeriveResult>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/onboarding/interview/derive`,
      input,
    );
    return { ok: r.ok, status: r.status, result: r.body };
  }
}
