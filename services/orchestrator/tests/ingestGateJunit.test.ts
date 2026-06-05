// NATIVE PER-TEST INGEST (the no-Actions delivery model). The native gate reads the
// runner's JUnit report over SSH after it runs and ingests the per-test rows IN-PROCESS
// — no webhook, no HMAC. These prove: a present report is parsed + ingested under the
// run's org; an ABSENT report is a clean no-op (a repo that emits no JUnit simply has no
// per-test grain); and the gate verdict drives the test-step exit-code guard.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { ingestGateJunit } from "../src/engine/workflow/gate/ingestGateJunit.js";
import type { SshTarget } from "../src/engine/contracts/allocator.js";
import type { SshCommand, SshCommandResult, SshSubstrate } from "../src/engine/contracts/sshSubstrate.js";

const TARGET: SshTarget = {
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

/** An SSH that serves the JUnit report when the gate cats the conventional path. */
class JunitSsh implements SshSubstrate {
  constructor(private readonly xml: string | undefined) {}
  async run(_target: SshTarget, command: SshCommand): Promise<SshCommandResult> {
    if (command.command.includes("reports/junit.xml")) {
      return { exitCode: 0, stdout: this.xml ?? "", stderr: "", timedOut: false };
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
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

function deps(ssh: SshSubstrate, client: RecordingClient) {
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
  };
}

describe("ingestGateJunit — native in-process per-test ingest", () => {
  it("parses + ingests the runner's JUnit report under the run's org", async () => {
    const client = new RecordingClient();
    const inserted = await ingestGateJunit(deps(new JunitSsh(JUNIT_XML), client));
    expect(inserted).toBe(2);
    // Two per-test rows persisted, org-stamped (org_id is param $3).
    expect(client.inserts).toHaveLength(2);
    expect(client.inserts.every((p) => p[2] === "org_1")).toBe(true);
    // A `ci.tests.reported` summary event was emitted in-process.
    expect(client.events).toContain("ci.tests.reported");
  });

  it("is a clean no-op when the repo emits no JUnit report (absent file)", async () => {
    const client = new RecordingClient();
    const inserted = await ingestGateJunit(deps(new JunitSsh(undefined), client));
    expect(inserted).toBe(0);
    expect(client.inserts).toHaveLength(0);
    expect(client.events).toHaveLength(0);
  });
});
