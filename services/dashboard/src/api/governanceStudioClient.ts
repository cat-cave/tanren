/** Typed, status-preserving client for the already-authoritative governance API. */

import {
  ActivatePolicyRevisionResponseSchema,
  BindGovernanceTierResponseSchema,
  CreatePolicyRevisionResponseSchema,
  EffectivePolicyResponseSchema,
  GovernanceBindingsResponseSchema,
  GovernanceRevisionsResponseSchema,
  GovernanceTiersResponseSchema,
  governanceStudioData,
  type EffectivePolicySnapshot,
  type EffectivePolicySubjectKind,
  type GovernanceStudioData,
  type PolicyRevision,
} from "./governanceStudio.js";
import { OrchestratorHttpClient } from "./httpClient.js";

export type GovernanceStudioRead =
  | { readonly ok: true; readonly data: GovernanceStudioData }
  | { readonly ok: false; readonly failure: "unavailable" | "malformed"; readonly status: number };

export type ReceiptRead =
  | { readonly kind: "found"; readonly snapshot: EffectivePolicySnapshot }
  | { readonly kind: "not_found" }
  | { readonly kind: "unavailable" | "malformed"; readonly status: number };

export type GovernanceStudioCommand<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly outcome: "rejected" | "unknown" };

export class GovernanceStudioClient extends OrchestratorHttpClient {
  async readProject(orgId: string, projectId: string): Promise<GovernanceStudioRead> {
    const [revisionResult, tierResult, bindingResult] = await Promise.all([
      this.getJsonResponse<unknown>(`${scopePath(orgId, projectId)}/revisions`),
      this.getJsonResponse<unknown>(`${scopePath(orgId, projectId)}/tiers`),
      this.getJsonResponse<unknown>(`${scopePath(orgId, projectId)}/bindings`),
    ]);
    const unsuccessful = [revisionResult, tierResult, bindingResult].find((result) => !result.ok);
    if (unsuccessful !== undefined) return { ok: false, failure: "unavailable", status: unsuccessful.status };

    const revisions = GovernanceRevisionsResponseSchema.safeParse(revisionResult.body);
    const tiers = GovernanceTiersResponseSchema.safeParse(tierResult.body);
    const bindings = GovernanceBindingsResponseSchema.safeParse(bindingResult.body);
    if (!revisions.success || !tiers.success || !bindings.success)
      return { ok: false, failure: "malformed", status: 502 };
    const data = governanceStudioData(projectId, revisions.data.revisions, tiers.data.tiers, bindings.data.bindings);
    return data === undefined ? { ok: false, failure: "malformed", status: 502 } : { ok: true, data };
  }

  async getReceipt(
    orgId: string,
    projectId: string,
    subjectKind: EffectivePolicySubjectKind,
    subjectId: string,
  ): Promise<ReceiptRead> {
    const result = await this.getJsonResponse<unknown>(
      `${scopePath(orgId, projectId)}/effective/${encodeURIComponent(subjectKind)}/${encodeURIComponent(subjectId)}`,
    );
    if (result.status === 404) return { kind: "not_found" };
    if (!result.ok) return { kind: "unavailable", status: result.status };
    const parsed = EffectivePolicyResponseSchema.safeParse(result.body);
    if (
      !parsed.success ||
      parsed.data.snapshot.projectId !== projectId ||
      parsed.data.snapshot.subjectKind !== subjectKind ||
      parsed.data.snapshot.subjectId !== subjectId
    ) {
      return { kind: "malformed", status: 502 };
    }
    return { kind: "found", snapshot: parsed.data.snapshot };
  }

  async createRevision(
    orgId: string,
    projectId: string,
    fragmentConfig: unknown,
    parentRevisionId: string | undefined,
  ): Promise<GovernanceStudioCommand<PolicyRevision>> {
    const result = await this.sendJson("POST", `${scopePath(orgId, projectId)}/revisions`, {
      fragmentConfig,
      ...(parentRevisionId === undefined ? {} : { parentRevisionId }),
    });
    if (result.status !== 201) return commandFailure(result.status);
    const parsed = CreatePolicyRevisionResponseSchema.safeParse(result.body);
    if (!parsed.success || parsed.data.revision.projectId !== projectId)
      return { ok: false, status: 502, outcome: "unknown" };
    return { ok: true, value: parsed.data.revision };
  }

  async activateRevision(
    orgId: string,
    projectId: string,
    revisionId: string,
  ): Promise<GovernanceStudioCommand<PolicyRevision>> {
    const result = await this.sendJson(
      "POST",
      `${scopePath(orgId, projectId)}/revisions/${encodeURIComponent(revisionId)}/activate`,
    );
    if (result.status !== 200) return commandFailure(result.status);
    const parsed = ActivatePolicyRevisionResponseSchema.safeParse(result.body);
    if (!parsed.success || parsed.data.revision.id !== revisionId || parsed.data.revision.projectId !== projectId) {
      return { ok: false, status: 502, outcome: "unknown" };
    }
    return { ok: true, value: parsed.data.revision };
  }

  async bindTier(
    orgId: string,
    projectId: string,
    tierId: string,
  ): Promise<GovernanceStudioCommand<{ readonly bindingId: string; readonly policyRevisionId: string }>> {
    const result = await this.sendJson(
      "POST",
      `${scopePath(orgId, projectId)}/tiers/${encodeURIComponent(tierId)}/bind`,
    );
    if (result.status !== 201) return commandFailure(result.status);
    const parsed = BindGovernanceTierResponseSchema.safeParse(result.body);
    if (
      !parsed.success ||
      parsed.data.tier.id !== tierId ||
      parsed.data.tier.projectId !== projectId ||
      parsed.data.binding.projectId !== projectId ||
      parsed.data.binding.tierId !== tierId ||
      !parsed.data.binding.isActive ||
      parsed.data.binding.effectivePolicyHash !== parsed.data.tier.canonicalHash
    ) {
      return { ok: false, status: 502, outcome: "unknown" };
    }
    return { ok: true, value: { bindingId: parsed.data.binding.id, policyRevisionId: parsed.data.policyRevisionId } };
  }
}

function scopePath(orgId: string, projectId: string): string {
  return `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/governance`;
}

function commandFailure(status: number): GovernanceStudioCommand<never> {
  return { ok: false, status, outcome: status >= 400 && status < 500 ? "rejected" : "unknown" };
}
