/**
 * gv-3 BFF client: GET /orgs/:orgId/projects/:projectId/policy-identity
 */

import { isPolicyIdentityView, type PolicyIdentityView } from "./policyIdentity.js";

export type PolicyIdentityReadResult =
  | { ok: true; view: PolicyIdentityView }
  | { ok: false; reason: "denied" | "not_found" | "unreadable" | "malformed" | "unavailable" };

export interface PolicyIdentityClientDeps {
  orchestratorUrl: string;
  cookieHeader?: string | undefined;
}

export class PolicyIdentityClient {
  constructor(private readonly deps: PolicyIdentityClientDeps) {}

  async get(orgId: string, projectId: string): Promise<PolicyIdentityReadResult> {
    try {
      const url = `${this.deps.orchestratorUrl}/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/policy-identity`;
      const headers: Record<string, string> = { accept: "application/json" };
      if (this.deps.cookieHeader !== undefined) {
        headers["cookie"] = this.deps.cookieHeader;
      }
      const res = await fetch(url, { headers });
      if (res.status === 403) return { ok: false, reason: "denied" };
      if (res.status === 404) return { ok: false, reason: "not_found" };
      if (res.status === 422) return { ok: false, reason: "unreadable" };
      if (!res.ok) return { ok: false, reason: "unavailable" };
      const body: unknown = await res.json().catch(() => null);
      if (!isPolicyIdentityView(body)) return { ok: false, reason: "malformed" };
      return { ok: true, view: body };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }
}
