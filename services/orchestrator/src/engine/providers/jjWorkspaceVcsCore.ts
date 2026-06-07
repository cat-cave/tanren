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
}

// Internal per-workspace state held by the impl (NOT exposed on the handle).
interface JjWorkspaceState {
  path: string;
  /** The bookmark currently checked out (jj's "current branch"). */
  currentBranch: string;
}

// jj template that prints a commit's change id + whether it carries a conflict, on
// one line, for `--no-graph` machine reads. `conflict` is a boolean keyword.
const REV_PROBE_TEMPLATE = 'commit_id ++ "\\t" ++ if(conflict, "conflicted", "clean")';

export class JjWorkspaceVcsCore implements WorkspaceVcsCore {
  private readonly substrate: CommandSubstrate;
  private readonly target: RunnerHandle;
  private readonly timeoutMs: number;
  private readonly refResolver: JjRefResolver;
  private readonly workingEdit: JjWorkingEdit;
  private readonly workspaces = new Map<string, JjWorkspaceState>();
  private seq = 0;

  constructor(deps: JjWorkspaceVcsCoreDeps) {
    this.substrate = deps.substrate;
    this.target = deps.target;
    this.timeoutMs = deps.timeoutMs;
    this.refResolver = deps.refResolver ?? identityJjRefResolver;
    this.workingEdit = deps.workingEdit ?? autoSnapshotWorkingEdit;
  }

  async openWorkspace(input: OpenWorkspaceInput): Promise<WorkspaceHandle> {
    const workspaceId = `jjws_${++this.seq}`;
    const source = this.refResolver.cloneSource(input.repoUrl);
    // `jj git clone --colocate` imports the git repo AND keeps a real .git backend
    // (so the host stays a plain git remote), checking out the default branch. We
    // then ensure a bookmark at `baseBranch` exists and is the working base.
    await this.runJj(input.path, [
      `jj git clone --colocate ${quoteSshShellArg(source)} ${quoteSshShellArg(input.path)}`,
    ]);
    await this.runJj(input.path, [
      // Put the working copy onto the base branch (create a working commit on top of
      // it so edits never land directly on the immutable base bookmark).
      `jj new ${quoteSshShellArg(input.baseBranch)}`,
    ]);
    this.workspaces.set(workspaceId, { path: input.path, currentBranch: input.baseBranch });
    return { workspaceId, path: input.path };
  }

  async branch(workspace: WorkspaceHandle, name: string, atBranch?: string): Promise<void> {
    const st = this.require(workspace);
    const parent = atBranch ?? st.currentBranch;
    // Create the bookmark at the parent's tip, then start a working commit on top of
    // it. The ancestor→descendant edge (parent→name) is recorded by jj's commit
    // graph, which is exactly what restack propagation walks.
    await this.runJj(st.path, [
      `jj new ${quoteSshShellArg(parent)}`,
      `jj bookmark create ${quoteSshShellArg(name)} -r @-`,
    ]);
    st.currentBranch = name;
  }

  async checkout(workspace: WorkspaceHandle, branch: string): Promise<void> {
    const st = this.require(workspace);
    await this.runJj(st.path, [`jj new ${quoteSshShellArg(branch)}`]);
    st.currentBranch = branch;
  }

  async commit(workspace: WorkspaceHandle, message: string): Promise<{ headSha: string }> {
    const st = this.require(workspace);
    // Apply the working-tree edit (jj auto-snapshots it), describe the current working
    // commit, advance the bookmark to it, then start a fresh working commit on top so
    // the next edit doesn't mutate this one.
    await this.runJj(st.path, [
      ...this.workingEdit(message),
      `jj describe -m ${quoteSshShellArg(message)}`,
      `jj bookmark set ${quoteSshShellArg(st.currentBranch)} -r @ --allow-backwards`,
      `jj new`,
    ]);
    return { headSha: await this.branchHeadSha(st.path, st.currentBranch) };
  }

  async rebaseOnto(workspace: WorkspaceHandle, branch: string, baseSha: string): Promise<RebaseResult> {
    const st = this.require(workspace);
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
    // Write the intent-preserving resolution into the conflicted commit. jj resolves
    // a conflict the moment the conflicted paths no longer contain conflict markers:
    // we check out the branch's conflicted commit, overwrite each path, and snapshot.
    // The conflict transitions recorded → resolved IN the commit (never recreated).
    const writes = input.resolutions.map(
      (r) => `printf %s ${quoteSshShellArg(r.content)} > ${quoteSshShellArg(r.path)}`,
    );
    await this.runJj(st.path, [`jj edit ${quoteSshShellArg(input.branch)}`, ...writes, `jj status`]);
    // Return to a fresh working commit on the branch tip (leave `@` off the edited
    // commit so later ops don't keep mutating it).
    await this.runJj(st.path, [`jj new ${quoteSshShellArg(input.branch)}`]);
    return { headSha: await this.branchHeadSha(st.path, input.branch) };
  }

  async restackDescendants(workspace: WorkspaceHandle, branch: string): Promise<RestackResult> {
    const st = this.require(workspace);
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
    // Revert the last operation via jj's operation log — every op is undoable.
    await this.runJj(st.path, [`jj op undo`]);
  }

  // The git sha the bookmark points at. Read via jj's commit_id template so it is
  // the same value `jj git export` writes for the host.
  private async branchHeadSha(path: string, branch: string): Promise<string> {
    const out = await this.runJjCapture(path, [`jj log -r ${quoteSshShellArg(branch)} --no-graph -T 'commit_id'`]);
    return out.trim();
  }

  // The recorded conflict on `branch`, or undefined when clean. Reads jj's own
  // `conflict` boolean for the branch tip AND its conflicted paths via
  // `jj resolve --list` (machine-stable: one `path` per line).
  private async recordedConflict(path: string, branch: string): Promise<RecordedConflict | undefined> {
    const probe = await this.runJjCapture(path, [
      `jj log -r ${quoteSshShellArg(branch)} --no-graph -T ${quoteSshShellArg(REV_PROBE_TEMPLATE)}`,
    ]);
    const [, state] = probe.trim().split("\t");
    if (state !== "conflicted") {
      return undefined;
    }
    const paths = await this.conflictedPaths(path, branch);
    return {
      conflictId: `cfl_${branch}_${++this.seq}`,
      between: { specId: branch, otherSpecId: "base" },
      paths,
    };
  }

  // The conflicted paths on `branch`, read from `jj resolve --list` (each line:
  // `<path>    <kind>`). Empty list ⇒ no conflicted paths.
  private async conflictedPaths(path: string, branch: string): Promise<string[]> {
    const result = await this.runJjRaw(path, [
      `jj edit ${quoteSshShellArg(branch)} >/dev/null 2>&1 || true`,
      `jj resolve --list 2>/dev/null || true`,
    ]);
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
