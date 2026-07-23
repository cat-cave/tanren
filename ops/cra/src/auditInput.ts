// cspell:ignore numstat
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { buildAuditContext, type AuditContext, type DeletionStat } from "./auditContext.js";
import type { CraConfig } from "./config.js";
import type { DiscoveredPullRequest } from "./discovery.js";
import { githubTokenEnvironment } from "./githubApp.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";
import type { VerifiedWorktree } from "./worktree.js";

const API_VERSION = "2022-11-28";
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.string(),
  labels: z.array(z.object({ name: z.string() })),
});

export interface PreparedAuditInput {
  readonly context: AuditContext;
  readonly sourceIssue: number;
  readonly bucketLabel: string;
  readonly blockedBy: readonly number[];
}

function section(body: string, heading: string): string | null {
  const escaped = heading.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`(?:^|\\n)#{1,3}\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n#{1,3}\\s|$)`, "iu").exec(body);
  return match?.[1]?.trim() || null;
}

function modelProvenance(pr: DiscoveredPullRequest): {
  readonly authorIsAgent: boolean;
  readonly authorModelFamily: string | null;
} {
  const marker = /<!--\s*tanren-author-model:\s*([A-Za-z0-9_.-]+)\s*-->/iu.exec(pr.body);
  return {
    authorIsAgent: marker !== null || pr.author?.endsWith("[bot]") === true,
    authorModelFamily: marker?.[1] ?? null,
  };
}

function bucketLabel(labels: readonly string[]): string {
  const candidates = labels.filter(
    (label) => !["bug", "enhancement", "documentation", "question"].includes(label) && !/^P[0-3]$/u.test(label),
  );
  if (candidates.length !== 1) {
    throw new Error(`source issue must have exactly one routing bucket label; found [${candidates.join(", ")}]`);
  }
  return candidates[0]!;
}

function parseNumstat(output: string): DeletionStat[] {
  const stats: DeletionStat[] = [];
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (added === undefined || deleted === undefined || path.length === 0) {
      throw new Error("git numstat output was malformed");
    }
    stats.push({
      path,
      deletedLines: deleted === "-" ? 0 : Number.parseInt(deleted, 10),
      isTest: /(^|\/)(?:test|tests|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/u.test(path),
    });
  }
  return stats;
}

export class AuditInputAssembler {
  private readonly owner: string;
  private readonly name: string;

  public constructor(
    private readonly config: CraConfig,
    private readonly token: string,
    private readonly executor: CommandExecutor = execute,
  ) {
    [this.owner, this.name] = config.repository.split("/") as [string, string];
  }

  public async prepare(pr: DiscoveredPullRequest, worktree: VerifiedWorktree): Promise<PreparedAuditInput> {
    if (worktree.headSha !== pr.headSha) throw new Error(`PR #${pr.number} worktree does not match advertised head`);
    if (pr.closingIssues.length !== 1) throw new Error(`PR #${pr.number} must close exactly one source issue`);
    const linked = pr.closingIssues[0]!;
    if (linked.state.toUpperCase() !== "OPEN") throw new Error(`source issue #${linked.number} is not open`);
    const [issue, diff, numstat, brief, contributing] = await Promise.all([
      this.issue(linked.number),
      this.git(["diff", "--no-color", "--find-renames", `${pr.baseSha}...${pr.headSha}`]),
      this.git(["diff", "--numstat", "--find-renames", `${pr.baseSha}...${pr.headSha}`]),
      readFile(`${this.config.repositoryRoot}/PROJECT_BRIEF.md`, "utf8"),
      readFile(`${this.config.repositoryRoot}/CONTRIBUTING.md`, "utf8"),
    ]);
    if (issue.number !== linked.number || issue.state.toUpperCase() !== "OPEN") {
      throw new Error(`source issue #${linked.number} changed or is unconfirmable`);
    }
    const body = issue.body ?? "";
    const acceptance = section(body, "Acceptance") ?? body;
    if (acceptance.trim().length === 0) throw new Error(`source issue #${linked.number} has no acceptance text`);
    const requiredNegativeControl =
      acceptance
        .split("\n")
        .find((line) => /negative control/iu.test(line))
        ?.trim() ?? "MISSING: source issue does not declare its required negative control";
    const provenance = modelProvenance(pr);
    return {
      context: buildAuditContext({
        pullRequest: pr,
        issue: {
          number: issue.number,
          title: issue.title,
          body,
          acceptance,
          requiredNegativeControl,
          blockers: linked.blockers,
        },
        diff: diff.stdout,
        deletionStats: parseNumstat(numstat.stdout),
        checks: pr.checks,
        standards: `${brief}\n\n${contributing}`,
        ...provenance,
      }),
      sourceIssue: issue.number,
      bucketLabel: bucketLabel(issue.labels.map((label) => label.name)),
      blockedBy: linked.blockers.map((blocker) => blocker.number),
    };
  }

  private async issue(number: number): Promise<z.infer<typeof issueSchema>> {
    const result = await executeChecked(this.executor, {
      command: this.config.commands.gh,
      args: ["api", "-H", `X-GitHub-Api-Version: ${API_VERSION}`, `/repos/${this.owner}/${this.name}/issues/${number}`],
      env: githubTokenEnvironment(this.token),
      timeoutMs: 60_000,
    });
    return issueSchema.parse(JSON.parse(result.stdout));
  }

  private async git(args: readonly string[]) {
    return await executeChecked(this.executor, {
      command: this.config.commands.git,
      args: ["-C", this.config.repositoryRoot, ...args],
      timeoutMs: 120_000,
    });
  }
}
