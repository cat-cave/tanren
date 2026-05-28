// High-entropy detector used as a defense-in-depth pass during redaction.
// The redaction serializer consults this on string fields tagged `public`
// to catch operator footguns where a credential ends up in a payload field
// the registry believes is safe. Such fields are bumped one tier — i.e.
// returned as redacted to non-admins — rather than left raw.
//
// Heuristic (documented so reviewers can challenge it):
//   1. Length floor (24 chars). Real credentials are long; English words are
//      usually shorter. URLs and slugs sometimes exceed this but are caught
//      by the character-set filter below.
//   2. Character-set diversity. The string is mostly drawn from base64,
//      hex, or url-safe-token alphabets (letters + digits + a small set of
//      symbols). A field full of words and spaces is rejected.
//   3. Shannon-entropy floor. We compute the entropy of the string's
//      character distribution. Random-looking blobs (base64-encoded tokens,
//      hex SHAs, JWT body segments) score >= 3.5 bits/char; English
//      paragraphs score < 3.5.
//   4. Whitespace rejection. If the string contains a whitespace character
//      the entropy of the whole string is meaningless for credential-spot
//      purposes (a paragraph contains many short tokens; we don't want to
//      redact paragraphs). So whitespace-bearing strings are treated as
//      not-a-credential. Operators putting tokens in prose should be
//      handled by per-field sensitivity tagging, not by this detector.
//   5. URL rejection. A `scheme://` substring disqualifies; URLs satisfy
//      the alphabet and entropy gates but are emphatically not credentials.
//   6. Character-class diversity. Real credentials use at least two of
//      {uppercase, lowercase, digit}. This drops false positives on long
//      single latin words (e.g. "supercalifragilisticexpialidocious") that
//      would otherwise pass the entropy gate.
//
// This deliberately errs toward false negatives on prose and false
// positives on long base64 blobs; the cost of a false positive is "this
// field shows REDACTED to a project member, view raw if you need it", and
// the cost of a false negative is a leaked credential — but the field-tag
// table is the primary defense, this is the safety net.

// Note: '/' and ':' are intentionally NOT in this character class. URLs and
// json-pointer paths contain those, and we don't want to flag them as
// credential-like. Real credentials (base64, hex, JWT segments, gh
// personal-access tokens) live happily inside this restricted alphabet.
const CREDENTIAL_CHAR_CLASS = /^[A-Za-z0-9+=_\-.]+$/;
const MIN_LENGTH = 24;
const MIN_ENTROPY_BITS_PER_CHAR = 3.5;

// URL_LIKE catches scheme-bearing URLs even if they happen to satisfy the
// length+entropy gates after splitting on punctuation. We reject the whole
// string up front so a redaction marker doesn't replace a public PR url.
const URL_LIKE = /:\/\//;

export interface HighEntropyOptions {
  minLength?: number;
  minEntropyBitsPerChar?: number;
}

// looksLikeCredential returns true when the string passes every gate above.
// Exported separately from `containsCredentialSubstring` so callers that
// already know the full string is the candidate can skip substring scanning.
export function looksLikeCredential(value: string, options: HighEntropyOptions = {}): boolean {
  const minLength = options.minLength ?? MIN_LENGTH;
  const minEntropy = options.minEntropyBitsPerChar ?? MIN_ENTROPY_BITS_PER_CHAR;
  if (value.length < minLength) {
    return false;
  }
  if (/\s/.test(value)) {
    return false;
  }
  if (URL_LIKE.test(value)) {
    return false;
  }
  if (!CREDENTIAL_CHAR_CLASS.test(value)) {
    return false;
  }
  if (shannonEntropyBitsPerChar(value) < minEntropy) {
    return false;
  }
  // Diversity gate: real credentials almost always contain at least two
  // of {uppercase letter, lowercase letter, digit}. English single words —
  // even long latinate ones — are almost always one of those classes only,
  // and an all-lowercase 30-char latin word has high entropy. Without this
  // gate "supercalifragilisticexpialidocious" looks like a credential.
  let classes = 0;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  return classes >= 2;
}

// shannonEntropyBitsPerChar returns the per-character entropy of a string,
// in bits. Higher is more random. Random base64 hovers around 5.5; English
// paragraphs hover around 4 if you keep punctuation/whitespace but drop to
// ~2.5 once you collapse to lower-case alpha only. Because we already
// reject whitespace-bearing inputs, the meaningful range here is "token
// alphabet" vs "long english word".
export function shannonEntropyBitsPerChar(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// containsCredentialSubstring scans a longer string for a credential-like
// substring. Used by the serializer when a `public`-tagged string holds a
// log line that may have a token embedded in it. When this returns true the
// whole string is replaced with the redaction marker — partial redaction
// of long strings is intentionally out of scope (see spec: "prefer to
// redact the whole string rather than partial").
export function containsCredentialSubstring(value: string, options: HighEntropyOptions = {}): boolean {
  const minLength = options.minLength ?? MIN_LENGTH;
  if (value.length < minLength) {
    return false;
  }
  // Split on whitespace and common punctuation; check each token. This
  // matches log lines like `auth=eyJh...` and `token: ghp_abc...`. Tokens
  // bearing a URL scheme are skipped — we don't want a PR URL to flip the
  // whole string to redacted just because it's long.
  const tokens = value.split(/[\s,;"'<>(){}[\]]+/);
  for (const token of tokens) {
    if (URL_LIKE.test(token)) {
      continue;
    }
    // Inside log lines, "key=value" is the common shape. Split off the
    // assignment so we test "value", not "key=value" as a whole — the
    // alphabet check passes for the joined form, but the entropy of a
    // short key prefix dilutes the per-char entropy. Splitting matches
    // operator intent.
    const candidates = token.split(/[=:]/);
    for (const candidate of candidates) {
      if (looksLikeCredential(candidate, options)) {
        return true;
      }
    }
  }
  return false;
}
