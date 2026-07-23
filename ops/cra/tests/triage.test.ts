import { describe, expect, it } from "vitest";
import type { SandboxVerification, VerifiedAuditReport } from "../src/auditAdapter.js";
import type { AuditFinding } from "../src/auditReport.js";
import type { DiscoveredCheck } from "../src/discovery.js";
import { triage, type SupervisorEvidence } from "../src/triage.js";
import { firstSha, secondSha } from "./helpers.js";
import { cleanGroundTruth, knownFiles, validReport } from "./auditFixtures.js";

const passingSandbox: SandboxVerification = { ran: true, passed: true, detail: "exit 0" };

function verified(overrides: Partial<VerifiedAuditReport> = {}): VerifiedAuditReport {
  return {
    report: validReport(),
    independence: { confirmed: true, reason: "cross-model" },
    sandbox: passingSandbox,
    headSha: firstSha,
    baseSha: secondSha,
    rubricVersion: "2026-07-22",
    ...overrides,
  };
}

function groundTruth(overrides: Partial<SupervisorEvidence> = {}): SupervisorEvidence {
  return { ...cleanGroundTruth(), liveDeletionThreshold: 200, ...overrides };
}

function triageClean(v: Partial<VerifiedAuditReport> = {}, g: Partial<SupervisorEvidence> = {}) {
  return triage(verified(v), groundTruth(g));
}

function finding(overrides: Partial<AuditFinding>): AuditFinding {
  return {
    id: "f1",
    title: "finding",
    body: "body",
    category: "correctness",
    concerns: "new_work",
    suggestedSeverity: "P2",
    fixDirection: null,
    evidence: { path: null, line: null, side: null, commandRef: null, detail: "evidence" },
    ...overrides,
  };
}

function deletionDiff(path: string, deletedLines: number): string {
  const body = Array.from({ length: deletedLines }, (_, i) => `-const dead${i} = ${i};`).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`;
}

describe("supervisor P0-P3 triage — advisory findings", () => {
  it("approves a clean, fully-proved PR with no findings", () => {
    const result = triageClean();
    expect(result.verdict).toBe("APPROVE");
    expect(result.counts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
  });

  it("approves when only P2/P3 betterment findings are present", () => {
    const result = triageClean({
      report: validReport({
        findings: [finding({ suggestedSeverity: "P2" }), finding({ id: "f2", suggestedSeverity: "P3" })],
      }),
    });
    expect(result.verdict).toBe("APPROVE");
  });

  it("requests changes on a P1 fundamental implementation finding", () => {
    const result = triageClean({ report: validReport({ findings: [finding({ suggestedSeverity: "P1" })] }) });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.counts.P1).toBe(1);
  });

  it("forces an acceptance-concerning finding to P0 even when the worker suggested lower", () => {
    const result = triageClean({
      report: validReport({ findings: [finding({ concerns: "acceptance", suggestedSeverity: "P3" })] }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.find((f) => f.id === "f1")).toMatchObject({ severity: "P0", forced: true });
  });
});

describe("supervisor P0-P3 triage — ground-truth gates the worker cannot clear", () => {
  it("mq-16: worker-declared justified:true CANNOT suppress a live deletion the diff shows", () => {
    // The worker asserts the mass deletion is justified. The supervisor ignores the
    // accounting and gates on its own diff computation.
    const result = triage(
      verified({
        report: validReport({
          deletionAccounting: [
            {
              path: "src/mergeAuthority.ts",
              deletedLines: 0,
              isTest: false,
              justified: true,
              justification: "trust me",
            },
          ],
        }),
      }),
      groundTruth({ diff: deletionDiff("src/mergeAuthority.ts", 250) }),
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "deletion-live-substantial")).toBe(true);
  });

  it("blocks a net test deletion computed from the diff (mq-16 test-deletion class)", () => {
    const result = triageClean({}, { diff: deletionDiff("tests/merge.test.ts", 30) });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "deletion-test-regression")).toBe(true);
  });

  it("does not gate a small live deletion below the configured threshold", () => {
    const result = triageClean({}, { diff: deletionDiff("src/thing.ts", 5) });
    expect(result.verdict).toBe("APPROVE");
  });

  it("checks: blocks on a REAL unresolved required check even when the worker reports unresolvedChecks:[]", () => {
    const pending: DiscoveredCheck = { name: "ci", status: "IN_PROGRESS", conclusion: null, kind: "check_run" };
    // Worker's report says all checks clear; ground truth from GitHub says otherwise.
    const result = triage(
      verified({ report: validReport({ unresolvedChecks: [] }) }),
      groundTruth({ requiredChecks: [pending] }),
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("check-"))).toBe(true);
  });

  it("checks: blocks on a FAILED required check", () => {
    const failed: DiscoveredCheck = { name: "ci", status: "COMPLETED", conclusion: "FAILURE", kind: "check_run" };
    const result = triageClean({}, { requiredChecks: [failed] });
    expect(result.verdict).toBe("REQUEST_CHANGES");
  });

  it("acceptance: 'just looks good' evidence names no locatable file -> P0 gap", () => {
    const result = triageClean({
      report: validReport({
        acceptanceTraces: [{ statement: "does the thing", satisfied: true, evidence: "just looks good" }],
      }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("acceptance-unverifiable"))).toBe(true);
  });

  it("acceptance: a cited file that does not exist in the tree is unverifiable -> P0", () => {
    const result = triageClean({
      report: validReport({
        acceptanceTraces: [
          { statement: "does the thing", satisfied: true, evidence: "proved by tests/fabricated.test.ts" },
        ],
      }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
  });

  it("acceptance: an unsatisfied trace is a P0 completion gap", () => {
    const result = triageClean({
      report: validReport({
        acceptanceTraces: [{ statement: "does the thing", satisfied: false, evidence: "not implemented" }],
      }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("acceptance-gap"))).toBe(true);
  });

  it("verification: sandbox that could not run -> P0 unproven acceptance", () => {
    const result = triageClean({ sandbox: { ran: false, passed: false, detail: "container failed" } });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "verification-unrun")).toBe(true);
  });

  it("verification: PR fails the trusted verification -> P1 block", () => {
    const result = triageClean({ sandbox: { ran: true, passed: false, detail: "exit 1" } });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "verification-failed")).toBe(true);
  });

  it("worker self-incrimination: a mandatory control the worker marks not-rejected -> P0", () => {
    const result = triageClean({
      report: validReport({
        negativeControls: [
          {
            id: "boundary",
            description: "critical fail-closed boundary",
            mandatory: true,
            kind: "executed",
            command: { executable: "node", args: ["x"] },
            expectedRejection: "non-zero",
            observedResult: "exit 0 — accepted",
            rejected: false,
            evidenceRef: "worker.log",
          },
        ],
      }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("control-admitted-failopen"))).toBe(true);
  });

  it("forces P0 when cross-model independence is unconfirmed", () => {
    const result = triageClean({ independence: { confirmed: false, reason: "unknown provenance" } });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "independence-unconfirmed")).toBe(true);
  });

  it("resolves acceptance citations against the caller-provided known tree", () => {
    expect(knownFiles).toContain("ops/cra/tests/audit.test.ts");
    expect(triageClean().verdict).toBe("APPROVE");
  });
});
