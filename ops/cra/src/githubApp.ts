import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CraConfig } from "./config.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";

const API_VERSION = "2022-11-28";

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

export function createAppJwt(appId: number, privateKey: string, now = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: String(appId) }));
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

function tokenEnvironment(token: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["GITHUB_TOKEN"];
  env["GH_TOKEN"] = token;
  env["GH_PROMPT_DISABLED"] = "1";
  return env;
}

export class GithubAppIdentity {
  public constructor(
    private readonly config: CraConfig,
    private readonly executor: CommandExecutor = execute,
  ) {}

  public async mintInstallationToken(now = new Date()): Promise<string> {
    const privateKey = await readFile(this.config.github.privateKeyPath, "utf8");
    const jwt = createAppJwt(this.config.github.appId, privateKey, now);
    const result = await executeChecked(this.executor, {
      command: this.config.commands.gh,
      args: [
        "api",
        "--method",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `X-GitHub-Api-Version: ${API_VERSION}`,
        `/app/installations/${this.config.github.installationId}/access_tokens`,
        "--jq",
        ".token",
      ],
      env: tokenEnvironment(jwt),
      timeoutMs: 30_000,
    });
    const token = result.stdout.trim();
    if (token.length < 20 || /\s/u.test(token)) throw new Error("GitHub App returned an invalid installation token");
    return token;
  }

  public async verify(token: string): Promise<string> {
    const result = await executeChecked(this.executor, {
      command: this.config.commands.gh,
      args: [
        "api",
        "graphql",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `X-GitHub-Api-Version: ${API_VERSION}`,
        "-f",
        "query=query { viewer { login } }",
        "--jq",
        ".data.viewer.login",
      ],
      env: tokenEnvironment(token),
      timeoutMs: 30_000,
    });
    const login = result.stdout.trim();
    if (login !== this.config.github.expectedLogin) {
      throw new Error(
        `GitHub identity mismatch: expected ${this.config.github.expectedLogin}, received ${login || "empty"}`,
      );
    }
    return login;
  }
}

export function githubTokenEnvironment(token: string): NodeJS.ProcessEnv {
  return tokenEnvironment(token);
}
