// P3-0021 scheduled-audits: the default read-only pass runner.
//
// The fallback `AuditPassRunner` used when no SSH/Answerer-backed runner is
// wired — the analogue of the inbox's deterministic triage answerer. It is
// SAFE-by-default: it performs no repo scan and returns zero findings, so the
// scheduler runs (recording a clean pass) without provider/SSH infra and the
// endpoint is live for manual job management. Production injects an
// SSH-backed runner that executes the kind's read-only Answerer pass over the
// project's repo and maps the pass output to findings.

import type { AuditPassResult, AuditPassRunner } from "./types.js";

export function createNoopPassRunner(): AuditPassRunner {
  return {
    async run(): Promise<AuditPassResult> {
      return { findings: [] };
    },
  };
}
