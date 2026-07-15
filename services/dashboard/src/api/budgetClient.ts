/**
 * Budget client. Standalone over `OrchestratorHttpClient` — not folded into the
 * product `OrchestratorClient` chain — so the budget surface owns its own api
 * module (screen-isolation lesson; keeps orchestrator.ts under the 500-line cap).
 *
 *   getProjectBudget → GET  /orgs/:orgId/projects/:projectId/budget
 *   putProjectBudget → PUT  /orgs/:orgId/projects/:projectId/budget
 *   getOrgBudget     → GET  /orgs/:orgId/budget
 *
 * Reads swallow failures to `undefined` (panel degrades to "unavailable").
 * Writes surface `{ ok, status, body }` so the form POST proxy can flash errors.
 */

import { OrchestratorHttpClient } from "./httpClient.js";
import type { BudgetPutBody, OrgBudgetView, ProjectBudgetView } from "./budget.js";
import { decodeWith, ProjectBudgetViewSchema } from "./writeResponseSchemas.js";

export class BudgetClient extends OrchestratorHttpClient {
  /** Project budget observation; undefined on read failure. */
  async getProjectBudget(orgId: string, projectId: string): Promise<ProjectBudgetView | undefined> {
    return this.getJson<ProjectBudgetView>(
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/budget`,
    );
  }

  /** Org default budget ceiling; undefined on read failure. */
  async getOrgBudget(orgId: string): Promise<OrgBudgetView | undefined> {
    return this.getJson<OrgBudgetView>(`/orgs/${encodeURIComponent(orgId)}/budget`);
  }

  /** Set or clear the project's own budget (`ceilingUsd: null` clears). */
  async putProjectBudget(
    orgId: string,
    projectId: string,
    body: BudgetPutBody,
  ): Promise<{ ok: boolean; status: number; body: ProjectBudgetView | undefined }> {
    return this.sendJson<ProjectBudgetView>(
      "PUT",
      `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/budget`,
      body,
      { expectBody: true, decode: (value) => decodeWith(ProjectBudgetViewSchema, value) },
    );
  }
}
