import { z } from "zod";

const issueSchema = z.object({ number: z.number().int().positive(), state: z.string() });
const issueCommentsSchema = z.array(
  z.array(z.object({ body: z.string(), user: z.object({ login: z.string() }).nullable() })),
);

interface GithubResponse {
  readonly stdout: string;
}

type GithubRequest = (args: readonly string[], input?: string) => Promise<GithubResponse>;

export class GithubIssueReconciler {
  public constructor(
    private readonly repository: string,
    private readonly expectedLogin: string,
    private readonly gh: GithubRequest,
  ) {}

  public async readState(issue: number): Promise<string> {
    const response = issueSchema.parse(
      JSON.parse((await this.gh(["api", `/repos/${this.repository}/issues/${issue}`])).stdout),
    );
    return response.state.toUpperCase();
  }

  public async reopenWronglyClosed(pr: number, issue: number): Promise<void> {
    if ((await this.readState(issue)) !== "CLOSED") return;
    const marker = `<!-- tanren-cra:issue-close-reconciliation pr=${pr} issue=${issue} -->`;
    const pages = issueCommentsSchema.parse(
      JSON.parse(
        (
          await this.gh([
            "api",
            "--method",
            "GET",
            "--paginate",
            "--slurp",
            `/repos/${this.repository}/issues/${issue}/comments`,
            "-f",
            "per_page=100",
          ])
        ).stdout,
      ),
    );
    const alreadyCommented = pages
      .flat()
      .some((comment) => comment.user?.login === this.expectedLogin && comment.body.includes(marker));
    if (!alreadyCommented) {
      await this.gh(
        ["api", "--method", "POST", `/repos/${this.repository}/issues/${issue}/comments`, "--input", "-"],
        JSON.stringify({
          body: `${marker}\nCRA security reconciliation: PR #${pr} incorrectly auto-closed this non-audited issue during the merge RTT window. The audited code landed under the head-SHA CAS; this unrelated issue is being reopened.`,
        }),
      );
    }
    await this.gh(
      ["api", "--method", "PATCH", `/repos/${this.repository}/issues/${issue}`, "--input", "-"],
      JSON.stringify({ state: "open", state_reason: "reopened" }),
    );
  }

  public async ensureClosed(issue: number): Promise<void> {
    if ((await this.readState(issue)) === "CLOSED") return;
    await this.gh(
      ["api", "--method", "PATCH", `/repos/${this.repository}/issues/${issue}`, "--input", "-"],
      JSON.stringify({ state: "closed", state_reason: "completed" }),
    );
  }
}
