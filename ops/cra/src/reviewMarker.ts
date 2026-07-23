// Stable idempotency marker embedded (invisibly) in every CRA review body. Keyed to
// (pr, head-sha, rubric-version) so a re-poll — even after a restored/deleted state
// directory — never posts a duplicate review for the same audited head.

const MARKER_VERSION = "v1";
const MARKER_PATTERN = /<!-- tanren-cra:v1 pr=(\d+) head=([0-9a-f]{40}) rubric=([^\s]+) -->/u;

export interface ReviewMarkerKey {
  readonly pr: number;
  readonly headSha: string;
  readonly rubricVersion: string;
}

export function buildReviewMarker(key: ReviewMarkerKey): string {
  if (!Number.isSafeInteger(key.pr) || key.pr <= 0) throw new Error(`invalid PR number: ${key.pr}`);
  if (!/^[0-9a-f]{40}$/u.test(key.headSha)) throw new Error(`invalid head SHA: ${key.headSha}`);
  if (key.rubricVersion.length === 0 || /\s/u.test(key.rubricVersion)) {
    throw new Error(`invalid rubric version: ${key.rubricVersion}`);
  }
  return `<!-- tanren-cra:${MARKER_VERSION} pr=${key.pr} head=${key.headSha} rubric=${key.rubricVersion} -->`;
}

// True when `body` carries the exact marker for this key. A different pr/head/rubric
// marker does not match, so a new head or a rubric bump is not deduplicated away.
export function bodyMatchesMarker(body: string, key: ReviewMarkerKey): boolean {
  const match = MARKER_PATTERN.exec(body);
  if (match === null) return false;
  return match[1] === String(key.pr) && match[2] === key.headSha && match[3] === key.rubricVersion;
}
