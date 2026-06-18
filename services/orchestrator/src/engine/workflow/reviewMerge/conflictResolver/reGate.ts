// The resolved-tree re-gate (autonomy-engine.md §2b step 4): after the
// resolution is applied to the workspace, RE-RUN the in-loop gate + checker +
// auditor against the RESOLVED tree. The resolver NEVER merges an unverified
// resolution — only a clean re-gate lets the merge proceed.
//
// This REUSES the existing run path: the same `runGate` callback the writer loop
// uses (deterministic gate over SSH) and the same checker/auditor Answerer
// adapters + invokers. It captures the resolved tree's combined diff over the
// runner so the checker/auditor judge the real resolved state, then maps the
// three stages onto a single ReGateVerdict the resolver acts on.

import type { CheckAnswer, AuditAnswer, PlanSubtask } from "../../../answerers/schemas/index.js";
import type { CiWhen } from "../../../ci/index.js";
import type { ReGateVerdict, ResolvedTreeReGate } from "../../../contracts/conflictResolution.js";
import type { AnswererAdapter } from "../../../providers/types.js";
import type { GateOutcome } from "../../gate/index.js";
import { decideCheckerOutcome, invokeChecker } from "../../checker/checker.js";
import { auditorReGateDecision, invokeAuditor } from "../../auditor/auditor.js";

export interface ResolvedTreeReGateDeps {
  workspacePath: string;
  /** The deterministic gate the writer loop uses (per-iteration / pre-audit tiers). */
  runGate: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  checker: AnswererAdapter<CheckAnswer>;
  auditor: AnswererAdapter<AuditAnswer>;
  /** The merging spec's intent — what the checker/auditor judge the resolved tree against. */
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  /** The run base the checker/auditor diff the resolved tree against (self-inspected in-workspace). */
  baseSha: string;
}

export class RunPathResolvedTreeReGate implements ResolvedTreeReGate {
  constructor(private readonly deps: ResolvedTreeReGateDeps) {}

  async reGate(_input: { resolvedFiles: ReadonlyArray<string> }): Promise<ReGateVerdict> {
    // 1. Deterministic gate over the resolved workspace (build/test/lint). The
    //    pre_audit tier is the full gate the loop runs before the auditor.
    const gate = await this.deps.runGate({ when: "pre_audit" });
    if (!gate.passed) {
      return { passed: false, failedStage: "gate", reason: gateFailureReason(gate) };
    }

    // 2. Judge the resolved tree. The checker/auditor run INSIDE the resolved
    //    read-only workspace (codex `--cd`), so they inspect the resolved change
    //    themselves (diffing against the run base) rather than being handed an
    //    injected diff that can balloon past the model's input limit.
    const subtask: PlanSubtask = {
      index: 0,
      title: "Intent-preserving conflict resolution",
      intent: `Resolve the merge conflict while preserving the spec intent: ${this.deps.specTitle}`,
      behaviorIds: [],
      estimatedTokens: null,
    };
    const check = await invokeChecker(this.deps.checker, {
      context: {
        specTitle: this.deps.specTitle,
        specDescription: this.deps.specDescription,
        acceptanceCriteria: this.deps.acceptanceCriteria,
        subtask,
        baselineSha: this.deps.baseSha,
      },
      workspace: this.deps.workspacePath,
    });
    const checkDecision = decideCheckerOutcome(check.verdict);
    if (checkDecision.kind === "reject") {
      return { passed: false, failedStage: "checker", reason: checkDecision.reason };
    }

    // 3. Auditor: is the resolved spec complete + verifiable against acceptance?
    const audit = await invokeAuditor(this.deps.auditor, {
      context: {
        specTitle: this.deps.specTitle,
        specDescription: this.deps.specDescription,
        acceptanceCriteria: this.deps.acceptanceCriteria,
        subtasks: [subtask],
        baselineSha: this.deps.baseSha,
      },
      workspace: this.deps.workspacePath,
    });
    const auditDecision = auditorReGateDecision(audit.verdict);
    if (auditDecision.blocked) {
      return { passed: false, failedStage: "auditor", reason: auditDecision.reason };
    }

    return { passed: true, reason: "re-gate passed: gate + checker + auditor green on the resolved tree" };
  }
}

function gateFailureReason(gate: Extract<GateOutcome, { passed: false }>): string {
  const failure = gate.failure;
  return `gate failed at tier ${failure.tier}: step '${failure.failedStep}' (exit ${failure.exitCode ?? "unknown"})`;
}
