// The PRODUCTION runner-backed seams for the deterministic entity-merge first-pass
// (docs/roadmap/entity-analysis-layer.md §3.2): the `sem`-backed `EntityDiffer` and the
// jj `ConflictSides` reader. Both run over the SAME live jj workspace the conflict applier
// holds — `sem diff --stdin --json` for the entity-level diff (§3.1's entity tool), and
// marker-free `jj file show -r <rev>` reads for the three conflict terms.
//
// GRACEFUL (non-negotiable, §1 + the binding conflict-handling principle): `sem` is an
// OPTIONAL accelerator the runner may not have (it covers many languages, not every stack —
// Tanren bakes in NO language assumption). A missing / erroring / can't-parse `sem`, or a
// conflict side that cannot be read, returns the "unavailable" / omitted shape so the
// first-pass DEFERS to the agent resolver — it NEVER throws, NEVER bricks, NEVER silently
// mis-resolves. The DISTINCTION the no-silent-fallback doctrine demands (sem-absent =
// legitimate vs sem-errored = unexpected) is carried in the `EntityDifferUnavailable` reason.

import type { RunnerHandle } from "../../../contracts/allocator.js";
import type { CommandSubstrate } from "../../../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../../../ssh/command.js";
import { buildActivityWatchdog } from "../../../ssh/activityWatchdog.js";
import { entityMergeFirstPass } from "./entityMergeFirstPass.js";
import type {
  ConflictFileSides,
  ConflictSides,
  EntityDiff,
  EntityDiffChange,
  EntityDiffResult,
  EntityDiffer,
} from "./entityMergeFirstPass.js";
import type { EntityMergeFirstPassHook } from "./resolver.js";

/** What the runner-backed seams need: the live SSH substrate + the runner + the workspace path. */
export interface RunnerEntityMergeContext {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
}

// ── The `sem`-backed entity differ ───────────────────────────────────────────

/** The `sem diff --stdin --json` FileChange the differ feeds (before/after content). */
interface SemFileChange {
  filePath: string;
  status: "modified";
  beforeContent: string;
  afterContent: string;
}

/** One change row from `sem diff --json` (the subset the first-pass keys on). */
interface SemDiffChangeRow {
  entityId: string;
  changeType: string;
  oldStartLine: number;
  oldEndLine: number;
  afterContent: string;
}

/** The `sem diff --json` envelope (we read `changes`; the summary is ignored here). */
interface SemDiffEnvelope {
  changes: ReadonlyArray<SemDiffChangeRow>;
}

/** The entity change-types `sem` emits that the first-pass understands (others ⇒ defer). */
const KNOWN_CHANGE_TYPES = new Set<EntityDiffChange["changeType"]>([
  "added",
  "modified",
  "deleted",
  "renamed",
  "moved",
  "reordered",
]);

/**
 * Build the production `sem`-backed entity differ over a live runner workspace. It pipes a
 * one-file `FileChange[]` (base→side) to `sem diff --stdin --json` and parses the entity
 * change rows. GRACEFUL: a non-zero exit / substrate failure / unparseable output maps to
 * `{ ok: false }` (the first-pass defers) — `sem` absent on PATH is `producer-unsupported`
 * (legitimate, quiet), an erroring `sem` is `producer-errored` (unexpected). Never throws.
 */
export function buildSemEntityDiffer(ctx: RunnerEntityMergeContext): EntityDiffer {
  return {
    async diff(input): Promise<EntityDiffResult> {
      const payload: SemFileChange[] = [
        { filePath: input.path, status: "modified", beforeContent: input.before, afterContent: input.after },
      ];
      let result;
      try {
        // `command -v sem` first so a runner without `sem` is the QUIET legitimate-absent
        // case (`producer-unsupported`), distinct from a present-but-erroring `sem`.
        result = await ctx.ssh.run(ctx.target, {
          cwd: ctx.workspacePath,
          watchdog: buildActivityWatchdog({
            substrate: ctx.ssh,
            target: ctx.target,
            cls: "vcs",
            workspace: ctx.workspacePath,
          }),
          stdin: JSON.stringify(payload),
          command: "command -v sem >/dev/null 2>&1 || { echo __SEM_ABSENT__ >&2; exit 127; }; sem diff --stdin --json",
        });
      } catch {
        // A thrown substrate error (rare — the substrate reports in-band) is an unexpected
        // producer failure; defer loudly via the reason, never brick.
        return { ok: false, reason: "producer-errored" };
      }
      if (result.failure !== undefined || result.stalled === true) {
        return { ok: false, reason: "producer-errored" };
      }
      if (result.exitCode === 127 || result.stderr.includes("__SEM_ABSENT__")) {
        // `sem` not on PATH — the legitimate, quiet absence (an unsupported runner image).
        return { ok: false, reason: "producer-unsupported" };
      }
      if (result.exitCode !== 0) {
        return { ok: false, reason: "producer-errored" };
      }
      const diff = parseSemDiff(result.stdout);
      if (diff === undefined) {
        return { ok: false, reason: "producer-errored" };
      }
      return { ok: true, diff };
    },
  };
}

/** Parse `sem diff --json` stdout into the neutral `EntityDiff`, or `undefined` if unparseable. */
function parseSemDiff(stdout: string): EntityDiff | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as SemDiffEnvelope).changes)) {
    return undefined;
  }
  const rows = (parsed as SemDiffEnvelope).changes;
  const changes: EntityDiffChange[] = [];
  for (const row of rows) {
    if (
      typeof row.entityId !== "string" ||
      typeof row.changeType !== "string" ||
      typeof row.oldStartLine !== "number" ||
      typeof row.oldEndLine !== "number" ||
      typeof row.afterContent !== "string"
    ) {
      // A malformed row makes the entity map untrustworthy — defer the whole file.
      return undefined;
    }
    if (!KNOWN_CHANGE_TYPES.has(row.changeType as EntityDiffChange["changeType"])) {
      // An unrecognized change-type is not a safe splice signal — treat as a non-modified
      // change so the pure decision defers (it only splices `modified`).
      changes.push({
        entityId: row.entityId,
        changeType: "moved",
        oldStartLine: row.oldStartLine,
        oldEndLine: row.oldEndLine,
        afterContent: row.afterContent,
      });
      continue;
    }
    changes.push({
      entityId: row.entityId,
      changeType: row.changeType as EntityDiffChange["changeType"],
      oldStartLine: row.oldStartLine,
      oldEndLine: row.oldEndLine,
      afterContent: row.afterContent,
    });
  }
  return { changes };
}

// ── The jj conflict-sides reader (marker-free) ───────────────────────────────

/** The jj revisions the three conflict terms are read from (base / ours / theirs). */
export interface JjConflictSideRevs {
  /** The dependent's PRE-rebase head — `<headBranch>@origin` (untouched by the local rebase). */
  oursRev: string;
  /** The shifted base the rebase landed on (the applier's `facts.baseRevision`). */
  theirsRev: string;
}

/**
 * Build the production jj `ConflictSides` reader. For each conflicted path it reads three
 * marker-free terms via `jj file show -r <rev>`:
 *   • theirs = the shifted base (`theirsRev`, the rebase destination);
 *   • ours   = the dependent's pre-rebase head (`oursRev` = `<headBranch>@origin`);
 *   • base   = the merge base of the two (`heads(::ours & ::theirs)`).
 * A path whose three reads do not ALL succeed is OMITTED (the first-pass then defers the
 * whole conflict — never a partial entity-merge). Never throws.
 */
export function buildJjConflictSides(ctx: RunnerEntityMergeContext, revs: JjConflictSideRevs): ConflictSides {
  const baseRevset = `heads(::${revs.oursRev} & ::${revs.theirsRev})`;
  return {
    async read(paths): Promise<ReadonlyArray<ConflictFileSides>> {
      const out: ConflictFileSides[] = [];
      for (const path of paths) {
        const base = await fileShow(ctx, baseRevset, path);
        const ours = await fileShow(ctx, revs.oursRev, path);
        const theirs = await fileShow(ctx, revs.theirsRev, path);
        if (base === undefined || ours === undefined || theirs === undefined) {
          // A side we cannot read ⇒ omit the path; the first-pass defers the whole conflict.
          continue;
        }
        out.push({ path, base, ours, theirs });
      }
      return out;
    },
  };
}

// ── The runner-backed first-pass hook (the §3.2 wiring site builds this) ──────

/**
 * Build the production §3.2 entity-merge first-pass hook over a live jj workspace: the
 * `sem`-backed differ + the marker-free jj conflict-sides reader, composed into the pure
 * `entityMergeFirstPass` decision. The base-shift conflict resolver (`baseShiftLiveResolve.ts`)
 * passes this to `buildDefaultConflictResolver`; `oursRev` is the dependent's pre-rebase head
 * (`<headBranch>@origin`) and `theirsRev` is the shifted base the rebase landed on.
 */
export function buildSemEntityMergeFirstPass(
  ctx: RunnerEntityMergeContext,
  revs: JjConflictSideRevs,
): EntityMergeFirstPassHook {
  const differ = buildSemEntityDiffer(ctx);
  const sides = buildJjConflictSides(ctx, revs);
  return {
    attempt: ({ conflictedPaths }) => entityMergeFirstPass({ conflictedPaths, sides, differ }),
  };
}

/** `jj file show -r <rev> <path>` content, or `undefined` on any failure (defer, never throw). */
async function fileShow(ctx: RunnerEntityMergeContext, rev: string, path: string): Promise<string | undefined> {
  let result;
  try {
    result = await ctx.ssh.run(ctx.target, {
      cwd: ctx.workspacePath,
      watchdog: buildActivityWatchdog({
        substrate: ctx.ssh,
        target: ctx.target,
        cls: "vcs",
        workspace: ctx.workspacePath,
      }),
      command: `jj file show -r ${quoteSshShellArg(rev)} -- ${quoteSshShellArg(path)}`,
    });
  } catch {
    return undefined;
  }
  if (result.failure !== undefined || result.stalled === true || result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout;
}
