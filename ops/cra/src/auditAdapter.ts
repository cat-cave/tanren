import type { CraConfig } from "./config.js";
import { serializeAuditContext, type AuditContext } from "./auditContext.js";
import { AuditFailure, parseAuditReport, type AuditReport, type NegativeControl } from "./auditReport.js";
import type { IsolatedCommand } from "./isolatedRunner.js";
import { execute, type CommandExecutor, type CommandResult } from "./process.js";
import type { VerifiedWorktree } from "./worktree.js";

// The isolated-runner seam the adapter uses to re-execute negative controls.
// `DisposableCommandRunner` (CRA-04) satisfies it structurally; tests inject a fake.
export interface IsolatedControlRunner {
  run(worktree: VerifiedWorktree, command: IsolatedCommand): Promise<CommandResult>;
}

// The audit worker command was unreachable or exited non-zero without a report.
export class ModelUnreachableError extends AuditFailure {}

export interface ControlVerification {
  readonly id: string;
  readonly mandatory: boolean;
  // Independently CONFIRMED by re-running the control in the isolated runner and
  // observing a rejection (non-zero exit). Inspected-only mandatory controls, or
  // ones that never executed, are not confirmed and become a P0 gap in triage.
  readonly confirmed: boolean;
  readonly detail: string;
}

export interface IndependenceAssessment {
  // Cross-model independence between the audit worker family and the contributor.
  readonly confirmed: boolean;
  readonly reason: string;
}

export interface VerifiedAuditReport {
  readonly report: AuditReport;
  readonly controlVerifications: readonly ControlVerification[];
  readonly independence: IndependenceAssessment;
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
    const controlVerifications = await this.verifyControls(report.negativeControls, worktree);
    return {
      report,
      controlVerifications,
      independence: assessIndependence(context, this.config),
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

  // Re-run every executed negative control inside the CRA-04 isolated runner and
  // confirm the bad input is ACTUALLY rejected. Green CI is not evidence; the
  // supervisor executes the control itself. A control that cannot be confirmed to
  // reject stays unconfirmed and drives a P0 completion gap in triage.
  private async verifyControls(
    controls: readonly NegativeControl[],
    worktree: VerifiedWorktree,
  ): Promise<ControlVerification[]> {
    const verifications: ControlVerification[] = [];
    for (const control of controls) {
      verifications.push(await this.verifyControl(control, worktree));
    }
    return verifications;
  }

  private async verifyControl(control: NegativeControl, worktree: VerifiedWorktree): Promise<ControlVerification> {
    if (control.kind !== "executed" || control.command === null) {
      return {
        id: control.id,
        mandatory: control.mandatory,
        confirmed: false,
        detail: "control is inspected-only; not independently executed",
      };
    }
    try {
      const result = await this.runner.run(worktree, {
        executable: control.command.executable,
        args: control.command.args,
      });
      // A negative control feeds a bad input that MUST be rejected: a non-zero
      // exit is the rejection. A zero exit means the boundary accepted bad input.
      if (result.exitCode === 0) {
        return {
          id: control.id,
          mandatory: control.mandatory,
          confirmed: false,
          detail: "control command exited 0: the boundary accepted a bad input that must be rejected",
        };
      }
      return {
        id: control.id,
        mandatory: control.mandatory,
        confirmed: true,
        detail: `control rejected with exit ${result.exitCode}`,
      };
    } catch (error) {
      return {
        id: control.id,
        mandatory: control.mandatory,
        confirmed: false,
        detail: `control could not be executed: ${(error as Error).message}`,
      };
    }
  }
}
