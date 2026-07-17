// cspell:ignore Zeller

/**
 * Pure Zeller delta debugging.
 *
 * The oracle is deliberately supplied by the caller. This module does not run a
 * gate, persist a probe, or infer a result from a different subset. Every result
 * used to reduce the current set is an exact oracle result for that set.
 */

export interface DdminOptions {
  /** Initial number of partitions for the first k-way split. */
  readonly initialGranularity?: number;
}

export interface DdminResult<T> {
  readonly minimalFailingSet: ReadonlyArray<T>;
  readonly probes: number;
  readonly testedSubsets: ReadonlyArray<ReadonlyArray<T>>;
  /** False when the supplied set was not failing. */
  readonly startedFromFailure: boolean;
}

function partition<T>(items: ReadonlyArray<T>, count: number): ReadonlyArray<ReadonlyArray<T>> {
  const partitions: T[][] = [];
  const width = Math.ceil(items.length / count);
  for (let offset = 0; offset < items.length; offset += width) {
    partitions.push(items.slice(offset, offset + width));
  }
  return partitions;
}

function complement<T>(items: ReadonlyArray<T>, part: ReadonlyArray<T>): T[] {
  const selected = new Set(part);
  return items.filter((item) => !selected.has(item));
}

function clampGranularity(value: number, itemCount: number): number {
  if (!Number.isInteger(value) || value < 2) return 2;
  return Math.min(value, itemCount);
}

/**
 * Find a 1-minimal failing subset using Zeller's ddmin search.
 *
 * The algorithm checks both k-way partitions and their complements. It therefore
 * handles interaction failures without assuming that one ordered prefix contains
 * the culprit. It makes no monotonicity claim about results outside the exact
 * subsets passed to `isFailing`.
 */
export function ddmin<T>(
  items: ReadonlyArray<T>,
  isFailing: (subset: ReadonlyArray<T>) => boolean,
  options: DdminOptions = {},
): DdminResult<T> {
  let current = [...items];
  const testedSubsets: ReadonlyArray<T>[] = [];
  let probes = 0;

  const probe = (subset: ReadonlyArray<T>): boolean => {
    const stableSubset = [...subset];
    testedSubsets.push(stableSubset);
    probes += 1;
    return isFailing(stableSubset);
  };

  if (!probe(current)) {
    return { minimalFailingSet: [], probes, testedSubsets, startedFromFailure: false };
  }
  if (current.length < 2) {
    return { minimalFailingSet: current, probes, testedSubsets, startedFromFailure: true };
  }

  let granularity = clampGranularity(options.initialGranularity ?? 2, current.length);
  while (current.length >= 2) {
    const parts = partition(current, granularity);
    let reduced = false;

    for (const part of parts) {
      if (probe(part)) {
        current = [...part];
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;

    for (const part of parts) {
      const rest = complement(current, part);
      if (rest.length > 0 && probe(rest)) {
        current = rest;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;

    if (granularity >= current.length) break;
    granularity = Math.min(current.length, granularity * 2);
  }

  return { minimalFailingSet: current, probes, testedSubsets, startedFromFailure: true };
}
