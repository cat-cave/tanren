import { z } from "zod";
import type { AbandonmentGateway } from "./abandonment.js";
import type { CraConfig } from "./config.js";
import { githubTokenEnvironment } from "./githubApp.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";

const API_VERSION = "2022-11-28";
const issueSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  body: z.string().nullable(),
  assignees: z.array(z.object({ login: z.string() })),
});

export class GithubAbandonmentGateway implements AbandonmentGateway {
  private readonly owner: string;
  private readonly name: string;

  public constructor(
    private readonly config: CraConfig,
    private readonly token: string,
    private readonly executor: CommandExecutor = execute,
  ) {
    [this.owner, this.name] = config.repository.split("/") as [string, string];
  }

  public async hasPrComment(pr: number, marker: string): Promise<boolean> {
    const comments = z
      .array(z.object({ body: z.string().nullable() }))
      .parse(
        JSON.parse(
          (await this.gh(["api", "--paginate", `/repos/${this.owner}/${this.name}/issues/${pr}/comments`])).stdout,
        ),
      );
    return comments.some((comment) => comment.body?.includes(marker) === true);
  }

  public async commentPr(pr: number, body: string): Promise<void> {
    const response = z
      .object({ body: z.string() })
      .parse(
        JSON.parse(
          (
            await this.gh(
              ["api", "--method", "POST", `/repos/${this.owner}/${this.name}/issues/${pr}/comments`, "--input", "-"],
              JSON.stringify({ body }),
            )
          ).stdout,
        ),
      );
    if (response.body !== body) throw new Error(`PR #${pr} comment failed read-after-write`);
  }

  public async closePr(pr: number): Promise<void> {
    const response = z
      .object({ number: z.number(), state: z.string(), merged: z.boolean() })
      .parse(
        JSON.parse(
          (
            await this.gh(
              ["api", "--method", "PATCH", `/repos/${this.owner}/${this.name}/pulls/${pr}`, "--input", "-"],
              JSON.stringify({ state: "closed" }),
            )
          ).stdout,
        ),
      );
    if (response.number !== pr || response.state !== "closed" || response.merged) {
      throw new Error(`PR #${pr} did not close without merge`);
    }
  }

  public async refreshOriginalIssue(input: Parameters<AbandonmentGateway["refreshOriginalIssue"]>[0]): Promise<void> {
    const path = `/repos/${this.owner}/${this.name}/issues/${input.issue}`;
    const current = issueSchema.parse(JSON.parse((await this.gh(["api", path])).stdout));
    const section = [
      input.marker,
      `## CRA abandonment refresh (PR #${input.pr})`,
      `Reason: ${input.reason}. This issue remains unfinished and is claimable again.`,
      "",
      "## Clarified acceptance",
      ...input.durableFindings.map(
        (finding) =>
          `- ${finding.severity} ${finding.title}: ${finding.fixDirection ?? finding.body} Evidence: ${finding.evidence}`,
      ),
    ].join("\n");
    const body =
      current.body?.includes(input.marker) === true ? current.body : `${current.body ?? ""}\n\n${section}`.trim();
    const updated = issueSchema.parse(
      JSON.parse(
        (
          await this.gh(
            ["api", "--method", "PATCH", path, "--input", "-"],
            JSON.stringify({ state: "open", body, assignees: [] }),
          )
        ).stdout,
      ),
    );
    if (updated.state !== "open" || updated.body !== body || updated.assignees.length > 0) {
      throw new Error(`source issue #${input.issue} failed claimable read-after-write`);
    }
    const claimableMarker = `<!-- tanren-cra:claimable issue=${input.issue} pr=${input.pr} -->`;
    if (!(await this.hasPrComment(input.issue, claimableMarker))) {
      await this.commentPr(
        input.issue,
        `${claimableMarker}\nPR #${input.pr} was abandoned (${input.reason}). This issue is open, unassigned, and claimable again.`,
      );
    }
  }

  private async gh(args: readonly string[], input?: string) {
    const withVersion = [args[0]!, "-H", `X-GitHub-Api-Version: ${API_VERSION}`, ...args.slice(1)];
    return await executeChecked(this.executor, {
      command: this.config.commands.gh,
      args: withVersion,
      env: githubTokenEnvironment(this.token),
      input,
      timeoutMs: 60_000,
    });
  }
}
