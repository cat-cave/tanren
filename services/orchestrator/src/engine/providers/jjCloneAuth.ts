// §3.4 AUTHENTICATED jj CLONE — the clone-credential type + the command builder for
// `JjWorkspaceVcsCore.openWorkspace`. Extracted so the core stays under the 500-line cap.
//
// `jj git clone --colocate` shells the `git` CLI for the underlying fetch (jj 0.42's
// `git.subprocess` default), so it honors `GIT_ASKPASS`. We thread the resolved
// installation/static token through the SAME `gitTokenAuthPrelude` credential helper the
// git clone/push paths use — the token is read from STDIN into a 0700 temp file, NEVER on
// the command line / process args / any emitted event — against the HTTPS remote
// (`x-access-token:<token>`). Without this a PRIVATE-repo clone fails at the first fetch,
// killing all three flag-on jj paths (`liveJjWorkspace` resolved the token only for the bot
// commit identity, never for the clone fetch itself).

import { quoteSshShellArg } from "../ssh/command.js";
import { gitTokenAuthPrelude } from "../workspace/githubPush.js";

/** The clone CREDENTIAL the `jj git clone` fetch authenticates with (see the module header). */
export interface JjCloneCredential {
  /** The resolved installation/static token (used as the `x-access-token` HTTPS password). */
  token: string;
  /** The HTTPS remote the authenticated clone targets (`https://github.com/owner/repo.git`). */
  httpsRemote: string;
}

/** The mkdir + clone shell command for openWorkspace, run cwd-less (the dir is the clone arg). */
export interface JjCloneCommand {
  command: string;
  /** Present only on the authenticated path — the token fed to the askpass helper via stdin. */
  stdin?: string;
}

/**
 * Build the `mkdir -p <path> && jj git clone --colocate ...` command. ANONYMOUS when no
 * credential (a genuinely public repo / the conformance fixture's local path); AUTHENTICATED
 * when a credential is present — the askpass prelude consumes the token from stdin and
 * `git.subprocess=true` makes the git-CLI fetch (which consults GIT_ASKPASS) explicit
 * regardless of any jj default. `--colocate` keeps a real .git backend so the host stays a
 * plain git remote.
 */
export function buildJjCloneCommand(
  path: string,
  source: string,
  credential: JjCloneCredential | undefined,
): JjCloneCommand {
  if (credential === undefined) {
    return {
      command: [
        "set -eu",
        `mkdir -p ${quoteSshShellArg(path)}`,
        `jj git clone --colocate ${quoteSshShellArg(source)} ${quoteSshShellArg(path)}`,
      ].join(" && "),
    };
  }
  return {
    command: [
      "set -eu",
      ...gitTokenAuthPrelude(),
      `mkdir -p ${quoteSshShellArg(path)}`,
      `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass" GITHUB_TOKEN_FILE="$token_file" ` +
        `jj git clone --colocate --config git.subprocess=true ` +
        `${quoteSshShellArg(credential.httpsRemote)} ${quoteSshShellArg(path)}`,
    ].join(" && "),
    stdin: credential.token,
  };
}
