// `tanren integrations ...` commands — read-only views over the in-20
// integration HTTP surface (org+project-scoped through the orchestrator's
// `/v1/orgs/...` routes). The CLI hits the same endpoints the dashboard
// consumes; RLS on the orchestrator side confines every read to the caller's
// org, so a cross-org invocation returns 403 (no data leaks).

import { request } from "../../httpClient.js";
import { jsonOutput, parseArgs, required } from "../args.js";

/** Common path prefix for the in-20 surface. */
function scopePath(orgId: string, projectId: string): string {
  return `/v1/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`;
}

/** `tanren integrations lifecycle --org-id X --project-id Y` — in-3 inventory rollup. */
export async function integrationsLifecycle(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await request(`${scopePath(orgId, projectId)}/integrations/lifecycle`);
  jsonOutput(args, result);
}

/** `tanren integrations requirements --org-id X --project-id Y` — typed lifecycle rows. */
export async function integrationsRequirements(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await request(`${scopePath(orgId, projectId)}/integration-requirements`);
  jsonOutput(args, result);
}

/** `tanren integrations capability-nodes --org-id X --project-id Y` — capability nodes. */
export async function integrationsCapabilityNodes(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await request(`${scopePath(orgId, projectId)}/capability-nodes`);
  jsonOutput(args, result);
}

/** `tanren integrations bindings --org-id X --project-id Y` — bindings + the appEnvHash proof. */
export async function integrationsBindings(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await request(`${scopePath(orgId, projectId)}/integration-bindings`);
  jsonOutput(args, result);
}

/** `tanren integrations delivery --org-id X --project-id Y` — delivery-DAG status. */
export async function integrationsDelivery(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await request(`${scopePath(orgId, projectId)}/delivery`);
  jsonOutput(args, result);
}
