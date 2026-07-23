import { z } from "zod";
import type { CraConfig } from "./config.js";
import type { FindingIssueCreate, FindingIssueGateway } from "./findingIssues.js";
import { githubTokenEnvironment } from "./githubApp.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";

const API_VERSION = "2022-11-28";
const issueSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  body: z.string().nullable(),
});
const searchSchema = z.object({ items: z.array(issueSchema) });

export class GithubFindingIssueGateway implements FindingIssueGateway {
  private readonly owner: string;
  private readonly name: string;
  private readonly issueNumbersByDatabaseId = new Map<number, number>();

  public constructor(
    private readonly config: CraConfig,
    private readonly token: string,
    private readonly executor: CommandExecutor = execute,
  ) {
    [this.owner, this.name] = config.repository.split("/") as [string, string];
  }

  public async findByMarker(marker: string): Promise<number | null> {
    const response = searchSchema.parse(
      JSON.parse(
        (
          await this.gh([
            "api",
            "--method",
            "GET",
            "/search/issues",
            "-f",
            `q="${marker}" repo:${this.config.repository} in:body`,
          ])
        ).stdout,
      ),
    );
    const matches = response.items.filter((issue) => issue.body?.includes(`<!-- ${marker} -->`) === true);
    if (matches.length > 1) throw new Error(`finding marker is not unique: ${marker}`);
    return matches[0]?.number ?? null;
  }

  public async create(input: FindingIssueCreate): Promise<number> {
    const response = issueSchema.parse(
      JSON.parse(
        (
          await this.gh(
            ["api", "--method", "POST", `/repos/${this.owner}/${this.name}/issues`, "--input", "-"],
            JSON.stringify(input),
          )
        ).stdout,
      ),
    );
    if (response.body !== input.body)
      throw new Error(`created issue #${response.number} failed read-after-write body check`);
    return response.number;
  }

  public async listBlockedBy(issue: number): Promise<readonly number[]> {
    const response = z
      .array(z.object({ number: z.number().int().positive() }))
      .parse(
        JSON.parse(
          (
            await this.gh([
              "api",
              "--method",
              "GET",
              "--paginate",
              `/repos/${this.owner}/${this.name}/issues/${issue}/dependencies/blocked_by`,
            ])
          ).stdout,
        ),
      );
    return response.map((blocker) => blocker.number);
  }

  public async issueDatabaseId(issue: number): Promise<number> {
    const response = issueSchema.parse(
      JSON.parse((await this.gh(["api", `/repos/${this.owner}/${this.name}/issues/${issue}`])).stdout),
    );
    this.issueNumbersByDatabaseId.set(response.id, response.number);
    return response.id;
  }

  public async addBlockedBy(issue: number, blockerDatabaseId: number): Promise<void> {
    await this.gh(
      [
        "api",
        "--method",
        "POST",
        `/repos/${this.owner}/${this.name}/issues/${issue}/dependencies/blocked_by`,
        "--input",
        "-",
      ],
      JSON.stringify({ issue_id: blockerDatabaseId }),
    );
    const blockers = await this.listBlockedBy(issue);
    const blocker = this.issueNumbersByDatabaseId.get(blockerDatabaseId);
    if (blocker === undefined) throw new Error(`unknown blocker database id ${blockerDatabaseId}`);
    if (!blockers.includes(blocker)) throw new Error(`blocked_by edge for issue #${issue} failed read-after-write`);
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
