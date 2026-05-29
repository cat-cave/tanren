// `tanren personas ...` commands mirroring the /personas HTTP routes.

import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required } from "../args.js";

export async function personasList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = optional(args, "project-id");
  const path =
    projectId === undefined
      ? `/orgs/${encodeURIComponent(orgId)}/personas`
      : `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/personas`;
  jsonOutput(args, await request(path));
}

export async function personasCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = optional(args, "project-id");
  const body = {
    scope: projectId === undefined ? "org" : "project",
    name: required(args, "name"),
    description: optional(args, "description") ?? ""
  };
  const path =
    projectId === undefined
      ? `/orgs/${encodeURIComponent(orgId)}/personas`
      : `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/personas`;
  jsonOutput(args, await jsonRequest(path, body));
}

export async function personasGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const personaId = required(args, "persona-id");
  jsonOutput(
    args,
    await request(`/orgs/${encodeURIComponent(orgId)}/personas/${encodeURIComponent(personaId)}`)
  );
}
