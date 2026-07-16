import {
  AffectedSelectionResponseSchema,
  AffectedSelectionVerificationSchema,
  BehaviorCoverageOverviewSchema,
  type AffectedSelectionVerifyResult,
  type AffectedSelectionWriteResult,
  type AffectedTargetKind,
  type BehaviorCoverageOverview,
} from "./behaviorCoverage.js";
import { OrchestratorHttpClient } from "./httpClient.js";

function scopePath(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/behavior-coverage`;
}

/** Strict exact-status boundary client for the rv-4 public product surface. */
export class BehaviorCoverageClient extends OrchestratorHttpClient {
  async getOverview(orgId: string, projectId: string): Promise<BehaviorCoverageOverview | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${scopePath(orgId, projectId)}`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || response.status !== 200) return undefined;
    const raw: unknown = await response.json().catch(() => {});
    const parsed = BehaviorCoverageOverviewSchema.safeParse(raw);
    if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.projectId !== projectId) return undefined;
    return parsed.data;
  }

  async analyze(
    orgId: string,
    projectId: string,
    input: {
      readonly integrationNodeId: string;
      readonly target: { readonly kind: AffectedTargetKind; readonly targetRef: string };
    },
  ): Promise<AffectedSelectionWriteResult> {
    const result = await this.sendJson("POST", `${scopePath(orgId, projectId)}/affected-selection`, {
      integrationNodeId: input.integrationNodeId,
      targets: [input.target],
    });
    if (result.status !== 201) return { ok: false, status: result.status };
    const parsed = AffectedSelectionResponseSchema.safeParse(result.body);
    const selection = parsed.success ? parsed.data.selection : undefined;
    if (
      selection === undefined ||
      selection.orgId !== orgId ||
      selection.projectId !== projectId ||
      selection.binding.integrationNodeId !== input.integrationNodeId ||
      selection.changedTargets.length !== 1 ||
      selection.changedTargets[0]?.kind !== input.target.kind ||
      selection.changedTargets[0].targetRef !== input.target.targetRef
    ) {
      return { ok: false, status: 502 };
    }
    return { ok: true, status: result.status, selection };
  }

  async verify(orgId: string, projectId: string, analysisId: string): Promise<AffectedSelectionVerifyResult> {
    const path = `${scopePath(orgId, projectId)}/affected-selections/${encodeURIComponent(analysisId)}/verify`;
    const result = await this.sendJson("POST", path, {});
    if (result.status !== 200 && result.status !== 409) return { ok: false, status: result.status };
    const parsed = AffectedSelectionVerificationSchema.safeParse(result.body);
    if (!parsed.success || parsed.data.verification.analysisId !== analysisId) {
      return { ok: false, status: 502 };
    }
    if (
      (result.status === 200 && parsed.data.verification.status !== "current") ||
      (result.status === 409 && parsed.data.verification.status !== "stale")
    ) {
      return { ok: false, status: 502 };
    }
    return {
      ok: result.status === 200 && parsed.data.verification.status === "current",
      status: result.status,
      verification: parsed.data.verification,
    };
  }
}
