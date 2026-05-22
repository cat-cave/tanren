import type { SshTarget } from "../contracts/allocator.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { SshSubstrate } from "../contracts/sshSubstrate.js";
import { validateGithubCredentialRef, validateGithubToken } from "../credentials/githubToken.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand } from "./ssh.js";

export interface DraftPrBranchInput {
  runId: string;
  requestedBranch?: string;
}

export interface GitHubWorkspacePushInput {
  secrets: SecretStore;
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  repoUrl: string;
  branch: string;
  credentialRef: string;
  timeoutMs: number;
}

export async function pushWorkspaceBranchToGitHub(input: GitHubWorkspacePushInput): Promise<void> {
  const credentialRef = validateGithubCredentialRef(input.credentialRef);
  const secret = await input.secrets.get(credentialRef);
  if (secret === undefined) {
    throw new Error(`missing GitHub credential ref: ${credentialRef}`);
  }
  const token = validateGithubToken(secret.value);
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "push workspace branch to GitHub",
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    command: buildGitHubPushCommand({ repoUrl: input.repoUrl, branch: input.branch }),
    stdin: token
  });
}

export function draftPrBranchName(input: DraftPrBranchInput): string {
  if (input.requestedBranch !== undefined && input.requestedBranch !== "") {
    return validateGitBranchName(input.requestedBranch);
  }
  if (!/^run_[A-Za-z0-9._-]+$/.test(input.runId)) {
    throw new Error(`unsafe run id for draft PR branch: ${input.runId}`);
  }
  return validateGitBranchName(`tanren/${input.runId}`);
}

export function validateGitBranchName(branch: string): string {
  if (
    branch === "" ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".lock") ||
    /(^|\/)\./.test(branch) ||
    /[\s~^:?*[\\]/.test(branch) ||
    hasGitRefControlCharacter(branch)
  ) {
    throw new Error(`unsafe git branch name: ${branch}`);
  }
  return branch;
}

function hasGitRefControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

export function buildGitHubPushCommand(input: { repoUrl: string; branch: string }): string {
  const branch = validateGitBranchName(input.branch);
  const remote = githubHttpsRemote(parseGitHubRepository(input.repoUrl));
  const askpassScript = [
    "#!/bin/sh",
    "case \"$1\" in",
    "*Username*) printf '%s\\n' 'x-access-token' ;;",
    "*) cat \"$GITHUB_TOKEN_FILE\" ;;",
    "esac",
    ""
  ].join("\n");

  return [
    "set -eu",
    "tmpdir=$(mktemp -d)",
    "cleanup() { rm -rf \"$tmpdir\"; }",
    "trap cleanup EXIT",
    "umask 077",
    "token_file=\"$tmpdir/github-token\"",
    "askpass=\"$tmpdir/git-askpass.sh\"",
    "cat > \"$token_file\"",
    `printf %s ${quoteSshShellArg(askpassScript)} > "$askpass"`,
    "chmod 700 \"$askpass\"",
    [
      "GIT_TERMINAL_PROMPT=0",
      "GIT_ASKPASS=\"$askpass\"",
      "GITHUB_TOKEN_FILE=\"$token_file\"",
      "git",
      "push",
      quoteSshShellArg(remote),
      quoteSshShellArg(`HEAD:refs/heads/${branch}`)
    ].join(" ")
  ].join(" && ");
}
