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
  // The worker's declared control kind, carried through so triage can force P0 on
  // ANY unconfirmed EXECUTED control (a fail-open is a fail-open, mandatory or not).
  readonly kind: "executed" | "inspected";
  // Independently CONFIRMED only when the supervisor itself re-ran a real command in
  // the isolated runner and saw a NON-ZERO exit (the bad input was rejected). The
  // worker's own `rejected` field is never trusted. Inspected-only controls, missing/
  // trivial commands, exit-0 (accepted), or a throwing re-run are NOT confirmed.
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
    const base = { id: control.id, mandatory: control.mandatory, kind: control.kind } as const;
    if (control.kind !== "executed") {
      return { ...base, confirmed: false, detail: "control is inspected-only; not independently executed" };
    }
    const command = control.command;
    if (command === null || command.executable.trim().length === 0) {
      return { ...base, confirmed: false, detail: "executed control has no runnable command to re-verify" };
    }
    const basename = command.executable.split("/").at(-1) ?? command.executable;
    if (TRIVIAL_EXECUTABLES.has(basename)) {
      // `true`/`false`/`:` exit deterministically regardless of input, so they can
      // neither exercise nor reject a real boundary: never a valid confirmation.
      return {
        ...base,
        confirmed: false,
        detail: `control command '${command.executable}' does not exercise the boundary`,
      };
    }
    try {
      const result = await this.runner.run(worktree, { executable: command.executable, args: command.args });
      // A negative control feeds a bad input that MUST be rejected: a non-zero exit is
      // the rejection. A zero exit means the boundary ACCEPTED bad input (a fail-open).
      if (result.exitCode === 0) {
        return {
          ...base,
          confirmed: false,
          detail: "control command exited 0: the boundary accepted a bad input that must be rejected",
        };
      }
      return { ...base, confirmed: true, detail: `control rejected with exit ${result.exitCode}` };
    } catch (error) {
      return { ...base, confirmed: false, detail: `control could not be executed: ${(error as Error).message}` };
    }
  }
}

// Executables that exit deterministically and so can never confirm that a real
// boundary rejected a bad input.
const TRIVIAL_EXECUTABLES: ReadonlySet<string> = new Set(["true", "false", ":"]);
