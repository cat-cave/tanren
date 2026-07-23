import { z } from "zod";
import type { CraConfig } from "./config.js";
import type { DiscoveredCheck } from "./discovery.js";
import { githubTokenEnvironment } from "./githubApp.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";
import type { SupervisorEvidence } from "./triage.js";
import type { VerifiedWorktree } from "./worktree.js";

const API_VERSION = "2022-11-28";
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);

// Ground truth could not be assembled from git/GitHub. The pipeline must FAIL CLOSED
// on this — never proceed to an APPROVE on a partial evidence bundle.
export class GroundTruthAssemblyError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GroundTruthAssemblyError";
  }
}

export interface AssembleInput {
  readonly worktree: VerifiedWorktree;
  readonly baseSha: string;
  readonly headSha: string;
}

// The supervisor ASSEMBLES its own ground truth. It never accepts diff / knownFiles /
// checks from a caller (integration could under-supply and silently weaken the gate).
export interface GroundTruthAssembler {
  assemble(input: AssembleInput): Promise<SupervisorEvidence>;
}

const branchProtectionSchema = z.object({ contexts: z.array(z.string()).default([]) });
const checkRunsSchema = z.object({
  check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const combinedStatusSchema = z.object({
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
});

export class GitHubGroundTruthAssembler implements GroundTruthAssembler {
  public constructor(
    private readonly config: CraConfig,
    private readonly token: string,
    private readonly executor: CommandExecutor = execute,
  ) {}

  public async assemble(input: AssembleInput): Promise<SupervisorEvidence> {
    if (!shaSchema.safeParse(input.baseSha).success || !shaSchema.safeParse(input.headSha).success) {
      throw new GroundTruthAssemblyError("base/head SHA is not a full 40-hex commit");
    }
    const diff = await this.assembleDiff(input.baseSha, input.headSha);
    const knownFiles = await this.assembleKnownFiles(input.worktree);
    const requiredContexts = await this.assembleRequiredContexts();
    const actualChecks = await this.assembleActualChecks(input.headSha);
    return {
      diff,
      knownFiles,
      requiredContexts,
      actualChecks,
      liveDeletionThreshold: this.config.audit.deletionGate.liveLineThreshold,
    };
  }

  private async assembleDiff(baseSha: string, headSha: string): Promise<string> {
    const result = await this.git([
      "-C",
      this.config.repositoryRoot,
      "diff",
      "--no-color",
      "--find-renames",
      `${baseSha}...${headSha}`,
    ]);
    return result.stdout;
  }

  private async assembleKnownFiles(worktree: VerifiedWorktree): Promise<string[]> {
    const result = await this.git(["-C", worktree.path, "ls-files"]);
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private async assembleRequiredContexts(): Promise<string[]> {
    const [owner, name] = this.config.repository.split("/") as [string, string];
    const raw = await this.gh([
      "api",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      `/repos/${owner}/${name}/branches/${this.config.baseBranch}/protection/required_status_checks`,
    ]);
    const parsed = branchProtectionSchema.safeParse(JSON.parse(raw.stdout));
    if (!parsed.success) throw new GroundTruthAssemblyError("branch protection required_status_checks was unparseable");
    return parsed.data.contexts;
  }

  private async assembleActualChecks(headSha: string): Promise<DiscoveredCheck[]> {
    const [owner, name] = this.config.repository.split("/") as [string, string];
    const runsRaw = await this.gh([
      "api",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      "--paginate",
      `/repos/${owner}/${name}/commits/${headSha}/check-runs`,
    ]);
    const statusRaw = await this.gh([
      "api",
      "-H",
      `X-GitHub-Api-Version: ${API_VERSION}`,
      `/repos/${owner}/${name}/commits/${headSha}/status`,
    ]);
    const runs = checkRunsSchema.safeParse(JSON.parse(runsRaw.stdout));
    const statuses = combinedStatusSchema.safeParse(JSON.parse(statusRaw.stdout));
    if (!runs.success || !statuses.success) throw new GroundTruthAssemblyError("check states were unparseable");
    const checks: DiscoveredCheck[] = runs.data.check_runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      kind: "check_run",
    }));
    for (const status of statuses.data.statuses) {
      checks.push({ name: status.context, status: status.state, conclusion: status.state, kind: "status_context" });
    }
    return checks;
  }

  private async git(args: readonly string[]) {
    try {
      return await executeChecked(this.executor, { command: this.config.commands.git, args, timeoutMs: 120_000 });
    } catch (error) {
      throw new GroundTruthAssemblyError(`git ground-truth command failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }

  private async gh(args: readonly string[]) {
    try {
      return await executeChecked(this.executor, {
        command: this.config.commands.gh,
        args,
        env: githubTokenEnvironment(this.token),
        timeoutMs: 60_000,
      });
    } catch (error) {
      throw new GroundTruthAssemblyError(`GitHub ground-truth query failed: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
}
