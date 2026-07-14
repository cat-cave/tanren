// `tanren orgs ...` commands. Mirror the /orgs HTTP surface.

import { parseJsonObject } from "../../json.js";
import { request, jsonRequest } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required } from "../args.js";

export async function orgsList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const result = await request("/orgs");
  jsonOutput(args, result);
}

export async function orgsGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = optional(args, "org-id") ?? args._[0];
  if (orgId === undefined) throw new Error("usage: tanren orgs get <orgId>");
  const result = await request(`/orgs/${encodeURIComponent(orgId)}`);
  jsonOutput(args, result);
}

export async function orgsConfigSet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const config = parseJsonObject(required(args, "config-json"), "config-json");
  const result = await jsonRequest(`/orgs/${encodeURIComponent(orgId)}`, { config }, { method: "PATCH" });
  jsonOutput(args, result);
}
