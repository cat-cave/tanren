import { describe, expect, it } from "vitest";
import type { VerifiedAuditReport } from "../src/auditAdapter.js";
import type { AuditFinding } from "../src/auditReport.js";
import { triage } from "../src/triage.js";
import { firstSha, secondSha } from "./helpers.js";
import { validReport } from "./auditFixtures.js";

function verified(overrides: Partial<VerifiedAuditReport> = {}): VerifiedAuditReport {
  return {
    report: validReport(),
    controlVerifications: [{ id: "malformed-report", mandatory: true, confirmed: true, detail: "rejected" }],
    independence: { confirmed: true, reason: "cross-model" },
    headSha: firstSha,
    baseSha: secondSha,
    rubricVersion: "2026-07-22",
    ...overrides,
  };
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
    const result = triage(verified());
    expect(result.verdict).toBe("APPROVE");
    expect(result.counts).toEqual({ P0: 0, P1: 0, P2: 0, P3: 0 });
  });

  it("approves when only P2/P3 betterment findings are present", () => {
    const result = triage(
      verified({
        report: validReport({
          findings: [finding({ suggestedSeverity: "P2" }), finding({ id: "f2", suggestedSeverity: "P3" })],
        }),
      }),
    );
    expect(result.verdict).toBe("APPROVE");
  });

  it("requests changes on a P1 fundamental implementation finding", () => {
    const result = triage(verified({ report: validReport({ findings: [finding({ suggestedSeverity: "P1" })] }) }));
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.counts.P1).toBe(1);
  });

  it("forces an acceptance-concerning finding to P0 even when the worker suggested lower", () => {
    const result = triage(
      verified({
        report: validReport({ findings: [finding({ concerns: "acceptance", suggestedSeverity: "P3" })] }),
      }),
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    const forced = result.findings.find((f) => f.id === "f1");
    expect(forced).toMatchObject({ severity: "P0", forced: true });
  });

  it("synthesizes a P0 completion gap for an unsatisfied acceptance trace", () => {
    const result = triage(
      verified({
        report: validReport({
          acceptanceTraces: [{ statement: "does the thing", satisfied: false, evidence: "not implemented" }],
        }),
      }),
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("acceptance-gap"))).toBe(true);
  });

  it("catches the mq-16 class: unaccounted live-code + test deletion is forced P0", () => {
    const result = triage(
      verified({
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
      }),
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    const gaps = result.findings.filter((f) => f.id.startsWith("deletion-unaccounted"));
    expect(gaps).toHaveLength(2);
    expect(gaps.every((f) => f.severity === "P0")).toBe(true);
  });

  it("forces P0 when a mandatory negative control is unconfirmed", () => {
    const result = triage(
      verified({
        controlVerifications: [{ id: "c1", mandatory: true, confirmed: false, detail: "exited 0" }],
      }),
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("control-unconfirmed"))).toBe(true);
  });

  it("forces P0 when cross-model independence is unconfirmed", () => {
    const result = triage(verified({ independence: { confirmed: false, reason: "unknown provenance" } }));
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "independence-unconfirmed")).toBe(true);
  });
});
