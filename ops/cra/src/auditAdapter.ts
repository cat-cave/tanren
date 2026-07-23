import type { CraConfig } from "./config.js";
import { serializeAuditContext, type AuditContext } from "./auditContext.js";
import { AuditFailure, parseAuditReport, type AuditReport } from "./auditReport.js";
import type { IsolatedCommand } from "./isolatedRunner.js";
import { execute, type CommandExecutor, type CommandResult } from "./process.js";
import type { VerifiedWorktree } from "./worktree.js";

// TRUST BOUNDARY. The audit worker AUTHORS its report, so every field it controls is
// spoofable. The report is therefore ADVISORY JUDGMENT ONLY — it can ADD P0-P3
// findings, but it can never confirm, clear, or suppress a gate condition. The
// supervisor computes every gate-critical signal from GROUND TRUTH: the real diff,
// the real GitHub check states, the worktree tree, and ONE trusted verification
// command (config-sourced, NEVER worker-supplied) run in the CRA-04 sandbox.

// The isolated-runner seam the supervisor uses to run its trusted verification
// command. `DisposableCommandRunner` (CRA-04) satisfies it structurally.
export interface IsolatedControlRunner {
  run(worktree: VerifiedWorktree, command: IsolatedCommand): Promise<CommandResult>;
}

// The audit worker command was unreachable or exited non-zero without a report.
export class ModelUnreachableError extends AuditFailure {}

export interface SandboxVerification {
  // The trusted verification command executed to completion in the sandbox.
  readonly ran: boolean;
  // ...and exited 0. A verification that could not run (ran=false) is a blocking
  // unproven-acceptance condition; a run that failed (ran=true, passed=false) means
  // the PR fails its own acceptance on a clean sandboxed checkout.
  readonly passed: boolean;
  readonly detail: string;
}

export interface IndependenceAssessment {
  // Cross-model independence between the audit worker family and the contributor.
  readonly confirmed: boolean;
  readonly reason: string;
}

export interface VerifiedAuditReport {
  // ADVISORY: the worker's judgment. Findings add to triage; nothing here clears a
  // supervisor-computed gate.
  readonly report: AuditReport;
  readonly independence: IndependenceAssessment;
  // GROUND TRUTH: the supervisor's own trusted verification result.
  readonly sandbox: SandboxVerification;
  readonly headSha: string;
  readonly baseSha: string;
  readonly rubricVersion: string;
}

// The worker receives model credentials from the operator's own environment but
// must never receive the CRA GitHub installation token: strip both GitHub token
// variables so a compromised/coerced worker cannot act as the merge identity.
function workerEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["GH_TOKEN"];
  delete env["GITHUB_TOKEN"];
  return env;
}

function assessIndependence(context: AuditContext, config: CraConfig): IndependenceAssessment {
  const auditFamily = config.audit.modelFamily.toLowerCase();
  if (context.authorModelFamily !== null) {
    if (context.authorModelFamily.toLowerCase() === auditFamily) {
      return {
        confirmed: false,
        reason: `audit worker family ${config.audit.modelFamily} matches the contributor family ${context.authorModelFamily}`,
      };
    }
    return {
      confirmed: true,
      reason: `cross-model: audit ${config.audit.modelFamily} vs author ${context.authorModelFamily}`,
    };
  }
  if (context.authorIsAgent) {
    return { confirmed: false, reason: "agent-authored PR with unknown model provenance: independence unconfirmable" };
  }
  return { confirmed: true, reason: "human-authored PR: cross-model independence not applicable" };
}

export class AuditAdapter {
  public constructor(
    private readonly config: CraConfig,
    private readonly runner: IsolatedControlRunner,
    private readonly executor: CommandExecutor = execute,
  ) {}

  public async audit(context: AuditContext, worktree: VerifiedWorktree): Promise<VerifiedAuditReport> {
    if (worktree.headSha !== context.headSha) {
      throw new AuditFailure(`worktree head ${worktree.headSha} does not match audited head ${context.headSha}`);
    }
    const raw = await this.invokeWorker(context, worktree);
    const report = parseAuditReport(raw, {
      headSha: context.headSha,
      baseSha: context.baseSha,
      rubricVersion: context.rubricVersion,
    });
    const sandbox = await this.runTrustedVerification(worktree);
    return {
      report,
      independence: assessIndependence(context, this.config),
      sandbox,
      headSha: context.headSha,
      baseSha: context.baseSha,
      rubricVersion: context.rubricVersion,
    };
  }

  private async invokeWorker(context: AuditContext, worktree: VerifiedWorktree): Promise<unknown> {
    let result;
    try {
      result = await this.executor({
        command: this.config.audit.command,
        args: [...this.config.audit.args],
        cwd: worktree.path,
        env: workerEnvironment(),
        input: serializeAuditContext(context),
        timeoutMs: this.config.audit.timeoutMs,
      });
    } catch (error) {
      throw new ModelUnreachableError(`audit worker failed to run: ${(error as Error).message}`, { cause: error });
    }
    if (result.exitCode !== 0) {
      throw new ModelUnreachableError(
        `audit worker exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
      );
    }
    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new ModelUnreachableError("audit worker produced non-JSON output", { cause: error });
    }
  }

  // Runs the ONE trusted, config-sourced verification command in the sandbox. This
  // is the only sandbox execution and it is NEVER a worker-supplied command — an
  // arbitrary worker command cannot be tied to the PR's boundary, so it can never
  // confirm a gate. Its exit status is ground truth the triage gate consumes.
  private async runTrustedVerification(worktree: VerifiedWorktree): Promise<SandboxVerification> {
    const command = this.config.audit.verificationCommand;
    try {
      const result = await this.runner.run(worktree, { executable: command.executable, args: [...command.args] });
      return {
        ran: true,
        passed: result.exitCode === 0,
        detail: `trusted verification '${command.executable}' exited ${result.exitCode}`,
      };
    } catch (error) {
      return { ran: false, passed: false, detail: `trusted verification could not run: ${(error as Error).message}` };
    }
  }
}
