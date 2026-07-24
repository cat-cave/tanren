/**
 * greenfield-onboarding client. A STANDALONE client over the shared
 * HTTP transport (`OrchestratorHttpClient`) — not folded into the product
 * `OrchestratorClient` chain — so the greenfield surface owns its own api module
 * (the screen-isolation lesson). Two calls map 1:1 onto the orchestrator
 * onboarding routes:
 *   round  → POST /orgs/:orgId/onboarding/interview/round
 *   derive → POST /orgs/:orgId/onboarding/interview/derive
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type { DeriveInput, DeriveResult, InterviewRoundResult } from "./onboardingNewTypes.js";

export class OnboardingNewClient extends OrchestratorHttpClient {
  /** Run one interview round; returns the next question + updated capture. */
  async round(
    orgId: string,
    input: { round: number; answer: string; state?: string },
  ): Promise<{ ok: boolean; status: number; result: InterviewRoundResult | undefined }> {
    const r = await this.sendJson<InterviewRoundResult>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/onboarding/interview/round`,
      { round: input.round, answer: input.answer, ...(input.state === undefined ? {} : { state: input.state }) },
      { expectBody: true },
    );
    return { ok: r.ok, status: r.status, result: r.body };
  }

  /**
   * Derive the product graph (project + personas/behaviors/milestones/specs).
   * `owner` (the GitHub owner for the new repo) is REQUIRED by the orchestrator's
   * strict `DeriveBody`; `autonomy` + `deploy` are optional. The body is sent as
   * given (the UI validates `owner` before ever calling this), so a strict-schema
   * rejection here is a real contract mismatch, not a missing-field 400.
   */
  async derive(
    orgId: string,
    input: DeriveInput,
  ): Promise<{ ok: boolean; status: number; result: DeriveResult | undefined }> {
    const body: DeriveInput = {
      state: input.state,
      owner: input.owner,
      ...(input.autonomy === undefined ? {} : { autonomy: input.autonomy }),
      ...(input.deploy === undefined ? {} : { deploy: input.deploy }),
    };
    const r = await this.sendJson<DeriveResult>(
      "POST",
      `/orgs/${encodeURIComponent(orgId)}/onboarding/interview/derive`,
      body,
      { expectBody: true },
    );
    return { ok: r.ok, status: r.status, result: r.body };
  }
}
