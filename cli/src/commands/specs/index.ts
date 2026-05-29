// `tanren specs ...` commands.

import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required } from "../args.js";

function manyOf(args: ReturnType<typeof parseArgs>, key: string): string[] {
  const value = args[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export async function specsList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await request(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs`
  );
  jsonOutput(args, result);
}

export async function specsCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const acceptance = manyOf(args, "acceptance");
  if (acceptance.length === 0) throw new Error("missing --acceptance");
  const result = await jsonRequest(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs`,
    {
      title: required(args, "title"),
      description: required(args, "description"),
      acceptanceCriteria: acceptance,
      dependsOn: manyOf(args, "depends-on")
    }
  );
  jsonOutput(args, result);
}

export async function specsGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const specId = required(args, "spec-id");
  const result = await request(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}`
  );
  jsonOutput(args, result);
}

export async function specsRun(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const specId = required(args, "spec-id");
  const result = await jsonRequest(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/specs/${encodeURIComponent(specId)}/runs`,
    {
      trigger: optional(args, "trigger") ?? "cli",
      branch: optional(args, "branch")
    }
  );
  jsonOutput(args, result);
}
