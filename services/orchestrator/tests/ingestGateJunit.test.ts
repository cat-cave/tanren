// NATIVE PER-TEST INGEST (the no-Actions delivery model). The native gate reads the
// runner's JUnit report over SSH after it runs and ingests the per-test rows IN-PROCESS
// — no webhook, no HMAC. These prove: a present report is parsed + ingested under the
// run's org; the gate verdict drives the test-step exit-code guard; and — the
// NO-SILENT-FALLBACK discipline — an absent report is DISCRIMINATED: a clean QUIET no-op
// when no junit-writing test step ran (`expectReport=false`), but a LOUD `missing_expected`
// signal when a test step that writes the report actually ran (`expectReport=true`) yet
// produced nothing (absent / read-failed / empty) — flaky-intelligence went blind.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { ingestGateJunit } from "../src/engine/workflow/gate/ingestGateJunit.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";

const TARGET: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "fp",
  identitySecretRef: "id",
};

const JUNIT_XML = `<?xml version="1.0"?>
<testsuites name="vitest" tests="2" failures="1">
  <testsuite name="src/math.test.ts" tests="2">
    <testcase classname="add" name="adds" time="0.01" file="src/math.test.ts"/>
    <testcase classname="add" name="fails" time="0.02" file="src/math.test.ts">
      <failure message="boom">AssertionError</failure>
    </testcase>
  </testsuite>
</testsuites>`;

// The marker the read command echoes when the report file does not exist (so the
// ingest distinguishes a genuinely-absent file from an empty/unreadable one).
const ABSENT_MARKER = "__TANREN_JUNIT_ABSENT__";

// `absent` = file not found (the read command echoes the marker); `empty` = file
// exists but whitespace-only; `read_failed` = the SSH read itself failed (transport).
type ReportState = { kind: "present"; xml: string } | { kind: "absent" } | { kind: "empty" } | { kind: "read_failed" };

/** An SSH that models the file-presence branch of the gate's `cat`-or-marker read. */
class JunitSsh implements CommandSubstrate {
  constructor(private readonly state: ReportState) {}
  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    if (!command.command.includes("reports/junit.xml")) {
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    }
    switch (this.state.kind) {
      case "present":
        return { exitCode: 0, stdout: this.state.xml, stderr: "", timedOut: false };
      case "absent":
        // The read succeeds but the `else echo` branch ran (file not found).
        return { exitCode: 0, stdout: `${ABSENT_MARKER}\n`, stderr: "", timedOut: false };
      case "empty":
        // The file exists and was `cat`'d, but it is whitespace-only.
        return { exitCode: 0, stdout: "   \n", stderr: "", timedOut: false };
      case "read_failed":
        // The read itself failed — a nonzero exit (a transport/runner problem).
        return { exitCode: 1, stdout: "", stderr: "ssh: broken pipe", timedOut: false };
    }
  }
}

/** A fake client recording the per-test INSERTs + the events append. */
class RecordingClient {
  readonly inserts: unknown[][] = [];
  readonly events: string[] = [];
  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql.trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("NOTIFY")
    ) {
      return { rows: [], rowCount: 0 };
    }
    if (text.startsWith("INSERT INTO ci_test_results")) {
      this.inserts.push(params);
      return { rows: [], rowCount: 1 };
    }
    // The PgEventStore append (the `event_type` column marks it as the events write).
    if (text.startsWith("INSERT INTO") && text.includes("event_type")) {
      this.events.push(String(params[4] ?? ""));
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

function deps(ssh: CommandSubstrate, client: RecordingClient, expectReport: boolean, tier = "slow") {
  return {
    ssh,
    target: TARGET,
    workspacePath: "/ws",
    client: client as unknown as Pick<pg.Pool | pg.PoolClient, "query">,
    runId: "run_1",
    projectId: "proj_1",
    orgId: "org_1",
    headSha: "a".repeat(40),
    timeoutMs: 1000,
    gatePassed: false,
    expectReport,
    tier,
    // The DECLARED report path is read back ONLY when a report is expected; absent ⇒
    // the ingest skips the read entirely (the clean no-op). Mirror that here.
    ...(expectReport ? { reportPath: "reports/junit.xml" } : {}),
  };
}

describe("ingestGateJunit — native in-process per-test ingest", () => {
  it("parses + ingests the runner's JUnit report under the run's org", async () => {
    const client = new RecordingClient();
    const result = await ingestGateJunit(deps(new JunitSsh({ kind: "present", xml: JUNIT_XML }), client, true));
    expect(result).toEqual({ kind: "ingested", inserted: 2 });
    // Two per-test rows persisted, org-stamped (org_id is param $3).
    expect(client.inserts).toHaveLength(2);
    expect(client.inserts.every((p) => p[2] === "org_1")).toBe(true);
    // A `ci.tests.reported` summary event was emitted in-process.
    expect(client.events).toContain("ci.tests.reported");
  });

  it("expectReport=false + absent report → a QUIET no-op (no junit-writing test step ran)", async () => {
    const client = new RecordingClient();
    const result = await ingestGateJunit(deps(new JunitSsh({ kind: "absent" }), client, false));
    // No grain expected (e.g. the scaffold fast tier = lint+typecheck) ⇒ skipped, quiet.
    expect(result).toEqual({ kind: "skipped_no_test_step" });
    expect(client.inserts).toHaveLength(0);
    expect(client.events).toHaveLength(0);
  });

  it("expectReport=true + absent report → LOUD missing_expected(absent) (flaky-intelligence blind)", async () => {
    const client = new RecordingClient();
    const result = await ingestGateJunit(deps(new JunitSsh({ kind: "absent" }), client, true));
    expect(result).toEqual({ kind: "missing_expected", reason: "absent" });
    expect(client.inserts).toHaveLength(0);
  });

  it("expectReport=true + empty report → LOUD missing_expected(empty)", async () => {
    const client = new RecordingClient();
    const result = await ingestGateJunit(deps(new JunitSsh({ kind: "empty" }), client, true));
    expect(result).toEqual({ kind: "missing_expected", reason: "empty" });
    expect(client.inserts).toHaveLength(0);
  });

  it("expectReport=true + a failed SSH read → LOUD missing_expected(read_failed), distinct from absent", async () => {
    const client = new RecordingClient();
    const result = await ingestGateJunit(deps(new JunitSsh({ kind: "read_failed" }), client, true));
    expect(result).toEqual({ kind: "missing_expected", reason: "read_failed" });
    expect(client.inserts).toHaveLength(0);
  });
});
