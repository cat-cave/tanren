// Shared authed force-push of a jj-exported head onto a host branch — the push machinery
// the jj conflict applier (`publishResolved`) AND the §3.1 base-shift CLEAN-rebase push
// reuse, so both land a rewritten head the SAME secure way (App-first/static token, read
// from STDIN, NEVER on the command line). A jj rebase REWRITES history, so the push is
// non-fast-forward by construction.
//
// #1059 — NOT a blind `--force`: the publish is guarded by `--force-with-lease=refs/heads/
// <head>:<expectedRemoteHeadSha>`, where `expectedRemoteHeadSha` is the sha jj FETCHED for the
// head BEFORE the rebase (`readFetchedPublishedHeadSha`). Because the workspace fetches → rebases
// → runs the answerer → re-gates (MINUTES), a reviewer/writer commit pushed to the PR branch
// during that window would be silently overwritten by a blind force, and the stale head then
// CAS-lands to `main` — the reviewer fix lost. The lease makes git REJECT the push (non-zero
// exit) when the remote head MOVED, and the base-shift coordinator maps that throw to a HOLD +
// re-drive (re-fetch, re-rebase incorporating the new commit, re-gate) — fail-closed, never a
// silent overwrite, never a proceed-to-land on the stale head.

import type { RunnerHandle } from "../../../contracts/allocator.js";
import type { CommandSubstrate } from "../../../contracts/commandSubstrate.js";
import type { SecretStore } from "../../../contracts/secretStore.js";
import type { OrgGithubAppInstallation } from "../../../config/orgConfig.js";
import type { GithubAppTokenMinter } from "../../../providers/githubAppTokenMinter.js";
import { resolveVcsToken } from "../../../credentials/vcsCredentials.js";
import { githubHttpsRemote, parseGitHubRepository, type GitHubHttpClient } from "../../../providers/github.js";
import { forceWithLeaseArg, gitAuthedCommand, gitTokenAuthPrelude } from "../../../workspace/githubPush.js";
import { quoteSshShellArg } from "../../../ssh/command.js";
import { buildActivityWatchdog } from "../../../ssh/activityWatchdog.js";
import { runWorkspaceSshCommand } from "../../../workspace/ssh.js";

/** The repo + branch + credential facts an authed jj head push needs. */
export interface JjAuthedPushInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  secrets: SecretStore;
  orgId: string;
  /** The shared (timed) GitHub HTTP client the push-token resolution reads through. */
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  /** The clone/push URL (also the HTTPS remote). */
  repoUrl: string;
  /** The PR/run head branch the exported resolved/rebased head is force-pushed onto. */
  headBranch: string;
  /**
   * #1059 — the sha jj FETCHED for `headBranch` BEFORE the rebase (`readFetchedPublishedHeadSha`,
   * i.e. `<headBranch>@origin`). The publish leases against it (`--force-with-lease`): the push
   * lands ONLY if the remote head still equals this value, else git rejects it (a concurrent
   * reviewer/writer commit moved the head during the rebase+re-gate window) → the caller HOLDs +
   * re-drives. FAIL-CLOSED: a non-40-hex value throws (`forceWithLeaseArg`).
   */
  expectedRemoteHeadSha: string;
  /** The org App installation (App-first push token), when the org installed the App. */
  installation?: OrgGithubAppInstallation;
  /** The static fallback push credential ref. */
  githubCredentialRef: string;
}

/**
 * Resolve the App-first/static push token, then force-push `refs/heads/<headBranch>` onto
 * the host. When NEITHER an installation nor a static ref is configured (a genuinely public
 * path) the push is anonymous (`git push --force origin ...`). The token never appears on
 * the command line — `gitTokenAuthPrelude` reads it from stdin into a 0700 temp file.
 */
export async function pushJjHead(input: JjAuthedPushInput): Promise<void> {
  const staticRef = input.githubCredentialRef.trim();
  // §5a: credential PLUMBING — resolve the push token via the standalone helper over the
  // shared GitHub client, never a forge op on a host seam.
  const token =
    input.installation === undefined && staticRef === ""
      ? undefined
      : (
          await resolveVcsToken(input.githubHttp, {
            secrets: input.secrets,
            orgId: input.orgId,
            ...(input.installation !== undefined && { installation: input.installation }),
            ...(staticRef !== "" && { staticRef }),
            ...(input.githubAppMinter !== undefined && { minter: input.githubAppMinter }),
          })
        ).token;
  const refspec = quoteSshShellArg(`refs/heads/${input.headBranch}:refs/heads/${input.headBranch}`);
  // #1059: lease against the sha we FETCHED — reject (never blind-overwrite) a moved remote head.
  const lease = quoteSshShellArg(forceWithLeaseArg(input.headBranch, input.expectedRemoteHeadSha));
  if (token === undefined) {
    await runWorkspaceSshCommand(input.ssh, input.target, {
      label: "jj publish: push head",
      cwd: input.workspacePath,
      watchdog: buildActivityWatchdog({
        substrate: input.ssh,
        target: input.target,
        cls: "vcs",
        workspace: input.workspacePath,
      }),
      command: ["set -eu", `git push ${lease} origin ${refspec}`].join(" && "),
    });
    return;
  }
  const remote = quoteSshShellArg(githubHttpsRemote(parseGitHubRepository(input.repoUrl)));
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "jj publish: push head (authed)",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    command: ["set -eu", ...gitTokenAuthPrelude(), gitAuthedCommand(["push", lease, remote, refspec])].join(" && "),
    stdin: token,
  });
}
