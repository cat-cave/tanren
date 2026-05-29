// `tanren milestones ...` commands.

import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required } from "../args.js";

export async function milestonesList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await request(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/milestones`,
  );
  jsonOutput(args, result);
}

export async function milestonesCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await jsonRequest(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/milestones`,
    {
      label: required(args, "label"),
      name: required(args, "name"),
      description: optional(args, "description") ?? null,
      orderIndex: Number.parseInt(required(args, "order-index"), 10),
      eta: optional(args, "eta") ?? null,
      status: optional(args, "status"),
    },
  );
  jsonOutput(args, result);
}

export async function milestonesGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const milestoneId = required(args, "milestone-id");
  const result = await request(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/milestones/${encodeURIComponent(milestoneId)}`,
  );
  jsonOutput(args, result);
}
