// ds-5 — the strict, fail-closed dashboard client for the design Studio / reuse /
// evidence / exports surface. Every read returns `undefined` unless the response
// is EXACTLY 200, parses against the wire schema, AND the scope ids match the
// request — so a laundered/empty/mismatched payload can never render as a real
// (green) surface. The reuse-binding write returns a typed result the view maps
// to an explicit success/error notice.

import {
  DesignBindingResponseSchema,
  DesignCatalogResponseSchema,
  DesignDeliveryResponseSchema,
  DesignEcosystemResponseSchema,
  DesignEvidenceResponseSchema,
  DesignExportsResponseSchema,
  type BindingWriteResult,
  type DesignDeliveryProof,
  type DesignEvidenceVerdict,
  type DesignEcosystemView,
  type DesignExportFile,
  type DesignSystemCatalogEntry,
  type ProjectDesignBinding,
} from "./designStudio.js";
import { OrchestratorHttpClient } from "./httpClient.js";

function orgBase(orgId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}`;
}
function projectBase(orgId: string, projectId: string): string {
  return `${orgBase(orgId)}/projects/${encodeURIComponent(projectId)}`;
}

export class DesignStudioClient extends OrchestratorHttpClient {
  private async read200(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.orchestratorUrl}${path}`, { headers: this.headers() }).catch(
      () => {},
    );
    if (response === undefined || response.status !== 200) return undefined;
    return response.json().catch(() => {});
  }

  /** The reusable design-system catalog for the org (undefined = surface BLOCKED). */
  async getCatalog(orgId: string): Promise<readonly DesignSystemCatalogEntry[] | undefined> {
    const parsed = DesignCatalogResponseSchema.safeParse(await this.read200(`${orgBase(orgId)}/design-systems`));
    if (!parsed.success || parsed.data.orgId !== orgId) return undefined;
    return parsed.data.systems;
  }

  /** The project's current reuse binding: `null` = unbound, `undefined` = BLOCKED. */
  async getBinding(orgId: string, projectId: string): Promise<ProjectDesignBinding | null | undefined> {
    const parsed = DesignBindingResponseSchema.safeParse(
      await this.read200(`${projectBase(orgId, projectId)}/design-binding`),
    );
    if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.projectId !== projectId) return undefined;
    return parsed.data.binding;
  }

  /** The project's latest render-verdict evidence: `null` = none yet, `undefined` = BLOCKED. */
  async getEvidence(orgId: string, projectId: string): Promise<DesignEvidenceVerdict | null | undefined> {
    const parsed = DesignEvidenceResponseSchema.safeParse(
      await this.read200(`${projectBase(orgId, projectId)}/design-evidence`),
    );
    if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.projectId !== projectId) return undefined;
    return parsed.data.verdict;
  }

  /** ds-6 — the project's verified-join delivery trace (A4 ≡ demo); `undefined` = BLOCKED.
   * A non-200, a laundered/mismatched payload, or a scope-id mismatch all fail closed. */
  async getDeliveryProof(orgId: string, projectId: string): Promise<DesignDeliveryProof | undefined> {
    const parsed = DesignDeliveryResponseSchema.safeParse(
      await this.read200(`${projectBase(orgId, projectId)}/design-delivery-proof`),
    );
    if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.projectId !== projectId) return undefined;
    return parsed.data.proof;
  }

  /** The downloadable export projections for an artifact (undefined = BLOCKED). */
  async getExports(orgId: string, artifactId: string): Promise<readonly DesignExportFile[] | undefined> {
    const parsed = DesignExportsResponseSchema.safeParse(
      await this.read200(`${orgBase(orgId)}/design-artifacts/${encodeURIComponent(artifactId)}/exports`),
    );
    if (!parsed.success || parsed.data.orgId !== orgId || parsed.data.artifactId !== artifactId) return undefined;
    return parsed.data.files;
  }

  /** ds-8 destination-owned grant/import/quarantine lineage; undefined = BLOCKED. */
  async getEcosystem(orgId: string): Promise<DesignEcosystemView | undefined> {
    const parsed = DesignEcosystemResponseSchema.safeParse(await this.read200(`${orgBase(orgId)}/design-ecosystem`));
    if (!parsed.success || parsed.data.orgId !== orgId) return undefined;
    return parsed.data;
  }

  /** Bind a project to reuse a same-org design system (org-admin PUT). */
  async putBinding(
    orgId: string,
    projectId: string,
    input: {
      readonly designSystemId: string;
      readonly pinMode: "release" | "channel";
      readonly pinnedReleaseId?: string;
      readonly channel?: string;
    },
  ): Promise<BindingWriteResult> {
    const result = await this.sendJson("PUT", `${projectBase(orgId, projectId)}/design-binding`, input, {
      expectBody: true,
    });
    if (result.status !== 200) {
      const body = result.body as { message?: string } | undefined;
      return { ok: false, status: result.status, ...(body?.message === undefined ? {} : { message: body.message }) };
    }
    const parsed = DesignBindingResponseSchema.safeParse(result.body);
    if (
      !parsed.success ||
      parsed.data.binding === null ||
      parsed.data.orgId !== orgId ||
      parsed.data.projectId !== projectId
    ) {
      return { ok: false, status: 502, message: "binding write returned an unexpected payload" };
    }
    return { ok: true, status: 200, binding: parsed.data.binding };
  }
}
