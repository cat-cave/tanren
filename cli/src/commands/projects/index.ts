// `tanren projects ...` commands.

import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required } from "../args.js";

export async function projectsList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = optional(args, "org-id") ?? args._[0];
  if (orgId === undefined) throw new Error("usage: tanren projects list <orgId>");
  const result = await request(`/orgs/${encodeURIComponent(orgId)}/projects`);
  jsonOutput(args, result);
}

export async function projectsCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const result = await jsonRequest(`/orgs/${encodeURIComponent(orgId)}/projects`, {
    name: required(args, "name"),
    repoUrl: required(args, "repo-url"),
    defaultBranch: optional(args, "default-branch"),
    runnerImage: optional(args, "runner-image"),
    allocator: optional(args, "allocator"),
  });
  jsonOutput(args, result);
}

export async function projectsGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await request(`/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}`);
  jsonOutput(args, result);
}

export async function projectsLink(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const result = await jsonRequest(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/link`,
    {
      repoUrl: required(args, "repo-url"),
      githubCredentialRef: optional(args, "github-credential-ref"),
    },
  );
  jsonOutput(args, result);
}
