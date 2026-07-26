import type { RunnerHandle } from "../contracts/allocator.js";
import type { ActorIdentity } from "../contracts/codeHostTypes.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { githubHttpsRemote, parseGitHubRepository } from "../providers/github.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { runWorkspaceSshCommand } from "./ssh.js";

export interface DraftPrBranchInput {
  runId: string;
  requestedBranch?: string;
}

export type GitHubPushLease = { expectedSha: string } | { expectedAbsent: true };

export interface GitHubWorkspacePushInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  repoUrl: string;
  branch: string;
  /**
   * the pre-resolved push token. The caller resolves it via `resolveVcsToken`
   * (App installation token or static secret) and passes it here. Installation
   * tokens are used over HTTPS as the `x-access-token` password, exactly like a
   * PAT, so the `git push` command below is unchanged.
   */
  token: string;
  /**
   * The local gitref pushed as the PR branch. Defaults to "HEAD". The run path
   * passes {@link PR_CLEAN_REF} — the writer commits replayed onto the clone HEAD
   * with the bootstrap commit dropped — so the PR carries only the writer's
   * changes (no lockfile / node_modules).
   */
  sourceRef?: string;
  /** Exact remote-state proof required before every GitHub branch update. */
  forceWithLease: GitHubPushLease;
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
  // The run id — stamped into the composed commit's message so the PR head carries
  // provenance back to the run whose writer produced it (the per-subtask event trail
  // lives in `writer.subtask.completed`; the commit message carries the pointer).
  runId: string;
  // MERGE-SAFETY (self-identity): the run's RESOLVED GitHub pushing identity (login +
  // canonical `<id>+<login>@users.noreply.github.com`), the SAME identity the writer
  // commits carry (`configureWorkspaceGitIdentity`). The composed PR-head commit is
  // authored + committed as THIS identity so GitHub attributes it to the bot login the
  // external-change gate recognizes as Tanren's own (never `<unknown>`, which blocks
  // auto-merge under strict/lenient). Absent ONLY on the genuinely UNAUTHENTICATED
  // public-repo clone (no identity resolved) — that path never pushes as Tanren, so the
  // non-attributable `Tanren Composer` fallback is moot there.
  pushIdentity?: ActorIdentity;
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

// Builds a ref ({@link PR_CLEAN_REF}) holding the writer's cumulative change as ONE
// composed commit whose parent is the clone HEAD — i.e. with the synthetic bootstrap
// commit (and its install artifacts: lockfiles, node_modules) dropped AND the writer's
// per-subtask draft history collapsed. Points the push branch at that ref; returns the
// gitref the caller pushes from instead of the working HEAD.
//
// DIRECT OVERLAY (apex v85 fix; supersedes v71 squash-then-rebase): the PR head must be
// ONE commit parented on cloneHead with tree = "cloneHead + (writer − bootstrap)". The
// v71 path built a single commit (tree = writer HEAD, parent = bootstrapSha) and
// rebased it onto cloneHead. That eliminated inter-writer draft self-conflicts, but a
// SINGLE composed commit can still 3-way-conflict when bootstrap content diverges from
// cloneHead on paths the writer also touched (content conflict / modify-delete). An autonomous run
// v85 halted there on scaffold (`could not apply … Tanren composed change`, Rebasing
// 1/1) after fixed-point re-drives — needs_attention. Rebase is the wrong tool: the
// desired tree is a pure path overlay, not a patch application.
//
// Construction (object-DB only — never checks out, never moves HEAD, never needs a
// clean working tree; apex v65 dirty-tree + v71 squash + v85 single-commit conflict
// are all closed by construction):
//   1. Private index seeded from cloneHead (`git read-tree`).
//   2. For every path in `git diff-tree bootstrap..HEAD` (writer cumulative delta),
//      force the writer blob (A/M/T) or deletion (D). Paths the writer did not touch
//      keep cloneHead content ⇒ pure bootstrap artifacts drop; writer-touched paths
//      take the writer final blob unconditionally (no 3-way merge ⇒ no conflict).
//   3. `git write-tree` → `git commit-tree <tree> -p cloneHead -m <composed_msg>`.
//   4. `git update-ref PR_CLEAN_REF` — working HEAD stays at the writer tip so a
//      review-rework re-entry keeps its bootstrapSha diff base.
//
// Equivalence: when a perfect rebase of bootstrap→writer onto cloneHead would succeed,
// the overlay tree matches it (pinned by the real-git non-conflict fixture). When the
// rebase would conflict, the overlay still succeeds with writer-wins on those paths.
//
// When cloneHeadSha/bootstrapSha are empty (fake-SSH unit paths) or equal (no real
// bootstrap commit), there is nothing to drop and the working HEAD is pushed unchanged.
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
  const composedMessage = buildComposedCommitMessage(input.runId);
  const cloneHead = quoteSshShellArg(input.cloneHeadSha);
  const bootstrap = quoteSshShellArg(input.bootstrapSha);
  const writerRange = quoteSshShellArg(`${input.bootstrapSha}..HEAD`);
  const prCleanRef = quoteSshShellArg(PR_CLEAN_REF);
  const result = await runWorkspaceSshCommand(input.ssh, input.target, {
    label: "prepare clean PR branch",
    cwd: input.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: input.ssh,
      target: input.target,
      cls: "vcs",
      workspace: input.workspacePath,
    }),
    // POSIX /bin/sh (LocalCommandSubstrate + live runner SSH). No bash-only syntax.
    command: [
      "set -eu",
      // Private index: never touch the real index, working tree, or HEAD. Dirty
      // per-iteration gate artifacts (rspec reports/, rubocop — apex v65) are irrelevant.
      // `delta` materializes name-status so we can two-pass (D then A/M/T) without a
      // pipeline: POSIX sh has no pipefail, so a mid-loop `update-index` failure would
      // otherwise be swallowed when a later D succeeds (dir→file lost the writer file).
      "idx=$(mktemp)",
      "delta=$(mktemp)",
      'trap \'rm -f "$idx" "$delta" "$idx.desc"\' EXIT',
      'export GIT_INDEX_FILE="$idx"',
      // Seed from cloneHead, then overlay the cumulative writer-vs-bootstrap delta.
      // Writer-untouched paths keep cloneHead (bootstrap-only lockfiles drop);
      // writer-touched paths take the writer blob/delete with no 3-way (apex v85).
      `git read-tree ${cloneHead}`,
      // Overlay writer-vs-bootstrap path delta onto the private index.
      // --no-renames keeps statuses in {A,M,D,T}. IFS=tab keeps paths-with-spaces intact.
      // TWO-PASS (dir↔file type change): git refuses `cacheinfo` for file `d` while the
      // index still has tree child `d/a`. diff-tree emits `A d` before `D d/a`, so a
      // single-pass overlay drops the writer file and can still exit 0. Deletions first,
      // then A/M/T; before each cacheinfo, clear exact/descendant/ancestor conflicts.
      `git diff-tree -r --name-status --no-renames ${bootstrap} HEAD > "$delta"`,
      [
        "while IFS=$(printf '\\t') read -r status path; do",
        '  if [ -z "${status:-}" ]; then continue; fi',
        '  if [ "$status" = "D" ]; then',
        '    git update-index --force-remove -- "$path" 2>/dev/null || true',
        "  fi",
        'done < "$delta"',
      ].join("\n"),
      [
        "while IFS=$(printf '\\t') read -r status path; do",
        '  if [ -z "${status:-}" ]; then continue; fi',
        '  case "$status" in',
        "    D)",
        "      ;;",
        "    A|M|T)",
        // Clear index entries that would make `path` both a file and a directory:
        // exact path, any child under path/, and each proper path-prefix (ancestor blob).
        '      git update-index --force-remove -- "$path" 2>/dev/null || true',
        '      git ls-files --cached -- "$path/" > "$idx.desc"',
        "      while IFS= read -r child; do",
        // Same mid-list while + set -e caveat as cacheinfo: fail loud on a real remove.
        '        if [ -n "${child:-}" ]; then git update-index --force-remove -- "$child" || exit 1; fi',
        '      done < "$idx.desc"',
        '      rm -f "$idx.desc"',
        '      rest="$path"',
        '      acc=""',
        "      while :; do",
        '        case "$rest" in',
        "          */*)",
        "            comp=${rest%%/*}",
        "            rest=${rest#*/}",
        '            if [ -z "$acc" ]; then acc="$comp"; else acc="$acc/$comp"; fi',
        '            git update-index --force-remove -- "$acc" 2>/dev/null || true',
        "            ;;",
        "          *)",
        "            break",
        "            ;;",
        "        esac",
        "      done",
        // ls-tree: "<mode> <type> <sha>\\t<path>". cut is POSIX and present on runners.
        '      entry=$(git ls-tree HEAD -- "$path")',
        '      if [ -z "$entry" ]; then',
        '        printf "prepareCleanPrBranch: missing writer tree entry for %s\\n" "$path" >&2',
        "        exit 1",
        "      fi",
        '      mode=$(printf %s "$entry" | cut -d" " -f1)',
        '      sha=$(printf %s "$entry" | cut -d" " -f3 | cut -f1)',
        '      if [ -z "$mode" ] || [ -z "$sha" ]; then',
        '        printf "prepareCleanPrBranch: corrupt ls-tree entry for %s: %s\\n" "$path" "$entry" >&2',
        "        exit 1",
        "      fi",
        // Fail loud — never continue to write-tree after a rejected type-change overlay.
        // Explicit `|| exit 1`: under `set -e`, errexit is ignored inside a mid-list
        // `while` body (`cmd && while …; do …; done && next`), so a bare failed
        // update-index would otherwise continue and write a partial tree.
        '      git update-index --add --cacheinfo "${mode},${sha},${path}" || exit 1',
        "      ;;",
        "    *)",
        '      printf "prepareCleanPrBranch: unexpected diff status %s for %s\\n" "$status" "$path" >&2',
        "      exit 1",
        "      ;;",
        "  esac",
        'done < "$delta"',
      ].join("\n"),
      "clean_tree=$(git write-tree)",
      'rm -f "$idx" "$delta"',
      "unset GIT_INDEX_FILE",
      "trap - EXIT",
      // Provenance from the per-subtask commit range is appended to the composed message
      // so the PR head carries `- <subject>` bullets back to the writer's draft trail.
      `provenance=$(git log --reverse --format='- %s' ${writerRange})`,
      `composed_msg=$(printf %s ${quoteSshShellArg(composedMessage)}; printf '\\n%s\\n' "$provenance")`,
      // Explicit author + committer identity: `git commit-tree` fails hard if
      // user.name/user.email aren't resolvable. MERGE-SAFETY (self-identity): the composed
      // commit — the PR HEAD — is authored + committed as the run's RESOLVED pushing
      // identity (same login the writer commits carry) so GitHub attributes it to the bot
      // login the external-change gate recognizes as Tanren's own. Only the genuinely
      // unauthenticated clone (no identity) falls back to the non-attributable
      // `Tanren Composer` placeholder — that path never pushes as Tanren.
      `composed=$(${composerGitIdentEnv(input.pushIdentity)} git commit-tree "$clean_tree" -p ${cloneHead} -m "$composed_msg")`,
      // Stage the composed tip into the push ref. HEAD is untouched (writer tip stays
      // reachable for review-rework re-entry against bootstrapSha).
      `git update-ref ${prCleanRef} "$composed"`,
      // Echo the cleaned tip (the future PR head) LAST so it is the command's stdout —
      // the sha the merge gate anchors its verdict on (the gate↔land commit-binding).
      `git rev-parse ${prCleanRef}`,
    ].join(" && "),
  });
  return { ref: PR_CLEAN_REF, headSha: validateResolvedSha(result.stdout.trim()) };
}

// The composer git identity + fixed dates for `git commit-tree` (writes the composed
// object). Needs user.name/user.email resolvable or commit-tree fails with
// `fatal: empty ident name`. Fixed dates keep the composed object deterministic across
// re-preps of the same tree (helpful for tests + gate re-anchors).
//
// MERGE-SAFETY (self-identity): when the run resolved a real pushing identity, the
// composed PR-head commit is authored + committed as THAT login + its canonical noreply
// email — exactly the identity the writer commits carry (`configureWorkspaceGitIdentity`)
// — so GitHub attributes the PR head to the bot login the external-change gate treats as
// Tanren's own. Absent identity ⇒ the non-attributable `Tanren Composer` fallback (the
// unauthenticated public-repo clone, which never pushes as Tanren, so attribution is moot).
export function composerGitIdentEnv(identity: ActorIdentity | undefined): string {
  const fixedDates = "GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'";
  if (identity === undefined) {
    return (
      "GIT_AUTHOR_NAME='Tanren Composer' GIT_AUTHOR_EMAIL='composer@tanren.invalid' " +
      "GIT_COMMITTER_NAME='Tanren Composer' GIT_COMMITTER_EMAIL='composer@tanren.invalid' " +
      fixedDates
    );
  }
  const name = quoteSshShellArg(identity.login);
  const email = quoteSshShellArg(identity.noreplyEmail);
  return (
    `GIT_AUTHOR_NAME=${name} GIT_AUTHOR_EMAIL=${email} ` +
    `GIT_COMMITTER_NAME=${name} GIT_COMMITTER_EMAIL=${email} ` +
    fixedDates
  );
}

// The composed-commit message header. The runId anchors provenance back to the run
// whose writer produced this change; the shell prelude appends the per-subtask
// commit subjects (`git log --format='- %s'`) as a bullet list below the header.
// The message is deliberately terse — the detailed writer trail lives in the events
// table (`writer.subtask.completed`), not the PR head.
export function buildComposedCommitMessage(runId: string): string {
  if (runId === "") {
    throw new Error("prepareCleanPrBranch requires a non-empty runId for the composed commit message");
  }
  return `Tanren composed change (${runId})\n\nSquashed writer subtask commits into a single PR head; per-subtask trail:`;
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
    command: buildGitHubPushCommand({
      repoUrl: input.repoUrl,
      branch: input.branch,
      sourceRef: input.sourceRef,
      forceWithLease: input.forceWithLease,
    }),
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

// The `--force-with-lease` guard for a non-fast-forward push (#1059). A jj rebase / conflict
// resolution REWRITES the dependent PR head's history, so the publish is non-fast-forward by
// construction. A BLIND `--force` overwrites whatever the remote branch currently holds — so a
// reviewer/writer commit pushed to that branch DURING our fetch→rebase→answerer→re-gate window
// (minutes) is SILENTLY lost, and the stale head then CAS-lands to `main`. `--force-with-lease`
// makes the push land ONLY if the remote head still equals `expectedSha` (the sha we FETCHED
// before rewriting); if the remote moved, git REJECTS the push (non-zero exit) and the caller
// HOLDs + re-drives (re-fetch, re-rebase incorporating the reviewer commit, re-gate). This is
// the dependent-head analogue of the ff-only `expectedMainSha` CAS on the main-land.
//
// FAIL-CLOSED: a non-40-hex `expectedSha` throws (never degrade to a lease with an empty/bogus
// expected value, which would push effectively-blind).
export function forceWithLeaseArg(branch: string, expectedSha: string): string {
  const validBranch = validateGitBranchName(branch);
  if (!/^[0-9a-f]{40}$/u.test(expectedSha)) {
    throw new Error(`unsafe force-with-lease expected sha for ${branch}: '${expectedSha}'`);
  }
  return `--force-with-lease=refs/heads/${validBranch}:${expectedSha}`;
}

export function forceWithLeaseAbsentArg(branch: string): string {
  return `--force-with-lease=refs/heads/${validateGitBranchName(branch)}:`;
}

export function buildGitHubPushCommand(input: {
  repoUrl: string;
  branch: string;
  sourceRef?: string;
  /** Exact remote-state proof required before every GitHub branch update. */
  forceWithLease: GitHubPushLease;
}): string {
  const branch = validateGitBranchName(input.branch);
  const sourceRef = validatePushSourceRef(input.sourceRef);
  const remote = githubHttpsRemote(parseGitHubRepository(input.repoUrl));
  if (input.forceWithLease === undefined) {
    throw new Error("GitHub push requires an explicit remote-state lease");
  }
  const forceArg = quoteSshShellArg(
    "expectedSha" in input.forceWithLease
      ? forceWithLeaseArg(branch, input.forceWithLease.expectedSha)
      : forceWithLeaseAbsentArg(branch),
  );

  return [
    "set -eu",
    ...gitTokenAuthPrelude(),
    gitAuthedCommand([
      "push",
      forceArg,
      quoteSshShellArg(remote),
      quoteSshShellArg(`${sourceRef}:refs/heads/${branch}`),
    ]),
  ].join(" && ");
}

// The push source ref is operator/code-controlled, never user-derived: only the
// working HEAD, cleaned PR ref, or an immutable lowercase object id resolved by
// the manual publication route. Reject anything else so the push refspec can
// never be smuggled into.
function validatePushSourceRef(sourceRef: string | undefined): string {
  if (sourceRef === undefined || sourceRef === "HEAD") {
    return "HEAD";
  }
  if (sourceRef === PR_CLEAN_REF) {
    return PR_CLEAN_REF;
  }
  if (/^[0-9a-f]{40}$/u.test(sourceRef)) {
    return sourceRef;
  }
  throw new Error(`unsafe push source ref: ${sourceRef}`);
}
