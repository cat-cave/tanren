// `tanren credentials ...` commands.

import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required } from "../args.js";

export async function credentialsList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = optional(args, "org-id");
  const path = orgId === undefined ? "/credentials/me" : `/orgs/${encodeURIComponent(orgId)}/credentials`;
  jsonOutput(args, await request(path));
}

export async function credentialsCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = optional(args, "org-id");
  const kind = optional(args, "kind") ?? "opaque";
  const path =
    orgId === undefined
      ? `/credentials/me?kind=${encodeURIComponent(kind)}`
      : `/orgs/${encodeURIComponent(orgId)}/credentials?kind=${encodeURIComponent(kind)}`;
  const body: Record<string, string> = { ref: required(args, "ref") };
  if (kind === "github_token") {
    body["token"] = required(args, "value");
  } else if (kind === "codex_chatgpt_auth") {
    body["authJson"] = required(args, "value");
  } else {
    body["value"] = required(args, "value");
  }
  jsonOutput(args, await jsonRequest(path, body));
}

export async function credentialsGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const ref = required(args, "ref");
  jsonOutput(
    args,
    await request(
      `/orgs/${encodeURIComponent(orgId)}/credentials/${encodeURIComponent(ref)}`
    )
  );
}

export async function credentialsDelete(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const orgId = required(args, "org-id");
  const ref = required(args, "ref");
  jsonOutput(
    args,
    await request(
      `/orgs/${encodeURIComponent(orgId)}/credentials/${encodeURIComponent(ref)}`,
      { method: "DELETE" }
    )
  );
}
