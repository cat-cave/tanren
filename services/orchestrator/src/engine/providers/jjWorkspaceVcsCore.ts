// The Wave-1 jujutsu (jj) implementation of the `WorkspaceVcsCore` seam
// (engine/contracts/workspaceVcsCore.ts, tanren-owns-the-engine.md §2). jj's
// native primitives ARE the machinery Tanren was hand-rolling: a rebase that
// conflicts STILL SUCCEEDS and records the conflict IN the commit; editing an
// ancestor auto-restacks descendants and PROPAGATES the resolution down; the
// operation log makes every op undoable. So "a conflict must never brick" is true
// by construction here, not by a `git merge --abort` dance.
//
// SUBSTRATE: this impl shells the `jj` CLI through the same {@link CommandSubstrate}
// the rest of the runner workspace code uses (engine/workspace/githubPush.ts,
// plannerRunWorkspace.ts). It runs jj over SSH against the allocated runner exactly
// like `git`. The §7 guardrail ("jj-lib as the state authority, NOT CLI
// text-parsing") is the Rust-rewrite target; this TypeScript orchestrator drives jj
// over the command substrate and reads jj's own machine-stable signals (its
// `--no-graph` template output + nonzero exit on a conflicted export), never
// scraping the human graph log.
//
// REF RESOLUTION SEAM ({@link JjRefResolver}): production threads real repo URLs +
// real git shas straight through (the identity resolver). The conformance harness
// injects a resolver that maps the suite's synthetic `repoUrl` / base-sha tokens
// onto a local fixture repo's refs — the SAME seam shape as the clone-credential
// thread in plannerRunWorkspace.ts, not a test-only branch baked into the engine.

import { createHash } from "node:crypto";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandResult, CommandSubstrate } from "../contracts/commandSubstrate.js";
import type {
  OpenWorkspaceInput,
  RebaseResult,
  RecordedConflict,
  ResolveConflictInput,
  RestackResult,
  WorkspaceHandle,
  WorkspaceVcsCore,
} from "../contracts/workspaceVcsCore.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";

/**
 * Resolves the contract's caller-facing identifiers onto the concrete clone source
 * + jj revisions this impl rebases onto. Production uses {@link identityJjRefResolver}
 * (real URL, real sha). The conformance harness injects a resolver mapping the
 * suite's synthetic tokens onto a local fixture repo.
 */
export interface JjRefResolver {
  /** The git URL/path `jj git clone` actually clones (identity in production). */
  cloneSource(repoUrl: string): string;
  /** The jj revision a `rebaseOnto baseSha` lands on (identity in production). */
  baseRevision(baseSha: string): string;
}

/** The production resolver: every caller identifier is already a real ref. */
export const identityJjRefResolver: JjRefResolver = {
  cloneSource: (repoUrl) => repoUrl,
  baseRevision: (baseSha) => baseSha,
};

/**
 * Materializes a `commit`'s working-tree change before it is described. Production
 * snapshots the runner's working copy (a no-op shell — jj auto-snapshots). The
 * conformance fixture writes a deterministic edit so a later rebase is a REAL
 * conflict — the engine never hard-codes the path/content.
 */
export type JjWorkingEdit = (message: string) => string[];

/**
 * Production edit: jj AUTO-snapshots the runner's working copy on every command, so a
 * `commit` injects no extra edit — it describes what the writer already wrote. This is
 * the live default, not a stand-in.
 */
export const autoSnapshotWorkingEdit: JjWorkingEdit = () => [];

/**
 * MERGE-SAFETY (self-identity, finding #7): the git author every commit this jj
 * workspace makes attributes to. A commit jj exports + pushes onto a PR (the
 * conflict-resolution commit) MUST carry the bot login the external-change gate
 * recognizes as Tanren's — `name` = the bot login, `email` = the canonical
 * `<bot-user-id>+<slug>[bot]@users.noreply.github.com` noreply. Absent ⇒ the
 * non-attributable conformance/public default (`Tanren` / `tanren@local`), which
 * never lands on a real PR.
 */
export interface JjCommitIdentity {
  name: string;
  email: string;
}

export interface JjWorkspaceVcsCoreDeps {
  /** The command substrate (SSH today) jj is shelled through, like git. */
  substrate: CommandSubstrate;
  /** The runner the jj commands execute on. */
  target: RunnerHandle;
  /** Per-command timeout (ms). */
  timeoutMs: number;
  /** Caller-id → concrete-ref resolution (default: identity / production). */
  refResolver?: JjRefResolver;
  /** Working-tree edit applied on each `commit` (default: auto-snapshot / production). */
  workingEdit?: JjWorkingEdit;
  /**
   * MERGE-SAFETY: the bot git author every commit carries (see {@link JjCommitIdentity}).
   * Absent ⇒ the non-attributable `Tanren` / `tanren@local` default (conformance +
   * the public/unauthenticated path, which never pushes a commit onto a real PR).
   */
  commitIdentity?: JjCommitIdentity;
}

/** The non-attributable jj author the conformance + public/unauthenticated paths use. */
const DEFAULT_JJ_COMMIT_IDENTITY: JjCommitIdentity = { name: "Tanren", email: "tanren@local" };

// Internal per-workspace state held by the impl (NOT exposed on the handle).
interface JjWorkspaceState {
  path: string;
  /** The bookmark currently checked out (jj's "current branch"). */
  currentBranch: string;
  /**
   * The undo stack for `opUndo`. Each mutating contract op pushes a {@link OpSnapshot}
   * BEFORE it runs, and `opUndo` pops + restores it. A stack (not a single `jj undo`)
   * is required because one contract op runs several jj sub-ops — restoring to the
   * pre-op snapshot reverts the whole op atomically.
   */
  opStack: OpSnapshot[];
}

/**
 * A point-in-time snapshot of EVERYTHING a contract op mutates, so `opUndo` restores
 * the workspace to the prior operation state in full: BOTH the jj operation log
 * (`opId`, restored via `jj op restore`) AND the impl's in-memory state (`currentBranch`).
 * Restoring only the jj op would leave a stale `currentBranch` pointing at a bookmark
 * the restore deleted — the next `commit`/op would then fail at `jj edit <branch>`.
 */
interface OpSnapshot {
  opId: string;
  currentBranch: string;
}

// jj template that prints a commit's STABLE change id + whether it carries a
// conflict, on one `--no-graph` line for machine reads. `change_id` survives commit
// rewrites (so it is the durable identity of a conflict for the life of that
// conflict); `conflict` is a boolean keyword in jj 0.42.
const REV_PROBE_TEMPLATE = 'change_id ++ "\\t" ++ if(conflict, "conflicted", "clean")';

/**
 * A STABLE id for a recorded conflict, derived deterministically from its identity:
 * the conflicted commit's durable jj change id + the sorted conflicted paths. PURE —
 * re-reading the same unresolved conflict yields the SAME id (the frozen contract
 * requires a stable `conflictId`), while two genuinely-different conflicts differ.
 */
function stableConflictId(changeId: string, paths: ReadonlyArray<string>): string {
  const digest = createHash("sha256")
    .update(`${changeId}\n${[...paths].sort().join("\n")}`)
    .digest("hex")
    .slice(0, 16);
  return `cfl_${digest}`;
}

export class JjWorkspaceVcsCore implements WorkspaceVcsCore {
  private readonly substrate: CommandSubstrate;
  private readonly target: RunnerHandle;
  private readonly timeoutMs: number;
  private readonly refResolver: JjRefResolver;
  private readonly workingEdit: JjWorkingEdit;
  private readonly commitIdentity: JjCommitIdentity;
  private readonly workspaces = new Map<string, JjWorkspaceState>();
  private seq = 0;

  constructor(deps: JjWorkspaceVcsCoreDeps) {
    this.substrate = deps.substrate;
    this.target = deps.target;
    this.timeoutMs = deps.timeoutMs;
    this.refResolver = deps.refResolver ?? identityJjRefResolver;
    this.workingEdit = deps.workingEdit ?? autoSnapshotWorkingEdit;
    this.commitIdentity = deps.commitIdentity ?? DEFAULT_JJ_COMMIT_IDENTITY;
  }

  async openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle> {
    const workspaceId = `jjws_${++this.seq}`;
    const source = this.refResolver.cloneSource(input.repoUrl);
    // openWorkspace OWNS the destination dir: create it first (the dir need not exist
    // — a fresh runner workspace won't), then `jj git clone --colocate` into it. The
    // clone runs WITHOUT cwd=dest (the dir is the clone's arg, and cwd=dest would fail
    // before the dir exists). `--colocate` keeps a real .git backend so the host stays
    // a plain git remote; the clone checks out the default branch.
    await this.runJjNoCwd([
      `mkdir -p ${quoteSshShellArg(input.path)}`,
      `jj git clone --colocate ${quoteSshShellArg(source)} ${quoteSshShellArg(input.path)}`,
    ]);
    // Configure the repo-local jj identity: jj 0.42 commits with the EMPTY identity
    // (and warns they can't be pushed) until user.name/email are set. Set them once
    // per workspace so every commit/export carries a real author.
    //
    // MERGE-SAFETY (self-identity, finding #7): when a bot `commitIdentity` is set
    // (the live conflict-resolve path), every commit jj exports + pushes onto a PR
    // attributes to the bot login the external-change gate recognizes as Tanren's.
    // Absent ⇒ the non-attributable `Tanren` / `tanren@local` default (conformance +
    // the public/unauthenticated path, which never lands a commit on a real PR).
    await this.runJj(input.path, [
      `jj config set --repo user.name ${quoteSshShellArg(this.commitIdentity.name)}`,
      `jj config set --repo user.email ${quoteSshShellArg(this.commitIdentity.email)}`,
      // Put the working copy onto the base branch (a working commit on top of it, so
      // edits never land directly on the immutable base bookmark).
      `jj new ${quoteSshShellArg(input.baseBranch)}`,
    ]);
    this.workspaces.set(workspaceId, { path: input.path, currentBranch: input.baseBranch, opStack: [] });
    return { workspaceId, path: input.path };
  }

  async branch(workspace: WorkspaceHandle, name: string, atBranch?: string): Promise<void> {
    const st = this.require(workspace);
    await this.pushOp(st);
    const parent = atBranch ?? st.currentBranch;
    // Start a NEW commit on the parent's tip and point the bookmark at THAT commit
    // (`-r @`, not `@-`). This makes the branch a DISTINCT commit even before any
    // `commit`, so a stack A→B→C is real commits and jj's `descendants()` walk (which
    // restack propagation rides) sees the ancestor→descendant edges.
    await this.runJj(st.path, [
      `jj new ${quoteSshShellArg(parent)}`,
      `jj bookmark create ${quoteSshShellArg(name)} -r @`,
    ]);
    st.currentBranch = name;
  }

  async checkout(workspace: WorkspaceHandle, branch: string): Promise<void> {
    const st = this.require(workspace);
    await this.pushOp(st);
    await this.runJj(st.path, [`jj edit ${quoteSshShellArg(branch)}`]);
    st.currentBranch = branch;
  }

  async commit(workspace: WorkspaceHandle, message: string): Promise<{ headSha: string }> {
    const st = this.require(workspace);
    await this.pushOp(st);
    // Apply the working-tree edit (jj auto-snapshots it), describe the working commit
    // `@`, then start a fresh `@` child and leave the bookmark on the just-described
    // CONTENT commit (`@-`). So the branch head IS the content commit and the next
    // `commit` edits a clean child — each commit advances the head to a new sha.
    await this.runJj(st.path, [
      `jj edit ${quoteSshShellArg(st.currentBranch)}`,
      ...this.workingEdit(message),
      `jj describe -m ${quoteSshShellArg(message)}`,
      `jj new`,
      `jj bookmark set ${quoteSshShellArg(st.currentBranch)} -r @- --allow-backwards`,
    ]);
    return { headSha: await this.branchHeadSha(st.path, st.currentBranch) };
  }

  async rebaseOnto(workspace: WorkspaceHandle, branch: string, baseSha: string): Promise<RebaseResult> {
    const st = this.require(workspace);
    await this.pushOp(st);
    const dest = this.refResolver.baseRevision(baseSha);
    // FIRST-CLASS conflicts (§2): `jj rebase` NEVER aborts — a conflicting rebase
    // SUCCEEDS and records the conflict IN the commit. We rebase the branch's whole
    // segment onto the shifted base, then probe whether the head carries a conflict.
    await this.runJj(st.path, [`jj rebase -b ${quoteSshShellArg(branch)} -d ${quoteSshShellArg(dest)}`]);
    const headSha = await this.branchHeadSha(st.path, branch);
    const conflict = await this.recordedConflict(st.path, branch);
    if (conflict !== undefined) {
      return { outcome: "conflicted", headSha, conflict };
    }
    return { outcome: "clean", headSha };
  }

  async resolveConflict(input: ResolveConflictInput): Promise<{ headSha: string }> {
    const st = this.require(input.workspace);
    await this.pushOp(st);
    // Write the intent-preserving resolution INTO the conflicted branch commit. jj
    // resolves a conflict the instant the conflicted paths no longer carry conflict
    // markers: edit the branch's commit, overwrite each path, and jj auto-snapshots
    // the resolution IN the commit (never recreated) — and AUTO-restacks descendants.
    const writes = input.resolutions.map(
      (r) => `printf %s ${quoteSshShellArg(r.content)} > ${quoteSshShellArg(r.path)}`,
    );
    await this.runJj(st.path, [`jj edit ${quoteSshShellArg(input.branch)}`, ...writes, `jj status`]);
    // Move `@` off the resolved commit so later reads/ops don't keep mutating it.
    await this.runJj(st.path, [`jj new ${quoteSshShellArg(input.branch)}`]);
    return { headSha: await this.branchHeadSha(st.path, input.branch) };
  }

  async restackDescendants(workspace: WorkspaceHandle, branch: string): Promise<RestackResult> {
    const st = this.require(workspace);
    await this.pushOp(st);
    // jj AUTO-restacks descendants whenever an ancestor is rewritten (the resolve
    // above already rewrote them and propagated the resolution down). This op is the
    // contract's reporting surface: enumerate the branch's descendant bookmarks and
    // report each one's restacked head + whether any still carries a conflict.
    const descendants = await this.descendantBranches(st.path, branch);
    const restacked: Array<{ branch: string; headSha: string }> = [];
    const stillConflicted: RecordedConflict[] = [];
    for (const name of descendants) {
      const headSha = await this.branchHeadSha(st.path, name);
      restacked.push({ branch: name, headSha });
      const conflict = await this.recordedConflict(st.path, name);
      if (conflict !== undefined) {
        stillConflicted.push(conflict);
      }
    }
    return { restacked, stillConflicted };
  }

  async exportCleanGitRef(workspace: WorkspaceHandle, branch: string): Promise<{ ref: string; headSha: string }> {
    const st = this.require(workspace);
    // The §2 boundary (fail-closed): NEVER export a conflicted ref to the host. jj
    // KNOWS — we refuse if the branch (or any commit reachable from it that jj would
    // export) still carries a recorded conflict.
    const conflict = await this.recordedConflict(st.path, branch);
    if (conflict !== undefined) {
      throw new Error(
        `refusing to export ${branch}: unresolved conflict ${conflict.conflictId} on ${conflict.paths.join(", ")}`,
      );
    }
    // `jj git export` writes the bookmark out as a git ref the host can fetch/land.
    await this.runJj(st.path, [`jj git export`]);
    return { ref: `refs/heads/${branch}`, headSha: await this.branchHeadSha(st.path, branch) };
  }

  async opUndo(workspace: WorkspaceHandle): Promise<void> {
    const st = this.require(workspace);
    // Revert the LAST contract op to the prior operation state IN FULL: restore both
    // the jj op log and the in-memory state. jj 0.42 renamed away `jj op undo` (it is
    // `jj undo` now); `jj op restore <id>` restores to a precise prior state, which we
    // need since one contract op spans several jj sub-ops.
    const prior = st.opStack.pop();
    if (prior === undefined) {
      return;
    }
    await this.runJj(st.path, [`jj op restore ${quoteSshShellArg(prior.opId)}`]);
    // Restore the in-memory state too — the restored jj op may have removed the
    // bookmark `currentBranch` pointed at, so a stale value would brick the next op.
    st.currentBranch = prior.currentBranch;
  }

  // The git sha the bookmark points at. Read via jj's commit_id template so it is
  // the same value `jj git export` writes for the host.
  private async branchHeadSha(path: string, branch: string): Promise<string> {
    const out = await this.runJjCapture(path, [`jj log -r ${quoteSshShellArg(branch)} --no-graph -T 'commit_id'`]);
    return out.trim();
  }

  // The recorded conflict on `branch`, or undefined when clean. Reads jj's own
  // `conflict` boolean + the commit's STABLE change id, and the conflicted paths via
  // `jj resolve --list` (machine-stable: one `path` per line).
  private async recordedConflict(path: string, branch: string): Promise<RecordedConflict | undefined> {
    const probe = await this.runJjCapture(path, [
      `jj log -r ${quoteSshShellArg(branch)} --no-graph -T ${quoteSshShellArg(REV_PROBE_TEMPLATE)}`,
    ]);
    const [changeId, state] = probe.trim().split("\t");
    if (state !== "conflicted") {
      return undefined;
    }
    const paths = await this.conflictedPaths(path, branch);
    return {
      // STABLE id: derived from the conflict's identity (the commit's durable change
      // id + the sorted conflicted paths), NOT a per-read counter. Re-reading the same
      // unresolved conflict yields the SAME conflictId, as the frozen contract requires.
      conflictId: stableConflictId(changeId ?? "", paths),
      between: { specId: branch, otherSpecId: "base" },
      paths,
    };
  }

  // The conflicted paths on `branch`, read from `jj resolve --list -r <branch>` (jj
  // 0.42 accepts the revset directly — no `jj edit` side-effect). Each line is
  // `<path>    <kind>`; we take the leading path token.
  //
  // FAIL-CLOSED (§5-P1): NO blanket `|| true`. `conflictedPaths` is only reached when the
  // rev IS conflicted (recordedConflict gated on the `conflict` template), so an empty
  // path enumeration must NEVER silently degrade `gather()` to `files: []` (a false-clean
  // merge). We distinguish jj's BENIGN no-conflict signal — exit 2 with the exact
  // "No conflicts found at this revision" on stderr — from an INFRA/runner failure:
  //   - a substrate-level `failure` (ssh/exec died) ⇒ LOUD THROW;
  //   - the benign no-conflict signal here is a CONTRADICTION (the conflict template said
  //     conflicted, resolve --list says none) ⇒ LOUD THROW (never empty paths);
  //   - any other nonzero exit ⇒ LOUD THROW (a real enumeration failure);
  //   - exit 0 ⇒ parse the path lines.
  private async conflictedPaths(path: string, branch: string): Promise<string[]> {
    const result = await this.runJjRaw(path, [`jj resolve --list -r ${quoteSshShellArg(branch)}`]);
    if (result.failure !== undefined || result.timedOut) {
      const detail =
        result.failure === undefined
          ? "timed out"
          : "message" in result.failure
            ? result.failure.message
            : result.failure.reason;
      throw new Error(
        `jj resolve --list -r ${branch} failed to enumerate conflicted paths on a conflicted rev (infra/runner failure): ${detail}`,
      );
    }
    if (result.exitCode !== 0) {
      // A conflicted rev whose path enumeration reports "no conflicts" is a CONTRADICTION
      // (we only got here because the conflict template said conflicted) — never degrade
      // to empty paths; surface it loudly. Any other nonzero exit is a real failure.
      const benignNoConflicts = /No conflicts found at this revision/u.test(result.stderr);
      throw new Error(
        benignNoConflicts
          ? `jj reported ${branch} as conflicted but resolve --list found NO conflicts — refusing to degrade to empty conflicted paths (a false-clean would merge)`
          : `jj resolve --list -r ${branch} exited ${result.exitCode ?? "null"} enumerating conflicted paths: ${result.stderr.trim()}`,
      );
    }
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => line.split(/\s+/u)[0] ?? "")
      .filter((p) => p !== "");
  }

  // The bookmarks that are STRICT descendants of `branch` (jj revset
  // `descendants(branch) ~ branch`), each line one bookmark name.
  private async descendantBranches(path: string, branch: string): Promise<string[]> {
    const revset = `bookmarks() & (descendants(${branch}) ~ ${branch})`;
    const out = await this.runJjCapture(path, [
      `jj log -r ${quoteSshShellArg(revset)} --no-graph -T 'bookmarks ++ "\\n"'`,
    ]);
    const names = new Set<string>();
    for (const raw of out.split(/\s+/u)) {
      const name = raw.replace(/\*$/u, "").trim();
      if (name !== "" && name !== branch) {
        names.add(name);
      }
    }
    return [...names].sort();
  }

  // Snapshot the FULL workspace state (jj op id + in-memory currentBranch) BEFORE a
  // mutating contract op, so `opUndo` can restore both precisely (one contract op =
  // several jj sub-ops).
  private async pushOp(st: JjWorkspaceState): Promise<void> {
    st.opStack.push({ opId: await this.currentOpId(st.path), currentBranch: st.currentBranch });
  }

  // The id of the latest jj operation (the head of `jj op log`).
  private async currentOpId(path: string): Promise<string> {
    const out = await this.runJjCapture(path, [`jj op log --no-graph --limit 1 -T 'id'`]);
    return out.trim();
  }

  // Run a jj command sequence, throwing on a nonzero exit (a loud failure, never a
  // silent degrade). `set -eu` so any step failing fails the whole invocation.
  private async runJj(path: string, jjCommands: string[]): Promise<void> {
    await runWorkspaceSshCommand(this.substrate, this.target, {
      label: `jj ${jjCommands[0] ?? ""}`,
      cwd: path,
      timeoutMs: this.timeoutMs,
      command: ["set -eu", ...jjCommands].join(" && "),
    });
  }

  // Like {@link runJj} but with NO cwd — for the clone bootstrap, where the workspace
  // dir does not exist yet (so cwd=dest would fail before the dir is created).
  private async runJjNoCwd(jjCommands: string[]): Promise<void> {
    await runWorkspaceSshCommand(this.substrate, this.target, {
      label: `jj ${jjCommands[0] ?? ""}`,
      timeoutMs: this.timeoutMs,
      command: ["set -eu", ...jjCommands].join(" && "),
    });
  }

  // Run a jj command sequence and return its trimmed stdout (throws on failure).
  private async runJjCapture(path: string, jjCommands: string[]): Promise<string> {
    const result = await runWorkspaceSshCommand(this.substrate, this.target, {
      label: `jj ${jjCommands[0] ?? ""}`,
      cwd: path,
      timeoutMs: this.timeoutMs,
      command: ["set -eu", ...jjCommands].join(" && "),
    });
    return result.stdout;
  }

  // Run a command sequence that tolerates per-step failure (uses `|| true` inline)
  // and returns the raw result without throwing on a nonzero exit.
  private async runJjRaw(path: string, commands: string[]): Promise<CommandResult> {
    return this.substrate.run(this.target, {
      command: commands.join("\n"),
      cwd: path,
      timeoutMs: this.timeoutMs,
    });
  }

  private require(workspace: WorkspaceHandle): JjWorkspaceState {
    const st = this.workspaces.get(workspace.workspaceId);
    if (st === undefined) {
      throw new Error(`unknown jj workspace ${workspace.workspaceId}`);
    }
    return st;
  }
}
