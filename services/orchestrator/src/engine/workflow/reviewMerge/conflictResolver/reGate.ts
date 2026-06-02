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
import type { SshTarget } from "../../../contracts/allocator.js";
import type { SshSubstrate } from "../../../contracts/sshSubstrate.js";
import type { ReGateVerdict, ResolvedTreeReGate } from "../../../contracts/conflictResolution.js";
import type { AnswererAdapter } from "../../../providers/types.js";
import { runWorkspaceSshCommand } from "../../../workspace/ssh.js";
import type { GateOutcome } from "../../gate/index.js";
import { decideCheckerOutcome, invokeChecker } from "../../checker/checker.js";
import { decideAuditorOutcome, invokeAuditor } from "../../auditor/auditor.js";

export interface ResolvedTreeReGateDeps {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  timeoutMs: number;
  /** The deterministic gate the writer loop uses (per-iteration / pre-audit tiers). */
  runGate: (input: { when: CiWhen; taskId?: string }) => Promise<GateOutcome>;
  checker: AnswererAdapter<CheckAnswer>;
  auditor: AnswererAdapter<AuditAnswer>;
  /** The merging spec's intent — what the checker/auditor judge the resolved tree against. */
  specTitle: string;
  specDescription: string;
  acceptanceCriteria: ReadonlyArray<string>;
  /** The base sha the resolved diff is captured against (the run's diff base). */
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

    // 2. Capture the resolved tree's combined diff for the Answerers to judge.
    const combinedDiff = await this.captureResolvedDiff();

    // 3. Checker: does the resolved diff still satisfy the spec intent? (The
    //    resolution is judged as a single subtask: "preserve the spec intent".)
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
        writerDiff: combinedDiff,
      },
      timeoutMs: this.deps.timeoutMs,
      workspace: this.deps.workspacePath,
    });
    const checkDecision = decideCheckerOutcome(check.verdict);
    if (checkDecision.kind === "reject") {
      return { passed: false, failedStage: "checker", reason: checkDecision.reason };
    }

    // 4. Auditor: is the resolved spec complete + verifiable against acceptance?
    const audit = await invokeAuditor(this.deps.auditor, {
      context: {
        specTitle: this.deps.specTitle,
        specDescription: this.deps.specDescription,
        acceptanceCriteria: this.deps.acceptanceCriteria,
        subtasks: [subtask],
        combinedDiff,
      },
      timeoutMs: this.deps.timeoutMs,
      workspace: this.deps.workspacePath,
    });
    const auditDecision = decideAuditorOutcome(audit.verdict);
    if (auditDecision.kind === "reject") {
      return { passed: false, failedStage: "auditor", reason: auditDecision.reason };
    }

    return { passed: true, reason: "re-gate passed: gate + checker + auditor green on the resolved tree" };
  }

  private async captureResolvedDiff(): Promise<string> {
    const result = await runWorkspaceSshCommand(this.deps.ssh, this.deps.target, {
      label: "re-gate: capture resolved diff",
      cwd: this.deps.workspacePath,
      command: `git diff --no-color ${this.deps.baseSha}`,
      timeoutMs: this.deps.timeoutMs,
    });
    return result.stdout;
  }
}

function gateFailureReason(gate: Extract<GateOutcome, { passed: false }>): string {
  const failure = gate.failure;
  return `gate failed at tier ${failure.tier}: step '${failure.failedStep}' (exit ${failure.exitCode ?? "unknown"})`;
}
