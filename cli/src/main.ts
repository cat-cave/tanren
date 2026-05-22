#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const orchestratorUrl = process.env.TANREN_ORCHESTRATOR_URL ?? "http://localhost:3100";
const dashboardUrl = process.env.TANREN_DASHBOARD_URL ?? "http://localhost:3000";

export async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${orchestratorUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<unknown>;
}

export async function jsonRequest(path: string, body: unknown) {
  return await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export async function doctor() {
  const health = await request("/healthz");
  console.log(JSON.stringify(health, null, 2));
}

export async function hello() {
  const summary = await request("/hello/run", { method: "POST" });
  console.log(JSON.stringify(summary, null, 2));
}

export async function status(runId: string | undefined) {
  if (!runId) {
    throw new Error("usage: tanren status <run_id>");
  }
  const run = await request(`/runs/${runId}`);
  console.log(JSON.stringify(run, null, 2));
}

export async function createProjectCommand(argv: string[]) {
  const args = parseArgs(argv);
  const configJson = optional(args, "config-json");
  const project = await jsonRequest("/projects", {
    name: required(args, "name"),
    repoUrl: required(args, "repo-url"),
    defaultBranch: optional(args, "default-branch"),
    runnerImage: optional(args, "runner-image"),
    allocator: optional(args, "allocator"),
    config: configJson === undefined ? undefined : parseJsonObject(configJson, "config-json")
  });
  console.log(JSON.stringify(project, null, 2));
}

export async function createSpecCommand(argv: string[]) {
  const args = parseArgs(argv);
  const spec = await jsonRequest("/specs", {
    projectId: required(args, "project-id"),
    title: required(args, "title"),
    description: required(args, "description"),
    acceptanceCriteria: requiredMany(args, "acceptance"),
    dependsOn: optionalMany(args, "depends-on")
  });
  console.log(JSON.stringify(spec, null, 2));
}

export async function runSpecCommand(argv: string[]) {
  const args = parseArgs(argv);
  const specId = optional(args, "spec-id") ?? args._[0];
  if (specId === undefined) {
    throw new Error("usage: tanren spec run --spec-id <spec_id>");
  }
  const run = await jsonRequest(`/specs/${specId}/runs`, {
    trigger: optional(args, "trigger") ?? "cli",
    branch: optional(args, "branch")
  });
  console.log(JSON.stringify(run, null, 2));
}

export async function importCodexCredentialCommand(argv: string[]) {
  const args = parseArgs(argv);
  const authJson = await readFile(required(args, "auth-json-file"), "utf8");
  const credential = await jsonRequest("/credentials/codex/import", {
    ref: required(args, "ref"),
    authJson
  });
  console.log(JSON.stringify(credential, null, 2));
}

export async function importGithubCredentialCommand(argv: string[]) {
  const args = parseArgs(argv);
  const token = await readFile(required(args, "token-file"), "utf8");
  const credential = await jsonRequest("/credentials/github/import", {
    ref: required(args, "ref"),
    token
  });
  console.log(JSON.stringify(credential, null, 2));
}

export async function createDraftPrCommand(argv: string[]) {
  const args = parseArgs(argv);
  const runId = optional(args, "run-id") ?? args._[0];
  if (runId === undefined) {
    throw new Error("usage: tanren run draft-pr --run-id <run_id>");
  }
  const draftPr = await jsonRequest(`/runs/${runId}/github/draft-pr`, {
    githubCredentialRef: optional(args, "github-credential-ref"),
    workspacePath: optional(args, "workspace-path"),
    title: optional(args, "title"),
    body: optional(args, "body")
  });
  console.log(JSON.stringify(draftPr, null, 2));
}

export async function pollCiCommand(argv: string[]) {
  const args = parseArgs(argv);
  const runId = optional(args, "run-id") ?? args._[0];
  if (runId === undefined) {
    throw new Error("usage: tanren run poll-ci --run-id <run_id>");
  }
  const ci = await jsonRequest(`/runs/${runId}/ci/poll`, {
    githubCredentialRef: optional(args, "github-credential-ref")
  });
  console.log(JSON.stringify(ci, null, 2));
}

export function usage() {
  console.log(`tanren <command>

Commands:
  doctor             Check orchestrator, Postgres, and Vault connectivity
  credential codex import --ref <ref> --auth-json-file <path>
  credential github import --ref <ref> --token-file <path>
  hello              Trigger a fake hello-world workflow run
  project create     Create a persisted project contract
  run draft-pr       Push a runner workspace branch and open/reuse a draft PR
  run poll-ci        Poll and persist pull request CI status for a run
  spec create        Create a persisted spec contract
  spec run           Create a queued run from a persisted spec
  status <run_id>    Print persisted run state
  dashboard          Print the dashboard URL
  version            Print CLI version
`);
}

export async function main(argv: string[]) {
  const [command, subcommand, ...rest] = argv;
  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "hello":
      await hello();
      break;
    case "project":
      if (subcommand !== "create") {
        throw new Error("usage: tanren project create --name <name> --repo-url <url>");
      }
      await createProjectCommand(rest);
      break;
    case "spec":
      if (subcommand === "create") {
        await createSpecCommand(rest);
        break;
      }
      if (subcommand === "run") {
        await runSpecCommand(rest);
        break;
      }
      throw new Error("usage: tanren spec <create|run>");
    case "credential":
      if (subcommand === "codex" && rest[0] === "import") {
        await importCodexCredentialCommand(rest.slice(1));
        break;
      }
      if (subcommand === "github" && rest[0] === "import") {
        await importGithubCredentialCommand(rest.slice(1));
        break;
      }
      throw new Error("usage: tanren credential <codex|github> import");
    case "run":
      if (subcommand === "draft-pr") {
        await createDraftPrCommand(rest);
        break;
      }
      if (subcommand === "poll-ci") {
        await pollCiCommand(rest);
        break;
      }
      throw new Error("usage: tanren run <draft-pr|poll-ci> --run-id <run_id>");
    case "status":
      await status(subcommand);
      break;
    case "dashboard":
      console.log(dashboardUrl);
      break;
    case "version":
      console.log("0.0.0");
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      usage();
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

type ParsedArgs = Record<string, string | string[] | undefined> & { _: string[] };

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    addArg(args, key, value);
    index += 1;
  }
  return args;
}

function addArg(args: ParsedArgs, key: string, value: string): void {
  const existing = args[key];
  if (existing === undefined) {
    args[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    args[key] = [existing, value];
  }
}

function required(args: ParsedArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`missing --${key}`);
  }
  return value;
}

function optional(args: ParsedArgs, key: string): string | undefined {
  const value = args[key];
  if (Array.isArray(value)) {
    throw new Error(`--${key} can only be provided once`);
  }
  return value;
}

function requiredMany(args: ParsedArgs, key: string): string[] {
  const values = optionalMany(args, key);
  if (values.length === 0) {
    throw new Error(`missing --${key}`);
  }
  return values;
}

function optionalMany(args: ParsedArgs, key: string): string[] {
  const value = args[key];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parseJsonObject(raw: string, flag: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`--${flag} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
