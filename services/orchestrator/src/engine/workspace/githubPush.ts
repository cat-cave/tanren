import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { runWorkspaceSshCommand } from "./ssh.js";

export interface DraftPrBranchInput {
  runId: string;
  requestedBranch?: string;
}

export interface GitHubWorkspacePushInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  repoUrl: string;
  branch: string;
  /**
   * the pre-resolved push token. The caller (the VcsProvider) mints an
   * App installation token (or reads the static secret) via the token resolver
   * and passes it here. Installation tokens are used over HTTPS as the
   * `x-access-token` password, exactly like a PAT, so the `git push` command
   * below is unchanged.
   */
  token: string;
  /**
   * The local gitref pushed as the PR branch. Defaults to "HEAD". The run path
   * passes {@link PR_CLEAN_REF} — the writer commits replayed onto the clone HEAD
   * with the bootstrap commit dropped — so the PR carries only the writer's
   * changes (no lockfile / node_modules).
   */
  sourceRef?: string;
}

// The local ref the cleaned PR commits are staged onto before the push. Kept
// off any user branch name so it never collides with a target-repo branch.
export const PR_CLEAN_REF = "refs/tanren/pr-clean";

export interface PrepareCleanPrBranchInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The clone HEAD (run-base before bootstrap) the writer commits replay onto.
  cloneHeadSha: string;
  // The synthetic bootstrap commit (the writer's diff base) to drop.
  bootstrapSha: string;
}

/**
 * The cleaned push source: the gitref the caller pushes the PR branch from, plus the
 * EXACT sha that ref resolves to — the commit that becomes the PR head on the forge.
 *
 * COMMIT-BINDING (the gate↔land TOCTOU guard, tanren-owns-the-engine.md §5): the
 * pushed sha is DISTINCT from the workspace HEAD whenever a real bootstrap commit was
 * dropped (the working HEAD stays at the writer tip — bootstrap commit and all — so a
 * review-rework can keep diffing vs its base). The `pre_merge` gate MUST anchor its
 * `gate.verdict` on THIS `headSha` (the future PR head), not the workspace HEAD, or the
 * land authority blocks forever (`gatedHeadSha != landing head`).
 */
export interface CleanedPushSource {
  /** The gitref to push from: {@link PR_CLEAN_REF} (cleaned) or "HEAD" (nothing to drop). */
  ref: string;
  /**
   * The sha `ref` resolves to — the commit that becomes the PR head. "" only on a
   * fake-SSH unit path (no real workspace); the merge gate then anchors on the
   * workspace HEAD as before (also "" there ⇒ no verdict event).
   */
  headSha: string;
}

// Builds a ref ({@link PR_CLEAN_REF}) holding the writer's commits replayed onto
// the clone HEAD — i.e. with the synthetic bootstrap commit (and its install
// artifacts: lockfiles, node_modules) dropped — and points the push branch at
// it. Returns the gitref the caller pushes from instead of the working HEAD.
//
// This does NOT move the working HEAD: the writer's diff base (bootstrapSha)
// stays an ancestor of HEAD so a review-rework re-entry can keep diffing/
// committing vs it. We rebase a detached copy and capture its sha into
// PR_CLEAN_REF.
//
// The rebase runs with `--autostash` so dirty working-tree artifacts from the
// per-iteration gates (rspec `reports/`, rubocop autocorrects, etc.) don't
// block the cleanup with `cannot rebase: You have unstaged changes` — apex v65
// halted exactly there. Those artifacts are disposable per-iteration evidence
// already captured in the gate's `gate.verdict` event payload; they were never
// something we want in the PR commit. Autostash pops them back after the
// rebase, leaving the working tree intact. On a stash-pop conflict git leaves
// the stash in `refs/stash` for manual recovery, but the rebase itself still
// succeeds and PR_CLEAN_REF still gets the correct sha — which is all the
// push needs (the runner is released right after).
//
// When cloneHeadSha/bootstrapSha are empty (fake-SSH unit paths) or equal (no
// real bootstrap commit), there is nothing to drop and the working HEAD is
// pushed unchanged.
//
// Returns the push ref AND the sha it resolves to (the future PR head) — see
// {@link CleanedPushSource}. The merge gate anchors its verdict on this sha so the
// land authority's gate↔land commit-binding (§5) holds (the workspace HEAD, left at
// the writer tip with the bootstrap commit, is a DIFFERENT sha than what is pushed).
export async function prepareCleanPrBranch(input: PrepareCleanPrBranchInput): Promise<CleanedPushSource> {
  if (input.cloneHeadSha === "" || input.bootstrapSha === "" || input.cloneHeadSha === input.bootstrapSha) {
    // Nothing to drop: the working HEAD IS the PR head. Resolve its sha so the merge
    // gate still anchors on the exact pushed commit ("" on a fake SSH ⇒ no verdict).
    const head = await runWorkspaceSshCommand(input.ssh, input.target, {
      label: "resolve clean PR head sha",
      cwd: input.workspacePath,
      watchdog: buildActivityWatchdog({
        substrate: input.ssh,
        target: input.target,
        cls: "vcs",
        workspace: input.workspacePath,
      }),
      command: "git rev-parse HEAD",
    });
    return { ref: "HEAD", headSha: validateResolvedSha(head.stdout.trim()) };
  }
  const result = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "prepare clean PR branch",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    command: [
      "set -eu",
      // Remember where the working HEAD sits so we can restore it after rebasing
      // a detached copy (the writer's base must stay reachable for reworks).
      "orig_head=$(git rev-parse HEAD)",
      // Detach at the writer tip, then replay the writer commits
      // (bootstrapSha..HEAD) onto the clone HEAD — dropping the bootstrap commit.
      // The working branch ref is untouched (we are detached).
      'git checkout --quiet --detach "$orig_head"',
      `GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git rebase --autostash --onto ${quoteSshShellArg(input.cloneHeadSha)} ${quoteSshShellArg(input.bootstrapSha)}`,
      // Capture the cleaned tip into the push ref, then restore the working HEAD.
      `git update-ref ${quoteSshShellArg(PR_CLEAN_REF)} HEAD`,
      'git checkout --quiet --detach "$orig_head"',
      // Echo the cleaned tip (the future PR head) LAST so it is the command's stdout —
      // the sha the merge gate anchors its verdict on (the gate↔land commit-binding).
      `git rev-parse ${quoteSshShellArg(PR_CLEAN_REF)}`,
    ].join(" && "),
  });
  return { ref: PR_CLEAN_REF, headSha: validateResolvedSha(result.stdout.trim()) };
}

// Guards the sha echoed from the clean-PR prep: a real runner returns a 40-hex sha;
// a fake-SSH unit path yields "" (the merge gate then falls back to the workspace
// HEAD, also "" there ⇒ no verdict event). Anything else is a corrupt read — throw
// loudly rather than anchor the merge gate on a bogus commit.
function validateResolvedSha(sha: string): string {
  if (sha !== "" && !/^[0-9a-f]{40}$/u.test(sha)) {
    throw new Error(`clean PR head resolution returned invalid sha: ${sha}`);
  }
  return sha;
}

export async function pushWorkspaceBranchToGitHub(input: GitHubWorkspacePushInput): Promise<void> {
  await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "push workspace branch to GitHub",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    command: buildGitHubPushCommand({ repoUrl: input.repoUrl, branch: input.branch, sourceRef: input.sourceRef }),
    stdin: input.token,
  });
}

export function draftPrBranchName(input: DraftPrBranchInput): string {
  if (input.requestedBranch !== undefined && input.requestedBranch !== "") {
    return validateGitBranchName(input.requestedBranch);
  }
  if (!/^run_[A-Za-z0-9._-]+$/u.test(input.runId)) {
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
    /(^|\/)\./u.test(branch) ||
    /[\s~^:?*[\\]/u.test(branch) ||
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

// The shell-environment prefix that makes a single `git` invocation
// authenticate over HTTPS as `x-access-token:<token>`, where the token is read
// from a temp file written from the command's stdin. Prepend this to any git
// subcommand string. Kept as discrete tokens so callers `.join(" ")` it onto
// their git args.
const GIT_AUTH_ENV_PREFIX = ["GIT_TERMINAL_PROMPT=0", 'GIT_ASKPASS="$askpass"', 'GITHUB_TOKEN_FILE="$token_file"'];

// The shell prelude (run before the authed git command) that consumes the
// command's stdin as the GitHub token and writes the GIT_ASKPASS helper that
// feeds it. The token is read from stdin — it never appears in the command
// string, the process args, or any emitted event — and the temp dir is removed
// on exit. The trailing `git ...` invocation must be prefixed with
// {@link GIT_AUTH_ENV_PREFIX}. Shared by clone (read) and push (write) so both
// authenticate private repos the same secure way.
export function gitTokenAuthPrelude(): string[] {
  const askpassScript = [
    "#!/bin/sh",
    'case "$1" in',
    "*Username*) printf '%s\\n' 'x-access-token' ;;",
    '*) cat "$GITHUB_TOKEN_FILE" ;;',
    "esac",
    "",
  ].join("\n");
  return [
    "tmpdir=$(mktemp -d)",
    'cleanup() { rm -rf "$tmpdir"; }',
    "trap cleanup EXIT",
    "umask 077",
    'token_file="$tmpdir/github-token"',
    'askpass="$tmpdir/git-askpass.sh"',
    'cat > "$token_file"',
    `printf %s ${quoteSshShellArg(askpassScript)} > "$askpass"`,
    'chmod 700 "$askpass"',
  ];
}

// Prefixes a git subcommand (its already-quoted args) with the auth env so it
// authenticates via the {@link gitTokenAuthPrelude} credential helper.
export function gitAuthedCommand(gitArgs: string[]): string {
  return [...GIT_AUTH_ENV_PREFIX, "git", ...gitArgs].join(" ");
}

export function buildGitHubPushCommand(input: { repoUrl: string; branch: string; sourceRef?: string }): string {
  const branch = validateGitBranchName(input.branch);
  const sourceRef = validatePushSourceRef(input.sourceRef);
  const remote = githubHttpsRemote(parseGitHubRepository(input.repoUrl));

  return [
    "set -eu",
    ...gitTokenAuthPrelude(),
    gitAuthedCommand([
      "push",
      "--force",
      quoteSshShellArg(remote),
      quoteSshShellArg(`${sourceRef}:refs/heads/${branch}`),
    ]),
  ].join(" && ");
}

// The push source ref is operator/code-controlled, never user-derived: only the
// working HEAD or the cleaned PR ref. Reject anything else so the push refspec
// can never be smuggled into.
function validatePushSourceRef(sourceRef: string | undefined): string {
  if (sourceRef === undefined || sourceRef === "HEAD") {
    return "HEAD";
  }
  if (sourceRef === PR_CLEAN_REF) {
    return PR_CLEAN_REF;
  }
  throw new Error(`unsafe push source ref: ${sourceRef}`);
}
