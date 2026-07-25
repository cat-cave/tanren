function sortedQueryTuples(url: URL, omittedKey: string): [string, string][] {
  return [...url.searchParams.entries()]
    .filter(([key]) => key !== omittedKey)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
}
export function sameQueryMultiset(left: URL, right: URL, omittedKey: string): boolean {
  return JSON.stringify(sortedQueryTuples(left, omittedKey)) === JSON.stringify(sortedQueryTuples(right, omittedKey));
}
