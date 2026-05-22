#!/usr/bin/env node

const orchestratorUrl = process.env.TANREN_ORCHESTRATOR_URL ?? "http://localhost:3100";
const dashboardUrl = process.env.TANREN_DASHBOARD_URL ?? "http://localhost:3000";

export async function request(path: string, init?: RequestInit) {
  const response = await fetch(`${orchestratorUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<unknown>;
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

export function usage() {
  console.log(`tanren <command>

Commands:
  doctor             Check orchestrator, Postgres, and Vault connectivity
  hello              Trigger a fake hello-world workflow run
  status <run_id>    Print persisted run state
  dashboard          Print the dashboard URL
  version            Print CLI version
`);
}

export async function main(argv: string[]) {
  const [command, arg] = argv;
  switch (command) {
    case "doctor":
      await doctor();
      break;
    case "hello":
      await hello();
      break;
    case "status":
      await status(arg);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
