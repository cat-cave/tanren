// Shared authed force-push of a jj-exported head onto a host branch — the push machinery
// the jj conflict applier (`publishResolved`) AND the §3.1 base-shift CLEAN-rebase push
// reuse, so both land a rewritten head the SAME secure way (App-first/static token, read
// from STDIN, NEVER on the command line). A jj rebase REWRITES history, so the push is
// non-fast-forward by construction (`--force`, exactly like `buildGitHubPushCommand`).

import type { RunnerHandle } from "../../../contracts/allocator.js";
import type { CommandSubstrate } from "../../../contracts/commandSubstrate.js";
import type { SecretStore } from "../../../contracts/secretStore.js";
import type { VcsProvider } from "../../../contracts/vcsProvider.js";
import type { OrgGithubAppInstallation } from "../../../config/orgConfig.js";
import type { GithubAppTokenMinter } from "../../../providers/githubAppTokenMinter.js";
import { githubHttpsRemote, parseGitHubRepository } from "../../../providers/github.js";
import { gitAuthedCommand, gitTokenAuthPrelude } from "../../../workspace/githubPush.js";
import { quoteSshShellArg } from "../../../ssh/command.js";
import { runWorkspaceSshCommand } from "../../../workspace/ssh.js";

/** The repo + branch + credential facts an authed jj head push needs. */
export interface JjAuthedPushInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  /** The clone/push URL (also the HTTPS remote). */
  repoUrl: string;
  /** The PR/run head branch the exported resolved/rebased head is force-pushed onto. */
  headBranch: string;
  /** The org App installation (App-first push token), when the org installed the App. */
  installation?: OrgGithubAppInstallation;
  /** The static fallback push credential ref. */
  githubCredentialRef: string;
  timeoutMs: number;
}

/**
 * Resolve the App-first/static push token, then force-push `refs/heads/<headBranch>` onto
 * the host. When NEITHER an installation nor a static ref is configured (a genuinely public
 * path) the push is anonymous (`git push --force origin ...`). The token never appears on
 * the command line — `gitTokenAuthPrelude` reads it from stdin into a 0700 temp file.
 */
export async function pushJjHead(input: JjAuthedPushInput): Promise<void> {
  const staticRef = input.githubCredentialRef.trim();
  const token =
    input.installation === undefined && staticRef === ""
      ? undefined
      : (
          await input.vcsProvider.resolveToken({
            secrets: input.secrets,
            ...(input.installation !== undefined && { installation: input.installation }),
            ...(staticRef !== "" && { staticRef }),
            ...(input.githubAppMinter !== undefined && { minter: input.githubAppMinter }),
          })
        ).token;
  const refspec = quoteSshShellArg(`refs/heads/${input.headBranch}:refs/heads/${input.headBranch}`);
  if (token === undefined) {
    await runWorkspaceSshCommand(input.ssh, input.target, {
      label: "jj publish: push head",
      cwd: input.workspacePath,
      timeoutMs: input.timeoutMs,
      command: ["set -eu", `git push --force origin ${refspec}`].join(" && "),
    });
    return;
  }
  const remote = quoteSshShellArg(githubHttpsRemote(parseGitHubRepository(input.repoUrl)));
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "jj publish: push head (authed)",
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    command: ["set -eu", ...gitTokenAuthPrelude(), gitAuthedCommand(["push", "--force", remote, refspec])].join(" && "),
    stdin: token,
  });
}
