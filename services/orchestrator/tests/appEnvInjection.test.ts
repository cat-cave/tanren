// Plane B run-workspace injection coverage: the building agent's gate commands run
// WITH the project's dev+test app env in scope (materialized over the runner), the
// emitted gate.* events do NOT carry the secret value, and Tanren's own provider
// creds never reach the app env. Also covers the pure prelude builder.

import { describe, expect, it } from "vitest";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import { runGateTier } from "../src/engine/workflow/gate/runGateTier.js";
import { buildAppEnvPrelude, withAppEnv } from "../src/engine/workflow/appEnvPrelude.js";

const target: SshTarget = { host: "h", port: 22, username: "u", hostKeyFingerprint: "fp" };

class RecordingSsh implements SshSubstrate {
  readonly commands: SshCommand[] = [];
  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
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

  it("injects ONLY the project app env — never Tanren's own provider creds", async () => {
    const ssh = new RecordingSsh();
    const { appendEvent } = recordingEvents();
    // The app env is the project's secrets only. Tanren's creds (a github token,
    // codex cred ref) are NOT part of appEnv and must not appear in the command.
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
    expect(executed).not.toContain("GITHUB_TOKEN");
    expect(executed).not.toContain("CODEX");
    expect(executed).not.toContain("x-access-token");
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
