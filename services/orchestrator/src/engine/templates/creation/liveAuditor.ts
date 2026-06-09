// Template-creation STEP 4 (stage 3) — the LIVE auditor seam impl.
//
// The validation harness's `TemplateAuditor.openBlockingFindings` must return the
// number of OPEN BLOCKING (P0/P1-equivalent) findings over the built template (0 ⇒
// `auditorClean`). The fail-closed publish gate (`templateValidates`) refuses to
// publish a template with any blocking finding.
//
// REUSE: the audit is the SAME read-only audit pass the scheduled-audits surface
// runs — an `AuditPassRunner` indexes the project's repo READ-ONLY and the audit
// answerer surfaces findings with `info | warn | fail` severity. A `fail`-severity
// finding is the P0/P1 equivalent (a must-fix); we count those as blocking. We do
// NOT reinvent the audit pass — we adapt the existing runner into the auditor seam.

import type { AuditJob, AuditPassRunner } from "../../forge/audits/index.js";
import type { TemplateAuditor } from "../validationHarness.js";

// Build a `TemplateAuditor` over the existing scheduled-audit pass runner. Each
// `openBlockingFindings` runs ONE read-only audit pass over the built template's
// repo and counts the `fail`-severity (blocking) findings. A pass that throws
// propagates LOUD — `auditorClean` cannot be asserted over an audit that did not
// run (never a silent "clean").
//
// The pass runner is repo/project-scoped (it resolves the project's repo URL +
// indexes it), so the auditor is built per (orgId, projectId). `workspacePath` /
// `baselineSha` from the harness are not needed by the repo-index pass (it reads
// the project repo at its default branch, which is the converged template), so they
// are accepted + ignored — the seam shape is preserved.
export function buildTemplateAuditor(input: {
  passRunner: AuditPassRunner;
  orgId: string;
  projectId: string;
}): TemplateAuditor {
  const job: AuditJob = {
    id: `tmpl-audit-${input.projectId}`,
    orgId: input.orgId,
    projectId: input.projectId,
    // A general code-critique pass (the standing "find the must-fix issues" audit);
    // `security` is the broadest blocking-finding kind. The pass is read-only.
    kind: "security",
    name: "template publish convergence audit",
    cadence: "nightly",
    targetWindow: "",
    answererCli: "",
    enabled: true,
    lastRun: null,
    findings: { count: 0, severity: "ok", note: "" },
  };
  return {
    async openBlockingFindings(): Promise<number> {
      const result = await input.passRunner.run(job);
      return result.findings.filter((finding) => finding.severity === "fail").length;
    },
  };
}
