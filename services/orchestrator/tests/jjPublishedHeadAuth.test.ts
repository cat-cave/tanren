// REGRESSION (apex v95/v96 private-repo `merge.conflict` STALL): the base-shift /
// conflict-resolve published-head prep ran `jj git fetch --remote origin` UNAUTHENTICATED.
// On a live run the workspace `origin` is the HTTPS remote the AUTHENTICATED `jj git clone`
// cloned from, so on a PRIVATE repo the fetch failed
//   fatal: could not read Username for 'https://github.com': No such device or address
// which under `set -eu` aborted the whole base-shift prep → the coordinator mapped the throw
// to `merge.conflict` → dequeue → every dependent PR that went "behind" stalled forever.
//
// This suite pins the FIX: `trackPublishedHeadCommands` authenticates the fetch the SAME way
// the clone does (the `gitTokenAuthPrelude` askpass helper + `git.subprocess=true`, token from
// STDIN) when a clone credential is present, and stays a bare anonymous fetch when not — and
// the token NEVER appears in the emitted command string (only in stdin).

import { describe, expect, it } from "vitest";

import { trackPublishedHeadCommands } from "../src/engine/providers/jjPublishedHead.js";

const HEAD = "tanren/build-a41f8ca2";
const TOKEN = "ghs_super_secret_token_deadbeef";

/** The single joined shell string the caller runs (what a WorkspaceCommandError would log). */
function joined(commands: string[]): string {
  return ["set -eu", ...commands, "jj config set --repo x none()"].join(" && ");
}

describe("trackPublishedHeadCommands — authenticated published-head fetch", () => {
  it("ANONYMOUS (no credential): a bare fetch, no askpass, no stdin", () => {
    const prep = trackPublishedHeadCommands(HEAD);
    const cmd = joined(prep.commands);

    // A bare fetch against the origin remote — public repo / local-path fixture needs no auth.
    expect(cmd).toContain(`jj git fetch --branch '${HEAD}' --remote origin`);
    // No credential machinery on the anonymous path.
    expect(prep.stdin).toBeUndefined();
    expect(cmd).not.toContain("GIT_ASKPASS");
    expect(cmd).not.toContain("git.subprocess=true");
    expect(cmd).not.toContain("mktemp");
    // The track + fail-closed assert survive.
    expect(cmd).toContain(`jj bookmark track '${HEAD}' --remote origin`);
    expect(cmd).toContain(`jj log -r '${HEAD}' --no-graph -T 'commit_id' >/dev/null`);
  });

  it("AUTHENTICATED (credential present): askpass prelude + git.subprocess fetch; token only in stdin", () => {
    const prep = trackPublishedHeadCommands(HEAD, { token: TOKEN });
    const cmd = joined(prep.commands);

    // The askpass prelude (token read from stdin into a 0700 temp file) is prepended, and the
    // fetch consults GIT_ASKPASS against the HTTPS origin with the git-CLI subprocess explicit.
    expect(cmd).toContain("mktemp -d");
    expect(cmd).toContain('GIT_ASKPASS="$askpass"');
    expect(cmd).toContain('GITHUB_TOKEN_FILE="$token_file"');
    expect(cmd).toContain(`jj git fetch --branch '${HEAD}' --remote origin --config git.subprocess=true`);
    // The token is fed via STDIN…
    expect(prep.stdin).toBe(TOKEN);
    // …and NEVER appears in the command string (the value a WorkspaceCommandError logs).
    expect(cmd).not.toContain(TOKEN);
    // The track + fail-closed assert still follow the authed fetch.
    expect(cmd).toContain(`jj bookmark track '${HEAD}' --remote origin`);
    expect(cmd).toContain(`jj log -r '${HEAD}' --no-graph -T 'commit_id' >/dev/null`);
  });
});
