import { describe, expect, it, vi } from "vitest";
import { AuditAdapter, ModelUnreachableError, type IsolatedControlRunner } from "../src/auditAdapter.js";
import { AuditReportInvalidError, AuditReportMismatchError, parseAuditReport } from "../src/auditReport.js";
import type { CommandExecutor, CommandResult } from "../src/process.js";
import type { IsolatedCommand } from "../src/isolatedRunner.js";
import type { VerifiedWorktree } from "../src/worktree.js";
import { firstSha, secondSha, testConfig } from "./helpers.js";
import { auditContext, failingRunner, passingRunner, validReport, verifiedWorktree } from "./auditFixtures.js";

function workerExecutor(stdout: string, exitCode = 0): CommandExecutor {
  return async () => ({ stdout, stderr: "", exitCode });
}

const expected = { headSha: firstSha, baseSha: secondSha, rubricVersion: "2026-07-22" };

describe("strict audit report validation", () => {
  it("accepts a well-formed report", () => {
    expect(parseAuditReport(validReport(), expected)).toMatchObject({ headSha: firstSha });
  });

  it("rejects a report missing acceptance traces", () => {
    const raw = validReport();
    const broken = { ...raw, acceptanceTraces: [] };
    expect(() => parseAuditReport(broken, expected)).toThrow(AuditReportInvalidError);
  });

  it("rejects a report with no deletion accounting key", () => {
    const raw: Record<string, unknown> = { ...validReport() };
    delete raw["deletionAccounting"];
    expect(() => parseAuditReport(raw, expected)).toThrow(AuditReportInvalidError);
  });

  it("rejects a report with no executed negative control", () => {
    const raw = validReport({
      negativeControls: [
        {
          id: "inspect-only",
          description: "static",
          mandatory: true,
          kind: "inspected",
          command: null,
          expectedRejection: "n/a",
          observedResult: "read code",
          rejected: true,
          evidenceRef: "worker.log",
        },
      ],
    });
    expect(() => parseAuditReport(raw, expected)).toThrow(AuditReportInvalidError);
  });

  it("rejects a report whose head does not match the audited head", () => {
    const raw = validReport({ headSha: secondSha });
    expect(() => parseAuditReport(raw, expected)).toThrow(AuditReportMismatchError);
  });
});

describe("cross-model audit adapter", () => {
  it("validates the advisory report and records the supervisor's trusted verification", async () => {
    const executor = workerExecutor(JSON.stringify(validReport()));
    const verified = await new AuditAdapter(testConfig(), passingRunner, executor).audit(
      auditContext(),
      verifiedWorktree(),
    );
    expect(verified.sandbox).toMatchObject({ ran: true, passed: true });
    expect(verified.independence.confirmed).toBe(true);
  });

  it("runs ONLY the config-sourced verification command in the sandbox — never a worker-supplied control command (the env-false break)", async () => {
    // The worker supplies a spoofable control command `env false` that would exit 1.
    // Under the redesigned trust boundary the supervisor never runs worker commands,
    // so it can never be tricked into 'confirming' via a wrapper like `env`.
    const report = validReport({
      negativeControls: [
        {
          id: "spoof",
          description: "env-false wrapper that dodges the basename allowlist",
          mandatory: true,
          kind: "executed",
          command: { executable: "env", args: ["false"] },
          expectedRejection: "non-zero exit",
          observedResult: "exit 1",
          rejected: true,
          evidenceRef: "worker.log",
        },
      ],
    });
    const calls: IsolatedCommand[] = [];
    const spyRunner: IsolatedControlRunner = {
      run: async (_worktree: VerifiedWorktree, command: IsolatedCommand): Promise<CommandResult> => {
        calls.push(command);
        return { stdout: "ok", stderr: "", exitCode: 0 };
      },
    };
    await new AuditAdapter(testConfig(), spyRunner, workerExecutor(JSON.stringify(report))).audit(
      auditContext(),
      verifiedWorktree(),
    );
    // Exactly one sandbox execution, and it is the trusted verification command.
    expect(calls).toEqual([{ executable: "just", args: ["fast-check"] }]);
    expect(calls.some((c) => c.executable === "env")).toBe(false);
  });

  it("passes the audit context on stdin and strips the GitHub token from the worker env", async () => {
    const executor = vi.fn<CommandExecutor>().mockResolvedValue({
      stdout: JSON.stringify(validReport()),
      stderr: "",
      exitCode: 0,
    });
    process.env["GH_TOKEN"] = "must-not-leak";
    try {
      await new AuditAdapter(testConfig(), passingRunner, executor).audit(auditContext(), verifiedWorktree());
    } finally {
      delete process.env["GH_TOKEN"];
    }
    const request = executor.mock.calls[0]?.[0];
    expect(request?.command).toBe("cra-audit-worker");
    expect(request?.input).toContain("acceptanceTraces");
    expect(request?.env?.["GH_TOKEN"]).toBeUndefined();
    expect(request?.env?.["GITHUB_TOKEN"]).toBeUndefined();
  });

  it("records sandbox.ran=false when the trusted verification cannot run", async () => {
    const throwingRunner: IsolatedControlRunner = {
      run: async (): Promise<CommandResult> => {
        throw new Error("container failed to start");
      },
    };
    const verified = await new AuditAdapter(
      testConfig(),
      throwingRunner,
      workerExecutor(JSON.stringify(validReport())),
    ).audit(auditContext(), verifiedWorktree());
    expect(verified.sandbox).toMatchObject({ ran: false, passed: false });
  });

  it("records sandbox.passed=false when the trusted verification fails on the PR head", async () => {
    const verified = await new AuditAdapter(
      testConfig(),
      failingRunner,
      workerExecutor(JSON.stringify(validReport())),
    ).audit(auditContext(), verifiedWorktree());
    expect(verified.sandbox).toMatchObject({ ran: true, passed: false });
  });

  it("rejects a vacuous/no-op verification command (`true`) as unrun — never a vacuous pass", async () => {
    const calls: IsolatedCommand[] = [];
    const spyRunner: IsolatedControlRunner = {
      run: async (_worktree: VerifiedWorktree, command: IsolatedCommand): Promise<CommandResult> => {
        calls.push(command);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const config = testConfig({
      audit: { ...testConfig().audit, verificationCommand: { executable: "true", args: [] } },
    });
    const verified = await new AuditAdapter(config, spyRunner, workerExecutor(JSON.stringify(validReport()))).audit(
      auditContext(),
      verifiedWorktree(),
    );
    expect(verified.sandbox).toMatchObject({ ran: false, passed: false });
    // The vacuous command is never even executed.
    expect(calls).toEqual([]);
  });

  it("fails closed on a non-JSON worker response", async () => {
    const executor = workerExecutor("not json at all");
    await expect(
      new AuditAdapter(testConfig(), passingRunner, executor).audit(auditContext(), verifiedWorktree()),
    ).rejects.toThrow(ModelUnreachableError);
  });

  it("fails closed when the worker exits non-zero (unreachable model)", async () => {
    const executor = workerExecutor("", 1);
    await expect(
      new AuditAdapter(testConfig(), passingRunner, executor).audit(auditContext(), verifiedWorktree()),
    ).rejects.toThrow(ModelUnreachableError);
  });

  it("flags a same-family audit worker as non-independent", async () => {
    const executor = workerExecutor(JSON.stringify(validReport()));
    const verified = await new AuditAdapter(
      testConfig({ audit: { ...testConfig().audit, modelFamily: "codex" } }),
      passingRunner,
      executor,
    ).audit(auditContext({ authorModelFamily: "codex" }), verifiedWorktree());
    expect(verified.independence.confirmed).toBe(false);
  });

  it("flags unknown provenance on an agent-authored PR as unconfirmable independence", async () => {
    const executor = workerExecutor(JSON.stringify(validReport()));
    const verified = await new AuditAdapter(testConfig(), passingRunner, executor).audit(
      auditContext({ authorIsAgent: true, authorModelFamily: null }),
      verifiedWorktree(),
    );
    expect(verified.independence.confirmed).toBe(false);
  });
});
