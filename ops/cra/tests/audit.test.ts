import { describe, expect, it, vi } from "vitest";
import { AuditAdapter, ModelUnreachableError } from "../src/auditAdapter.js";
import { AuditReportInvalidError, AuditReportMismatchError, parseAuditReport } from "../src/auditReport.js";
import type { CommandExecutor } from "../src/process.js";
import { firstSha, secondSha, testConfig } from "./helpers.js";
import { acceptingRunner, auditContext, rejectingRunner, validReport, verifiedWorktree } from "./auditFixtures.js";

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
  it("validates a well-formed report and confirms an executed negative control", async () => {
    const executor = workerExecutor(JSON.stringify(validReport()));
    const verified = await new AuditAdapter(testConfig(), rejectingRunner, executor).audit(
      auditContext(),
      verifiedWorktree(),
    );
    expect(verified.controlVerifications).toEqual([
      { id: "malformed-report", mandatory: true, confirmed: true, detail: "control rejected with exit 1" },
    ]);
    expect(verified.independence.confirmed).toBe(true);
  });

  it("passes the audit context on stdin and strips the GitHub token from the worker env", async () => {
    const executor = vi.fn<CommandExecutor>().mockResolvedValue({
      stdout: JSON.stringify(validReport()),
      stderr: "",
      exitCode: 0,
    });
    process.env["GH_TOKEN"] = "must-not-leak";
    try {
      await new AuditAdapter(testConfig(), rejectingRunner, executor).audit(auditContext(), verifiedWorktree());
    } finally {
      delete process.env["GH_TOKEN"];
    }
    const request = executor.mock.calls[0]?.[0];
    expect(request?.command).toBe("cra-audit-worker");
    expect(request?.input).toContain("acceptanceTraces");
    expect(request?.env?.["GH_TOKEN"]).toBeUndefined();
    expect(request?.env?.["GITHUB_TOKEN"]).toBeUndefined();
  });

  it("does NOT confirm a negative control whose boundary accepts a bad input (exit 0)", async () => {
    const executor = workerExecutor(JSON.stringify(validReport()));
    const verified = await new AuditAdapter(testConfig(), acceptingRunner, executor).audit(
      auditContext(),
      verifiedWorktree(),
    );
    expect(verified.controlVerifications[0]?.confirmed).toBe(false);
  });

  it("fails closed on a non-JSON worker response", async () => {
    const executor = workerExecutor("not json at all");
    await expect(
      new AuditAdapter(testConfig(), rejectingRunner, executor).audit(auditContext(), verifiedWorktree()),
    ).rejects.toThrow(ModelUnreachableError);
  });

  it("fails closed when the worker exits non-zero (unreachable model)", async () => {
    const executor = workerExecutor("", 1);
    await expect(
      new AuditAdapter(testConfig(), rejectingRunner, executor).audit(auditContext(), verifiedWorktree()),
    ).rejects.toThrow(ModelUnreachableError);
  });

  it("flags a same-family audit worker as non-independent", async () => {
    const executor = workerExecutor(JSON.stringify(validReport()));
    const verified = await new AuditAdapter(
      testConfig({ audit: { ...testConfig().audit, modelFamily: "codex" } }),
      rejectingRunner,
      executor,
    ).audit(auditContext({ authorModelFamily: "codex" }), verifiedWorktree());
    expect(verified.independence.confirmed).toBe(false);
  });

  it("flags unknown provenance on an agent-authored PR as unconfirmable independence", async () => {
    const executor = workerExecutor(JSON.stringify(validReport()));
    const verified = await new AuditAdapter(testConfig(), rejectingRunner, executor).audit(
      auditContext({ authorIsAgent: true, authorModelFamily: null }),
      verifiedWorktree(),
    );
    expect(verified.independence.confirmed).toBe(false);
  });
});
