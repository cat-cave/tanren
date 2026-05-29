// `tanren behaviors ...` commands.

import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required } from "../args.js";

export async function behaviorsList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const personaId = required(args, "persona-id");
  const result = await request(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/behaviors?personaId=${encodeURIComponent(personaId)}`,
  );
  jsonOutput(args, result);
}

export async function behaviorsCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  /* eslint-disable unicorn/no-thenable */
  // "then" is part of the BDD Given/When/Then vocabulary, mirroring the
  // server-side BehaviorCreateInput field of the same name.
  const result = await jsonRequest(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/behaviors`,
    {
      personaId: required(args, "persona-id"),
      title: required(args, "title"),
      given: optional(args, "given") ?? "",
      when: optional(args, "when") ?? "",
      then: optional(args, "then") ?? "",
      description: optional(args, "description") ?? null,
    },
  );
  /* eslint-enable unicorn/no-thenable */
  jsonOutput(args, result);
}

export async function behaviorsGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const projectId = required(args, "project-id");
  const behaviorId = required(args, "behavior-id");
  const result = await request(
    `/orgs/${encodeURIComponent(orgId)}/projects/${encodeURIComponent(projectId)}/behaviors/${encodeURIComponent(behaviorId)}`,
  );
  jsonOutput(args, result);
}
