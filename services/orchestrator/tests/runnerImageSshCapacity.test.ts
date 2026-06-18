// Dockerfile-inventory assertion: the runner image raises sshd's concurrency limits.
// Tanren's per-spec loop opens MANY concurrent SSH/codex sessions to one single-tenant
// runner (writer + checker + auditor + designOracle + triage + convergence + planner,
// plus the design-phase codex calls). The stock sshd ships `#MaxSessions 10` and
// `#MaxStartups 10:30:100` (the commented defaults), which throttle that fan-out and
// surface as transient `ssh.run.failed` connect failures (v41 finding: ~9/hour). This
// pins the capacity raise so the throttle can't silently regress back to the defaults.
// These are SERVER concurrency limits — NOT a client-side timeout/retry cap.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(fileURLToPath(new URL("../../../runner/Dockerfile", import.meta.url)), "utf8");

describe("runner image — sshd concurrency capacity", () => {
  it("raises MaxSessions well above the stock default of 10", () => {
    expect(dockerfile).toContain("MaxSessions 200");
  });

  it("raises MaxStartups well above the stock default of 10:30:100", () => {
    expect(dockerfile).toContain("MaxStartups 200:30:400");
  });

  it("sets a keepalive that detects a dead connection without killing a live one", () => {
    // ClientAliveInterval probes the peer; a generous CountMax means a busy, live session
    // is never torn down on a timer — only a genuinely dead connection is reaped.
    expect(dockerfile).toContain("ClientAliveInterval 60");
    expect(dockerfile).toContain("ClientAliveCountMax 1440");
  });

  it("validates the sshd config at build time so a bad directive fails the image build", () => {
    expect(dockerfile).toContain("sshd -t -f /etc/ssh/sshd_config");
  });
});
