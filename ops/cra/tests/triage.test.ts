import { describe, expect, it } from "vitest";
import type { SandboxVerification, VerifiedAuditReport } from "../src/auditAdapter.js";
import type { AuditFinding } from "../src/auditReport.js";
import type { DiscoveredCheck } from "../src/discovery.js";
import { triage, type SupervisorEvidence } from "../src/triage.js";
import { firstSha, secondSha } from "./helpers.js";
import { cleanDiff, cleanEvidence, validReport } from "./auditFixtures.js";

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

function triageClean(v: Partial<VerifiedAuditReport> = {}, g: Partial<SupervisorEvidence> = {}) {
  return triage(verified(v), cleanEvidence(g));
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

function lineDeleteDiff(path: string, deleted: number): string {
  const body = Array.from({ length: deleted }, (_, i) => `-const dead${i} = ${i};`).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`;
}

function binaryDeleteDiff(path: string): string {
  return `diff --git a/${path} b/${path}\ndeleted file mode 100644\nBinary files a/${path} and /dev/null differ\n`;
}

function renameDiff(from: string, to: string): string {
  return `diff --git a/${from} b/${to}\nsimilarity index 100%\nrename from ${from}\nrename to ${to}\n`;
}

describe("supervisor triage — advisory findings", () => {
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

describe("supervisor triage — ground-truth gates the worker cannot clear", () => {
  it("mq-16: worker justified:true CANNOT suppress a live deletion the diff shows", () => {
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
      cleanEvidence({ diff: lineDeleteDiff("src/mergeAuthority.ts", 150) }),
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "deletion-live-substantial")).toBe(true);
  });

  it("blocks a net test deletion computed from the diff", () => {
    const result = triageClean({}, { diff: lineDeleteDiff("services/x/tests/merge.test.ts", 30) });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "deletion-test-regression")).toBe(true);
  });

  it("blocks binary deletions and 100% renames of live files (unmeasurable removals)", () => {
    const result = triageClean(
      {},
      { diff: `${binaryDeleteDiff("assets/blob.bin")}${renameDiff("src/old.ts", "src/new.ts")}` },
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "deletion-live-substantial")).toBe(true);
  });

  it("does not gate a small live deletion below the configured threshold", () => {
    // Include the clean diff so acceptance still resolves; add a small live deletion.
    const result = triageClean({}, { diff: `${cleanDiff}${lineDeleteDiff("src/thing.ts", 5)}` });
    expect(result.verdict).toBe("APPROVE");
  });

  it("classifies test paths by segment, not substring (contests/ is not a test dir)", () => {
    const result = triageClean({}, { diff: lineDeleteDiff("src/contests/scoreboard.ts", 3) });
    expect(result.findings.some((f) => f.id === "deletion-test-regression")).toBe(false);
  });

  it("checks: blocks on a SKIPPED required check", () => {
    const skipped: DiscoveredCheck = { name: "ci", status: "COMPLETED", conclusion: "SKIPPED", kind: "check_run" };
    const result = triageClean({}, { requiredContexts: ["ci"], actualChecks: [skipped] });
    expect(result.verdict).toBe("REQUEST_CHANGES");
  });

  it("checks: blocks on a missing required check even when the worker reports unresolvedChecks:[]", () => {
    const result = triageClean(
      { report: validReport({ unresolvedChecks: [] }) },
      { requiredContexts: ["ci"], actualChecks: [] },
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("check-missing"))).toBe(true);
  });

  it("checks: an EMPTY required set fails closed (not 'all clear')", () => {
    const result = triageClean({}, { requiredContexts: [], actualChecks: [] });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "checks-unconfirmed")).toBe(true);
  });

  it("acceptance: a suffix token ('see t.ts') does NOT clear a satisfied claim", () => {
    const result = triageClean({
      report: validReport({
        acceptanceTraces: [{ statement: "does the thing", satisfied: true, evidence: "see t.ts" }],
      }),
    });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("acceptance-unverifiable"))).toBe(true);
  });

  it("acceptance: a cited path not present in the diff's changed set is unproven -> P0", () => {
    const result = triageClean({
      report: validReport({
        acceptanceTraces: [
          { statement: "does the thing", satisfied: true, evidence: "proved by ops/cra/tests/other.test.ts" },
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

  it("verification: sandbox that could not run (or was vacuous) -> P0", () => {
    const result = triageClean({ sandbox: { ran: false, passed: false, detail: "vacuous command rejected" } });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "verification-unrun")).toBe(true);
  });

  it("verification: PR fails the trusted verification -> P1 block", () => {
    const result = triageClean({ sandbox: { ran: true, passed: false, detail: "exit 1" } });
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id === "verification-failed")).toBe(true);
  });

  it("worker self-incrimination: a mandatory control marked not-rejected -> P0", () => {
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

  it("THE FULL grok break: findings:[], suffix-token acceptance, rejected:true control, empty checks, binary delete -> REQUEST_CHANGES", () => {
    const result = triage(
      verified({
        report: validReport({
          findings: [],
          acceptanceTraces: [{ statement: "it works", satisfied: true, evidence: "see t.ts" }],
          negativeControls: [
            {
              id: "c",
              description: "boundary",
              mandatory: true,
              kind: "executed",
              command: { executable: "env", args: ["false"] },
              expectedRejection: "non-zero",
              observedResult: "exit 1",
              rejected: true,
              evidenceRef: "worker.log",
            },
          ],
          unresolvedChecks: [],
        }),
      }),
      cleanEvidence({ diff: binaryDeleteDiff("src/x.bin"), requiredContexts: [], actualChecks: [] }),
    );
    expect(result.verdict).toBe("REQUEST_CHANGES");
    expect(result.findings.some((f) => f.id.startsWith("acceptance-unverifiable"))).toBe(true);
    expect(result.findings.some((f) => f.id === "checks-unconfirmed")).toBe(true);
    expect(result.findings.some((f) => f.id === "deletion-live-substantial")).toBe(true);
  });
});
