// Plane B run-workspace injection coverage: the building agent's gate commands run
// WITH the project's dev+test app env in scope (materialized over the runner), the
// emitted gate.* events do NOT carry the secret value, and Tanren's own provider
// creds never reach the app env. Also covers the pure prelude builder.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { runGateTier } from "../src/engine/workflow/gate/runGateTier.js";
import { buildAppEnvPrelude, withAppEnv } from "../src/engine/ssh/appEnvPrelude.js";
import { bootstrapWorkspace, WorkspaceBootstrapError } from "../src/engine/workspace/index.js";
import { finalizeWorkflowError } from "../src/engine/workflow/plannerRunFinalize.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { systemActor } from "../src/engine/state/actor.js";
import { AppEnvironmentStore } from "../src/engine/repositories/appEnvironment.js";
import { resolveAppEnvForScope } from "../src/engine/workflow/resolveAppEnv.js";

const target: RunnerHandle = { host: "h", port: 22, username: "u", hostKeyFingerprint: "fp" };

class RecordingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

function recordingEvents() {
  const events: { eventType: EventName; payload: unknown }[] = [];
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>) => {
    events.push({ eventType, payload });
  };
  return { events, appendEvent };
}

describe("buildAppEnvPrelude", () => {
  it("emits a sorted, single-quote-escaped export prelude", () => {
    const prelude = buildAppEnvPrelude({ B_KEY: "two", A_KEY: "o'ne" });
    // Sorted: A_KEY before B_KEY; the quote in the value is escaped.
    expect(prelude).toBe("export A_KEY='o'\\''ne'; export B_KEY='two'; ");
  });

  it("an empty env yields no prelude (command unchanged)", () => {
    expect(buildAppEnvPrelude({})).toBe("");
    expect(withAppEnv("pnpm test", {})).toBe("pnpm test");
    const noEnv: Record<string, string> | undefined = undefined;
    expect(withAppEnv("pnpm test", noEnv)).toBe("pnpm test");
  });

  it("rejects an env key that is not a valid shell identifier (no shell injection)", () => {
    expect(() => buildAppEnvPrelude({ "BAD;rm -rf": "x" })).toThrow(/invalid app-env key/u);
  });
});

describe("run-workspace app-env injection (gate)", () => {
  const appEnv = { RESEND_API_KEY: "re_secret_value", PUBLIC_URL: "https://app.example" };

  it("materializes dev+test app env into the EXECUTED command the agent runs", async () => {
    const ssh = new RecordingSsh();
    const { appendEvent } = recordingEvents();
    await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [{ name: "test", run: "pnpm test" }],
      timeoutMs: 1000,
      appendEvent,
      appEnv,
    });
    const executed = ssh.commands[0]?.command ?? "";
    // The app env reaches the building agent's command environment.
    expect(executed).toContain("export RESEND_API_KEY='re_secret_value'");
    expect(executed).toContain("export PUBLIC_URL='https://app.example'");
    expect(executed.endsWith("pnpm test")).toBe(true);
  });

  it("does NOT leak the secret VALUE into the emitted gate.* events (step.run stays original)", async () => {
    const ssh = new RecordingSsh();
    const { events, appendEvent } = recordingEvents();
    await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [{ name: "test", run: "pnpm test" }],
      timeoutMs: 1000,
      appendEvent,
      appEnv,
    });
    // The serialized event stream must not contain the secret value.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("re_secret_value");
    // The recorded step.run is the ORIGINAL command (no prelude).
    const passed = events.find((e) => e.eventType === "gate.passed");
    expect(JSON.stringify(passed)).toContain("pnpm test");
    expect(JSON.stringify(passed)).not.toContain("export RESEND_API_KEY");
  });

  it("without an app env the command is unchanged (behavior-identical to before)", async () => {
    const ssh = new RecordingSsh();
    const { appendEvent } = recordingEvents();
    await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "per_iteration",
      steps: [{ name: "test", run: "pnpm test" }],
      timeoutMs: 1000,
      appendEvent,
    });
    expect(ssh.commands[0]?.command).toBe("pnpm test");
  });
});

// MUST-FIX (PR #242 adversarial review): the BOOTSTRAP path previously folded the
// app-env prelude into the COMMAND STRING, so a bootstrap FAILURE embedded the
// secret value into WorkspaceBootstrapError.message → the `workspace.failed` AND
// `run.failed` event payloads (two persisted events). These cover the now-fixed
// substrate-boundary injection: the executed command carries the prelude, but the
// error message (the single source feeding BOTH events) never does.
describe("run-workspace app-env injection (bootstrap failure path)", () => {
  const SECRET = "re_secret_value";
  const appEnv = { RESEND_API_KEY: SECRET };
  const workspacePath = "/ws";

  // An SSH that returns a scripted failing result (exit 1) and records what ran.
  class FailingSsh implements CommandSubstrate {
    readonly commands: RunnerCommand[] = [];
    async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
      this.commands.push(command);
      // The failing command echoes nothing of the env (a realistic install error);
      // the leak under test is the COMMAND STRING in the error message, not stderr.
      return { exitCode: 1, stdout: "resolving", stderr: "ERR install failed", timedOut: false };
    }
  }

  it("materializes the app env into the EXECUTED bootstrap command", async () => {
    const ssh = new FailingSsh();
    await bootstrapWorkspace({ ssh, target, workspacePath, command: "pnpm install", appEnv, timeoutMs: 100 }).catch(
      (caught: unknown) => caught,
    );
    const executed = ssh.commands[0]?.command ?? "";
    expect(executed).toContain("export RESEND_API_KEY='re_secret_value'");
    expect(executed.endsWith("pnpm install")).toBe(true);
  });

  it("WorkspaceBootstrapError carries the ORIGINAL command + message — NO app-secret value", async () => {
    const ssh = new FailingSsh();
    const error = await bootstrapWorkspace({
      ssh,
      target,
      workspacePath,
      command: "pnpm install",
      appEnv,
      timeoutMs: 100,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceBootstrapError);
    const typed = error as WorkspaceBootstrapError;
    // The error's command field is the original (prelude-free) command.
    expect(typed.command).toBe("pnpm install");
    expect(typed.command).not.toContain("export");
    // The message — which feeds BOTH `workspace.failed` and `run.failed` — never
    // carries the secret value or the export prelude.
    expect(typed.message).not.toContain(SECRET);
    expect(typed.message).not.toContain("export RESEND_API_KEY");
    expect(typed.message).toContain("pnpm install");
  });

  it("the secret VALUE appears in NEITHER the workspace.failed NOR the run.failed event", async () => {
    const ssh = new FailingSsh();
    const error = await bootstrapWorkspace({
      ssh,
      target,
      workspacePath,
      command: "pnpm install",
      appEnv,
      timeoutMs: 100,
    }).catch((caught: unknown) => caught);

    // Drive the REAL workflow error finalizer: it emits `workspace.failed` with
    // `{ message: error.message }` (the same string the worker writes to
    // `run.failed` via messageOf(error)). Capture every emitted event payload.
    const events: { eventType: EventName; payload: unknown }[] = [];
    const finalizedStates: string[] = [];
    await finalizeWorkflowError(error, {
      finalizeRunState: async (status: string) => {
        finalizedStates.push(status);
      },
      appendEvent: async <N extends EventName>(eventType: N, payload: EventPayload<N>) => {
        events.push({ eventType, payload });
      },
      runId: "run_x",
      workspacePath,
    });

    // A bootstrap failure is recoverable → the run is finalized `halted`.
    expect(finalizedStates).toContain("halted");

    const workspaceFailed = events.find((e) => e.eventType === "workspace.failed");
    expect(workspaceFailed).toBeDefined();
    // workspace.failed payload: no secret value.
    expect(JSON.stringify(workspaceFailed)).not.toContain(SECRET);
    // The worker writes `run.failed { message: messageOf(error) }` === error.message;
    // proving error.message is clean proves the run.failed payload is clean too.
    expect((error as WorkspaceBootstrapError).message).not.toContain(SECRET);
  });
});

// MUST-FIX (PR #242 adversarial review): strengthen the plane-crossing proof. The
// previous test only asserted absence of strings the test never added. This drives
// the REAL resolution path and proves it pulls EXCLUSIVELY from `project_app_env`,
// so a Tanren credential sitting in the SAME secret store can NEVER be returned.
describe("plane isolation — resolveAppEnvForScope reads only project_app_env", () => {
  // A single-project in-memory pg target for the app-env table (no RLS modeling
  // needed here — the repo conformance covers RLS).
  class AppEnvDb {
    readonly rows: Record<string, unknown>[] = [];
    async query(
      rawSql: string,
      params: readonly unknown[] = [],
    ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
      const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
      if (/INSERT INTO project_app_env/u.test(sql)) {
        const [id, projectId, key, valueRef, plainValue, scopes, source, description] = params as [
          string,
          string,
          string,
          string | null,
          string | null,
          string[],
          string,
          string,
        ];
        const row = {
          id,
          project_id: projectId,
          key,
          value_ref: valueRef,
          plain_value: plainValue,
          scopes,
          source,
          description,
        };
        this.rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (/^SELECT .* FROM project_app_env WHERE project_id = \$1/u.test(sql)) {
        const [projectId] = params as [string];
        const rows = this.rows.filter((r) => r["project_id"] === projectId);
        return { rows, rowCount: rows.length };
      }
      throw new Error(`AppEnvDb: unrecognized SQL: ${sql}`);
    }
  }

  it("returns ONLY the app-env entry — never a Tanren credential in the same secret store", async () => {
    const db = new AppEnvDb();
    const client = db as unknown as Pick<pg.Pool, "query">;
    // Seed a project app-env entry (the app's own secret) referencing the store.
    await AppEnvironmentStore.upsert(
      client,
      { projectId: "proj", key: "RESEND_API_KEY", valueRef: "secret://proj/resend", scopes: ["test"] },
      systemActor,
    );

    const secrets = new FakeSecretStore();
    // The app's secret.
    await secrets.put({ ref: "secret://proj/resend", value: "re_app_value" });
    // A TANREN credential sitting in the SAME store — a github App key, a codex
    // token — under DIFFERENT refs that no project_app_env row points at.
    await secrets.put({ ref: "secret://org/github-app-key", value: "tanren_github_secret" });
    await secrets.put({ ref: "secret://org/codex-token", value: "tanren_codex_secret" });

    const resolved = await resolveAppEnvForScope({
      client,
      secrets,
      projectId: "proj",
      scope: "test",
      actor: systemActor,
    });

    // Structurally only the project_app_env-referenced secret is materialized:
    // resolution reads the project's app-env ROWS and resolves only THOSE refs, so
    // a Tanren credential under an unreferenced ref cannot appear.
    expect(resolved).toEqual({ RESEND_API_KEY: "re_app_value" });
    const serialized = JSON.stringify(resolved);
    expect(serialized).not.toContain("tanren_github_secret");
    expect(serialized).not.toContain("tanren_codex_secret");
  });
});
