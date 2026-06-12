// CI-intelligence PR2 — the PRODUCTION quarantine loader + the env actuation + the
// gate-tier exclusion (`engine/workflow/ciQuarantine.ts` + `gate/runGateTier.ts`).
// Proves: `loadActiveQuarantine` returns the project's ACTIVE rows (cleared rows +
// other projects excluded), projected into the check-name set (verdict/observation
// exclusion) + the test-id list (env filter); `quarantineEnv` builds the stack-
// agnostic `TANREN_QUARANTINE` env entry (no-op when empty); and a quarantined gate
// STEP's failure is EXCLUDED from the verdict (the loop-closing actuation) while a
// non-quarantined failure still blocks. In-memory pg + recording-SSH — TEST FIXTURES.

import { describe, expect, it } from "vitest";
import { loadActiveQuarantine, QUARANTINE_ENV_VAR, quarantineEnv } from "../src/engine/workflow/ciQuarantine.js";
import { runGateTier } from "../src/engine/workflow/gate/runGateTier.js";
import { withMiseActivation } from "../src/engine/ssh/miseActivate.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import type { EventName, EventPayload } from "../src/engine/events/index.js";

interface Row {
  project_id: string;
  check_name: string;
  test_id: string | null;
  cleared_at: Date | null;
}

/** Minimal pg substitute for the active-quarantine SELECT. TEST FIXTURE. */
class QuarantineDb {
  constructor(private readonly rows: Row[]) {}
  async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<{ rows: unknown[]; rowCount: number }> {
    // The loader must read the active-quarantine surface, scoped to cleared_at IS NULL.
    if (!sql.includes("FROM quarantined_tests") || !sql.includes("cleared_at IS NULL")) {
      throw new Error(`unexpected query: ${sql}`);
    }
    const projectId = String(params[0]);
    const rows = this.rows
      .filter((r) => r.project_id === projectId && r.cleared_at === null)
      .map((r) => ({ check_name: r.check_name, test_id: r.test_id }));
    return { rows, rowCount: rows.length };
  }
}

describe("loadActiveQuarantine — the production loader", () => {
  it("returns the active check names + test ids for the project, excluding cleared + other-project rows", async () => {
    const db = new QuarantineDb([
      { project_id: "p1", check_name: "unit", test_id: null, cleared_at: null },
      { project_id: "p1", check_name: "e2e", test_id: "e2e/login.spec#flaky", cleared_at: null },
      // cleared → excluded
      { project_id: "p1", check_name: "old", test_id: null, cleared_at: new Date() },
      // other project → excluded (RLS would also deny; the query also scopes by project)
      { project_id: "p2", check_name: "other", test_id: null, cleared_at: null },
    ]);

    const active = await loadActiveQuarantine(db, "p1");
    expect([...active.checkNames].sort()).toEqual(["e2e", "unit"]);
    expect(active.testIds).toEqual(["e2e/login.spec#flaky"]);
  });

  it("returns empty sets when the project has no active quarantine", async () => {
    const db = new QuarantineDb([{ project_id: "p1", check_name: "x", test_id: null, cleared_at: new Date() }]);
    const active = await loadActiveQuarantine(db, "p1");
    expect(active.checkNames.size).toBe(0);
    expect(active.testIds).toEqual([]);
  });
});

describe("quarantineEnv — the stack-agnostic TANREN_QUARANTINE filter", () => {
  it("comma-joins the active test ids under TANREN_QUARANTINE", () => {
    const env = quarantineEnv({ checkNames: new Set(["e2e"]), testIds: ["a#1", "b#2"] });
    expect(env).toEqual({ [QUARANTINE_ENV_VAR]: "a#1,b#2" });
  });

  it("is a no-op (empty map) when nothing is quarantined", () => {
    expect(quarantineEnv({ checkNames: new Set(), testIds: [] })).toEqual({});
  });

  it("KEEPS ordinary spaces (real JUnit names have them) but drops the comma delimiter + control chars", () => {
    const env = quarantineEnv({
      checkNames: new Set(),
      testIds: ["should log in", "has,comma", "with\ttab", "ok#2"],
    });
    // "should log in" survives (spaces ok); the comma + tab ids are dropped.
    expect(env).toEqual({ [QUARANTINE_ENV_VAR]: "should log in,ok#2" });
  });
});

// ── The gate-tier exclusion: the loop-closing actuation ──────────────────────

const target: RunnerHandle = { host: "h", port: 22, username: "u", hostKeyFingerprint: "fp" };

/** Maps each command to a scripted result; unmatched commands default to exit 0. TEST FIXTURE. */
class RecordingSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly script: (command: string) => Partial<CommandResult> = () => ({})) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...this.script(command.command) };
  }
}

function recordingEvents() {
  const events: { eventType: EventName; payload: unknown }[] = [];
  const appendEvent = async <N extends EventName>(eventType: N, payload: EventPayload<N>) => {
    events.push({ eventType, payload });
  };
  return { events, appendEvent };
}

describe("runGateTier flaky-quarantine actuation (CLOSES the flaky→quarantine→ship loop)", () => {
  it("a QUARANTINED failing step does NOT block the gate (excluded), gate.quarantine_excluded fires + the gate passes", async () => {
    // `unit` is on the project's ACTIVE quarantine surface (proven-flaky). It FAILS, but its
    // failure is EXCLUDED — the tier keeps running and PASSES, a gate.quarantine_excluded
    // warning fires instead of gate.failed, so the merge can go green while a fix is in flight.
    const ssh = new RecordingSsh((c) => (c.endsWith("pnpm test:unit") ? { exitCode: 1, stderr: "flake boom" } : {}));
    const { events, appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "pre_merge",
      steps: [
        { name: "unit", run: "pnpm test:unit" },
        { name: "build", run: "pnpm build" },
      ],
      timeoutMs: 1000,
      appendEvent,
      quarantinedStepNames: new Set(["unit"]),
    });

    expect(result.passed).toBe(true);
    // The quarantined step did NOT short-circuit the rest — build still ran + passed.
    expect(ssh.commands.map((c) => c.command)).toEqual(
      ["pnpm test:unit", "pnpm build"].map((c) => withMiseActivation(c)),
    );
    expect(result.steps.find((s) => s.name === "unit")?.passed).toBe(false);
    expect(events.map((e) => e.eventType)).toEqual(["gate.started", "gate.quarantine_excluded", "gate.passed"]);
    const excluded = events.find((e) => e.eventType === "gate.quarantine_excluded")!.payload as {
      quarantinedStep: string;
      exitCode: number | null;
    };
    expect(excluded.quarantinedStep).toBe("unit");
    expect(excluded.exitCode).toBe(1);
  });

  it("a NON-quarantined step's failure still BLOCKS even when another step is quarantined", async () => {
    // `build` is NOT quarantined → its failure blocks (gate.failed). Quarantine narrows to the
    // proven-flaky step only; a real regression in any other step still red-gates the merge.
    const ssh = new RecordingSsh((c) => (c.endsWith("pnpm build") ? { exitCode: 1, stderr: "real break" } : {}));
    const { events, appendEvent } = recordingEvents();
    const result = await runGateTier({
      ssh,
      target,
      workspacePath: "/ws",
      tier: "fast",
      when: "pre_merge",
      steps: [
        { name: "build", run: "pnpm build" },
        { name: "unit", run: "pnpm test:unit" },
      ],
      timeoutMs: 1000,
      appendEvent,
      quarantinedStepNames: new Set(["unit"]),
    });

    expect(result.passed).toBe(false);
    if (result.passed) return;
    expect(result.failedStep).toBe("build");
    expect(events.map((e) => e.eventType)).toEqual(["gate.started", "gate.failed"]);
  });
});
