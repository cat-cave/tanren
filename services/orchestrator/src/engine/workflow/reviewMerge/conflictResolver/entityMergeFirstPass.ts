// The deterministic ENTITY-MERGE FIRST-PASS in the never-discard base-shift conflict
// path (docs/roadmap/entity-analysis-layer.md §3.2). `weave`'s entity-level merge resolves
// a class of conflicts DETERMINISTICALLY: two edits to DIFFERENT entities (functions /
// classes / methods / types) in the SAME file are not a real conflict — git's line-based
// merge just couldn't separate two textually-adjacent edits. We take that VALUE as a
// LIBRARY in-coordinator first-pass (EXPLICITLY NOT weave-as-a-git-merge-driver — Tanren
// runs on jj; a git merge driver clashes; §3.2). When the base-shift rebase surfaces a
// conflict, this first-pass runs BEFORE the agent resolver: if the conflicting hunks land
// in DIFFERENT entities of the same file, splice both edits onto the base deterministically;
// only a genuine SAME-entity conflict (or anything we cannot prove disjoint) falls through
// to the agent resolver exactly as today.
//
// SAFETY (non-negotiable, the binding conflict-handling principle — a conflict must NEVER
// brick + NEVER silently mis-resolve a real same-entity conflict; when in doubt DEFER):
//   • The decision is DRIVEN by `sem`'s entity-diff (the SAME entity tool §3.1's oracle
//     uses). For each conflicted file we entity-diff base→ours and base→theirs; the edits
//     are disjoint ONLY when the two sides' changed-entity-id sets share NO member AND
//     their base line spans do not overlap.
//   • Anything that makes the disjointness UNPROVABLE defers (returns to the agent): `sem`
//     absent / errored / cannot parse the stack; a side change not attributed to an entity;
//     a non-`modified` change (add / delete / rename / move at the file level); overlapping
//     base spans; or ANY conflicted file we cannot fully analyze (NEVER a partial splice).
//   • Even on a deterministic splice the resolver still RE-GATES the spliced tree before it
//     publishes (the first-pass is an OPTIMIZATION before the agent, not a replacement for
//     the re-gate) — so a wrong splice cannot merge.
//
// PURE + DETERMINISTIC: this module holds the splice + disjointness DECISION (no IO, no
// clock). The `sem` invocation + the jj conflict-side reads are the injected
// `EntityDiffer` / `ConflictSides` seams (production over the runner; fakes in tests).

// ── The neutral entity-diff the decision reasons over ────────────────────────

/**
 * One entity changed between two contents, as reported by an entity differ (`sem diff`).
 * Stack-agnostic: an entity is any first-class unit the differ extracts (a
 * function/class/method/type for code; a stanza/chapter for a non-code project). The
 * decision keys on `entityId` (the stable structural identity) for disjointness and on the
 * base line span (`oldStartLine`/`oldEndLine`) + `afterContent` for the splice.
 */
export interface EntityDiffChange {
  /** The differ's stable entity identity (e.g. `f.ts::function::alpha`). */
  entityId: string;
  /** How the entity changed. Only `modified` is safely spliceable; the rest defer. */
  changeType: "added" | "modified" | "deleted" | "renamed" | "moved" | "reordered";
  /** The entity's 1-indexed inclusive line span IN THE BASE content (the splice target). */
  oldStartLine: number;
  oldEndLine: number;
  /** The entity's new body (the content the splice writes over its base span). */
  afterContent: string;
}

/** The full entity-diff between two file contents (the `changes` array of `sem diff`). */
export interface EntityDiff {
  changes: ReadonlyArray<EntityDiffChange>;
}

/**
 * The three sides of ONE recorded conflict file (jj's first-class conflict terms). `base`
 * is the merge base; `ours` is the dependent's pre-rebase head; `theirs` is the shifted
 * base the rebase landed on. The first-pass entity-diffs base→ours and base→theirs.
 */
export interface ConflictFileSides {
  path: string;
  base: string;
  ours: string;
  theirs: string;
}

// ── The differ + sides seams (injected; production over the runner) ──────────

/** Why the entity differ produced no diff — distinguishes legitimate-absent from errored. */
export type EntityDifferUnavailable = "no-producer" | "producer-unsupported" | "producer-errored";

/** A diff between two file contents, or the reason it is unavailable (defer, never throw). */
export type EntityDiffResult = { ok: true; diff: EntityDiff } | { ok: false; reason: EntityDifferUnavailable };

/**
 * Entity-diffs two versions of a file (production: `sem diff --stdin --json` over the
 * runner). MUST be graceful: a missing/erroring/unsupported producer returns
 * `{ ok: false }` so the first-pass DEFERS to the agent — it NEVER throws.
 */
export interface EntityDiffer {
  diff(input: { path: string; before: string; after: string }): Promise<EntityDiffResult>;
}

/**
 * Reads the three conflict terms (base / ours / theirs) for each recorded-conflict path
 * (production: `jj file show -r <rev>` over the live workspace — marker-free). A path whose
 * sides cannot be read is omitted, which the first-pass treats as un-analyzable ⇒ DEFER.
 */
export interface ConflictSides {
  read(paths: ReadonlyArray<string>): Promise<ReadonlyArray<ConflictFileSides>>;
}

// ── The outcome ──────────────────────────────────────────────────────────────

/**
 * The first-pass either deterministically RESOLVED every conflicted file at the entity
 * level (the agent is skipped — but the resolver still re-gates the spliced tree) or
 * DEFERRED (the agent resolver runs exactly as today). `reason` on a defer is observable.
 */
export type EntityMergeOutcome =
  | { resolved: true; files: ReadonlyArray<{ path: string; content: string }>; entityIds: ReadonlyArray<string> }
  | { resolved: false; reason: string };

// ── The pure splice + disjointness decision ──────────────────────────────────

/**
 * Splice one side's entity-modifications onto the base content. Each change replaces its
 * 1-indexed inclusive base span with its new body; applied bottom-up so earlier splices do
 * not shift later spans. Returns `undefined` if a span is out of range (a defensive guard —
 * the caller already proved every change is `modified` with an in-range span).
 */
function applyEntitySplices(
  baseLines: ReadonlyArray<string>,
  changes: ReadonlyArray<EntityDiffChange>,
): string[] | undefined {
  const lines = [...baseLines];
  // Bottom-up: a later (higher-line) splice must not shift the indices of an earlier one.
  const ordered = [...changes].sort((a, b) => b.oldStartLine - a.oldStartLine);
  for (const change of ordered) {
    const start = change.oldStartLine - 1;
    // `end` is exclusive for splice (the base span is 1-indexed inclusive).
    const end = change.oldEndLine;
    if (start < 0 || end > lines.length || start >= end) {
      return undefined;
    }
    lines.splice(start, end - start, ...splitBody(change.afterContent));
  }
  return lines;
}

/** Split an entity body into lines WITHOUT inventing a trailing blank for a non-empty body. */
function splitBody(body: string): string[] {
  return body.split("\n");
}

/** Split a file into lines, dropping the single trailing empty a final newline produces. */
function splitFile(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** Re-join spliced lines, preserving a trailing newline iff the base had one. */
function joinFile(lines: ReadonlyArray<string>, baseHadTrailingNewline: boolean): string {
  const joined = lines.join("\n");
  return baseHadTrailingNewline ? `${joined}\n` : joined;
}

/** True iff two 1-indexed inclusive base spans overlap (so the splices are NOT independent). */
function spansOverlap(a: EntityDiffChange, b: EntityDiffChange): boolean {
  return a.oldStartLine <= b.oldEndLine && b.oldStartLine <= a.oldEndLine;
}

/**
 * Decide whether ONE conflicted file's two sides are entity-disjoint and, if so, produce
 * the spliced merge. Returns the merged content + the changed entity ids, or a defer reason.
 * SAFE: every change must be `modified` (a non-`modified` entity change is not a safe splice);
 * the two sides' entity-id sets must be disjoint; and no ours-span may overlap a theirs-span.
 */
function mergeOneFile(
  sides: ConflictFileSides,
  oursDiff: EntityDiff,
  theirsDiff: EntityDiff,
): { content: string; entityIds: ReadonlyArray<string> } | { defer: string } {
  // A side with NO entity changes means the differ saw no structural change on that side —
  // but the file genuinely conflicted, so the difference is non-structural (whitespace /
  // a change the differ couldn't attribute to an entity). That is NOT provably disjoint.
  if (oursDiff.changes.length === 0 || theirsDiff.changes.length === 0) {
    return { defer: `${sides.path}: a conflicting side has no entity-attributed change (not provably disjoint)` };
  }
  // Only `modified` entity changes are a safe splice. An add/delete/rename/move/reorder is
  // a file-level or identity change the deterministic splice must not attempt.
  for (const change of [...oursDiff.changes, ...theirsDiff.changes]) {
    if (change.changeType !== "modified") {
      return {
        defer: `${sides.path}: a side has a non-modified entity change (${change.changeType}); defer to the agent`,
      };
    }
  }
  // DISJOINTNESS by stable entity identity: the two sides must not both touch one entity.
  const oursIds = new Set(oursDiff.changes.map((c) => c.entityId));
  const sharedId = theirsDiff.changes.find((c) => oursIds.has(c.entityId));
  if (sharedId !== undefined) {
    return { defer: `${sides.path}: both sides edit the same entity (${sharedId.entityId}); defer to the agent` };
  }
  // DISJOINTNESS by base line span: even with distinct ids, overlapping base spans would
  // make the splices interfere — defer (this also guards a differ that mis-attributes spans).
  for (const ours of oursDiff.changes) {
    for (const theirs of theirsDiff.changes) {
      if (spansOverlap(ours, theirs)) {
        return {
          defer: `${sides.path}: the sides' entity edits overlap in the base (${ours.entityId} / ${theirs.entityId}); defer`,
        };
      }
    }
  }
  // Disjoint: splice BOTH sides' entity edits onto the base. The merged tree carries each
  // side's edit at its own entity — both edits land, no marker survives.
  const baseLines = splitFile(sides.base);
  const baseHadTrailingNewline = sides.base.endsWith("\n");
  const all = [...oursDiff.changes, ...theirsDiff.changes];
  const merged = applyEntitySplices(baseLines, all);
  if (merged === undefined) {
    return { defer: `${sides.path}: an entity span was out of range against the base; defer` };
  }
  return {
    content: joinFile(merged, baseHadTrailingNewline),
    entityIds: all.map((c) => c.entityId),
  };
}

/**
 * The deterministic entity-merge first-pass. For EVERY conflicted file, read its three jj
 * conflict terms, entity-diff base→ours and base→theirs, and (if every file is provably
 * entity-disjoint) splice both edits onto the base — skipping the agent. ANY file that
 * cannot be proven disjoint (sem absent/errored, an unattributed/non-modified change, a
 * same-entity edit, an overlap, or unreadable sides) DEFERS the WHOLE conflict to the agent
 * (never a partial splice). NEVER throws: a differ/sides failure is caught and deferred.
 */
export async function entityMergeFirstPass(input: {
  conflictedPaths: ReadonlyArray<string>;
  sides: ConflictSides;
  differ: EntityDiffer;
}): Promise<EntityMergeOutcome> {
  if (input.conflictedPaths.length === 0) {
    return { resolved: false, reason: "no conflicted paths to entity-merge" };
  }
  let sidesList: ReadonlyArray<ConflictFileSides>;
  try {
    sidesList = await input.sides.read(input.conflictedPaths);
  } catch (error) {
    return { resolved: false, reason: `could not read the conflict sides: ${errMsg(error)}` };
  }
  // Every conflicted path MUST have readable sides — a missing one is un-analyzable ⇒ defer
  // the whole conflict (never a partial entity-merge that leaves a conflicted file unhandled).
  const byPath = new Map(sidesList.map((s) => [s.path, s]));
  for (const path of input.conflictedPaths) {
    if (!byPath.has(path)) {
      return { resolved: false, reason: `conflict side unreadable for ${path}; defer to the agent` };
    }
  }

  const mergedFiles: Array<{ path: string; content: string }> = [];
  const entityIds: string[] = [];
  for (const path of input.conflictedPaths) {
    const sides = byPath.get(path);
    if (sides === undefined) {
      return { resolved: false, reason: `conflict side unreadable for ${path}; defer to the agent` };
    }
    let oursDiff: EntityDiffResult;
    let theirsDiff: EntityDiffResult;
    try {
      oursDiff = await input.differ.diff({ path, before: sides.base, after: sides.ours });
      theirsDiff = await input.differ.diff({ path, before: sides.base, after: sides.theirs });
    } catch (error) {
      return { resolved: false, reason: `entity diff failed for ${path}: ${errMsg(error)}; defer to the agent` };
    }
    if (!oursDiff.ok) {
      return {
        resolved: false,
        reason: `entity diff unavailable (${oursDiff.reason}) for ${path}; defer to the agent`,
      };
    }
    if (!theirsDiff.ok) {
      return {
        resolved: false,
        reason: `entity diff unavailable (${theirsDiff.reason}) for ${path}; defer to the agent`,
      };
    }
    const result = mergeOneFile(sides, oursDiff.diff, theirsDiff.diff);
    if ("defer" in result) {
      return { resolved: false, reason: result.defer };
    }
    mergedFiles.push({ path, content: result.content });
    entityIds.push(...result.entityIds);
  }
  return { resolved: true, files: mergedFiles, entityIds };
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
