import { describe, expect, it } from "vitest";
import type { VerifiedAuditReport } from "../src/auditAdapter.js";
import type { AuditFinding } from "../src/auditReport.js";
import { triage } from "../src/triage.js";
import { firstSha, secondSha } from "./helpers.js";
import { validReport } from "./auditFixtures.js";

const cleanDiff = "diff --git a/x b/x\n+added\n";

function verified(overrides: Partial<VerifiedAuditReport> = {}): VerifiedAuditReport {
  return {
    report: validReport(),
    controlVerifications: [
      { id: "malformed-report", mandatory: true, kind: "executed", confirmed: true, detail: "rejected" },
    ],
    independence: { confirmed: true, reason: "cross-model" },
    headSha: firstSha,
    baseSha: secondSha,
    rubricVersion: "2026-07-22",
    ...overrides,
  };
}

function triageClean(overrides: Partial<VerifiedAuditReport> = {}) {
  return triage(verified(overrides), { diff: cleanDiff });
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

describe("supervisor P0-P3 triage", () => {
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
    const forced = result.findings.find((f) => f.id === "f1");
    expect(forced).toMatchObject({ severity: "P0", forced: true });
  });

  it("synthesizes a P0 completion gap for an unsatisfied acceptance trace", () => {
    const result = triageClean({
      report: validReport({
        acceptanceTraces: [{ statement: "does the thing", satisfied: false, evidence: "not implemented" }],
      }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("acceptance-gap"))).toBe(true);
  });

  it("catches the mq-16 class: worker-declared unaccounted live-code + test deletion is P0", () => {
    const result = triageClean({
      report: validReport({
        deletionAccounting: [
          {
            path: "src/mergeAuthority.ts",
            deletedLines: 12000,
            isTest: false,
            justified: false,
            justification: "no replacement",
          },
          {
            path: "tests/merge.test.ts",
            deletedLines: 300,
            isTest: true,
            justified: false,
            justification: "deleted to fake green",
          },
        ],
      }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    const gaps = result.findings.filter((f) => f.id.startsWith("deletion-unaccounted"));
    expect(gaps).toHaveLength(2);
    expect(gaps.every((f) => f.severity === "P0")).toBe(true);
  });

  it("forces P0 on a NON-MANDATORY executed control that failed open (exit 0) — the crux", () => {
    const result = triageClean({
      controlVerifications: [{ id: "c1", mandatory: false, kind: "executed", confirmed: false, detail: "exited 0" }],
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("control-unconfirmed"))).toBe(true);
  });

  it("forces P0 on an executed control whose re-run could not be confirmed (null/throw)", () => {
    const result = triageClean({
      controlVerifications: [
        {
          id: "c1",
          mandatory: false,
          kind: "executed",
          confirmed: false,
          detail: "control could not be executed: boom",
        },
      ],
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
  });

  it("still forces P0 on an unconfirmed MANDATORY inspected control", () => {
    const result = triageClean({
      controlVerifications: [
        { id: "c1", mandatory: true, kind: "inspected", confirmed: false, detail: "inspected-only" },
      ],
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
  });

  it("does not block on a non-mandatory inspected control (inspection is a valid method)", () => {
    const result = triageClean({
      controlVerifications: [
        { id: "malformed-report", mandatory: false, kind: "executed", confirmed: true, detail: "rejected" },
        { id: "c2", mandatory: false, kind: "inspected", confirmed: false, detail: "inspected-only" },
      ],
    });
    expect(result.verdict).toBe("APPROVE");
  });

  it("blocks when a required CI check is unresolved (cannot approve over pending checks)", () => {
    const result = triageClean({
      report: validReport({ unresolvedChecks: [{ name: "ci", status: "PENDING", reason: "still running" }] }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("unresolved-check"))).toBe(true);
  });

  it("SUPERVISOR-RECOMPUTES deletions: empty worker accounting but the diff deletes live+test code is P0", () => {
    const diff = [
      "diff --git a/src/mergeAuthority.ts b/src/mergeAuthority.ts",
      "--- a/src/mergeAuthority.ts",
      "+++ b/src/mergeAuthority.ts",
      "-const live = 1;",
      "-const alsoLive = 2;",
      "diff --git a/tests/merge.test.ts b/tests/merge.test.ts",
      "--- a/tests/merge.test.ts",
      "+++ b/tests/merge.test.ts",
      "-expect(true).toBe(true);",
    ].join("\n");
    // Worker's deletionAccounting is EMPTY — it under-reported. The supervisor must
    // catch it from the diff, not take the worker's word.
    const result = triage(verified({ report: validReport({ deletionAccounting: [] }) }), { diff });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    const recomputed = result.findings.filter((f) => f.id.startsWith("deletion-recomputed"));
    expect(recomputed).toHaveLength(2);
    expect(recomputed.every((f) => f.severity === "P0")).toBe(true);
    expect(recomputed.some((f) => f.title.includes("test"))).toBe(true);
    expect(recomputed.some((f) => f.title.includes("production"))).toBe(true);
  });

  it("treats a satisfied acceptance claim with no verifiable evidence as a P0 gap", () => {
    const result = triageClean({
      report: validReport({
        acceptanceTraces: [{ statement: "does the thing", satisfied: true, evidence: "looks complete to me" }],
      }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("acceptance-unverifiable"))).toBe(true);
  });

  it("forces P0 when cross-model independence is unconfirmed", () => {
    const result = triageClean({ independence: { confirmed: false, reason: "unknown provenance" } });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "independence-unconfirmed")).toBe(true);
  });
});
