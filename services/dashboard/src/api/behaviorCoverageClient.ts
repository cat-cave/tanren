import {
  AffectedSelectionResponseSchema,
  BehaviorCoverageSnapshotSchema,
  type AffectedSelectionWriteResult,
  type AffectedTargetKind,
  type BehaviorCoverageSnapshot,
} from "./behaviorCoverage.js";
import { OrchestratorHttpClient } from "./httpClient.js";

function scopePath(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/behavior-coverage`;
}

/** Strict boundary client for the rv-4 coverage graph and affected selector. */
export class BehaviorCoverageClient extends OrchestratorHttpClient {
  async getSnapshot(orgId: string, projectId: string): Promise<BehaviorCoverageSnapshot | undefined> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${scopePath(orgId, projectId)}`, {
      headers: this.headers(),
    }).catch(() => {});
    if (response === undefined || !response.ok) return undefined;
    const json: unknown = await response.json().catch(() => {});
    const parsed = BehaviorCoverageSnapshotSchema.safeParse(json);
    if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.projectId !== projectId) return undefined;
    return parsed.data;
  }

  async analyze(
    orgId: string,
    projectId: string,
    target: { kind: AffectedTargetKind; targetRef: string },
  ): Promise<AffectedSelectionWriteResult> {
    const result = await this.sendJson("POST", `${scopePath(orgId, projectId)}/affected-selection`, {
      targets: [target],
    });
    if (!result.ok) return { ok: false, status: result.status };
    const parsed = AffectedSelectionResponseSchema.safeParse(result.body);
    if (!parsed.success || parsed.data.selection.orgId !== orgId || parsed.data.selection.projectId !== projectId) {
      return { ok: false, status: 502 };
    }
    return { ok: true, status: result.status, selection: parsed.data.selection };
  }
}
