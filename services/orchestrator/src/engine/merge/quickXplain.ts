/**
 * Pure QuickXPlain minimal-conflict search.
 *
 * `isConsistent` is an exact subset oracle: true means the background plus the
 * candidate subset is safe/consistent, and false means it has a conflict. The
 * search never treats a result for one candidate set as a result for another.
 */

export interface QuickXPlainResult<T> {
  readonly minimalConflictSet: ReadonlyArray<T>;
  readonly probes: number;
  readonly testedSubsets: ReadonlyArray<ReadonlyArray<T>>;
  /** A conflict already existed in the supplied background. */
  readonly backgroundWasInconsistent: boolean;
  /** False when the background plus candidates was consistent. */
  readonly startedFromConflict: boolean;
}

function unique<T>(items: ReadonlyArray<T>): T[] {
  return [...new Set(items)];
}

function append<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): T[] {
  return unique([...left, ...right]);
}

/**
 * Isolate a 1-minimal conflict from `candidates`, relative to a consistent
 * `background`, using QuickXPlain's recursive k-way split.
 *
 * When the background itself is inconsistent, no candidate can honestly be
 * blamed, so the result reports that condition and returns an empty conflict.
 */
export function quickXPlain<T>(
  background: ReadonlyArray<T>,
  candidates: ReadonlyArray<T>,
  isConsistent: (subset: ReadonlyArray<T>) => boolean,
): QuickXPlainResult<T> {
  const base = unique(background);
  const pool = unique(candidates.filter((candidate) => !base.includes(candidate)));
  const testedSubsets: ReadonlyArray<T>[] = [];
  let probes = 0;

  const consistent = (subset: ReadonlyArray<T>): boolean => {
    const stableSubset = [...subset];
    testedSubsets.push(stableSubset);
    probes += 1;
    return isConsistent(stableSubset);
  };

  if (!consistent(base)) {
    return {
      minimalConflictSet: [],
      probes,
      testedSubsets,
      backgroundWasInconsistent: true,
      startedFromConflict: false,
    };
  }
  if (consistent(append(base, pool))) {
    return {
      minimalConflictSet: [],
      probes,
      testedSubsets,
      backgroundWasInconsistent: false,
      startedFromConflict: false,
    };
  }
  if (pool.length === 0) {
    return {
      minimalConflictSet: [],
      probes,
      testedSubsets,
      backgroundWasInconsistent: false,
      startedFromConflict: true,
    };
  }

  const search = (knownConsistentBackground: ReadonlyArray<T>, remaining: ReadonlyArray<T>): T[] => {
    if (remaining.length === 0 || !consistent(knownConsistentBackground)) return [];
    if (consistent(append(knownConsistentBackground, remaining))) return [];
    if (remaining.length === 1) return [remaining[0]!];

    const midpoint = Math.ceil(remaining.length / 2);
    const left = remaining.slice(0, midpoint);
    const right = remaining.slice(midpoint);

    // A conflict in `right` becomes background while searching `left`; if it is
    // already inconsistent, the recursive call returns no blame for `left`.
    const leftConflict = search(append(knownConsistentBackground, right), left);
    const rightConflict = search(append(knownConsistentBackground, leftConflict), right);
    return unique([...leftConflict, ...rightConflict]);
  };

  const minimalConflictSet = search(base, pool);
  return {
    minimalConflictSet,
    probes,
    testedSubsets,
    backgroundWasInconsistent: false,
    startedFromConflict: true,
  };
}
