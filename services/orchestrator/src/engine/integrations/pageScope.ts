type QueryTuple = readonly [string, string];
function sortedQueryTuples(url: URL, omittedKey: string): QueryTuple[] {
  return [...url.searchParams.entries()]
    .filter(([key]) => key !== omittedKey)
    .sort((left, right) => {
      const [leftKey, leftValue] = left;
      const [rightKey, rightValue] = right;
      if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
      return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
    });
}
export function sameQueryMultiset(left: URL, right: URL, omittedKey: string): boolean {
  const expected = sortedQueryTuples(left, omittedKey);
  const actual = sortedQueryTuples(right, omittedKey);
  return (
    expected.length === actual.length &&
    actual.every(([key, value], index) => key === expected[index]?.[0] && value === expected[index]?.[1])
  );
}
