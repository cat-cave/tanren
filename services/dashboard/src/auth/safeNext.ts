/**
 * safeNextPath — same-origin relative-path validator for post-login `next`
 * redirects (open-redirect hardening, CX-008 / CHK-052).
 *
 * Accepts only paths that are:
 *   - `/`-prefixed (root-relative)
 *   - not protocol-relative (`//…`)
 *   - not absolute URLs / scheme-bearing (`https:…`, `javascript:…`)
 *   - free of backslash tricks and CR/LF/NUL injection into Location headers
 *
 * Rejected input falls back to `fallback` (default `/`) — never throw from a
 * redirect path; fail closed to a known-safe landing.
 */

const DEFAULT_FALLBACK = "/";

/**
 * Return a same-origin relative path safe to put in a Location header, or
 * `fallback` when `raw` is missing/unsafe.
 */
export function safeNextPath(raw: string | undefined | null, fallback: string = DEFAULT_FALLBACK): string {
  // Always sanitize the fallback first so a caller-supplied unsafe default cannot
  // leak into a Location header (including the missing/empty-raw path).
  const safeFallback = isSafeRelativePath(fallback) ? fallback : DEFAULT_FALLBACK;
  if (raw === undefined || raw === null || raw === "") {
    return safeFallback;
  }
  if (!isSafeRelativePath(raw)) {
    return safeFallback;
  }
  // Also reject after one decode pass so encoded `//host` payloads cannot sneak past.
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw && !isSafeRelativePath(decoded)) {
      return safeFallback;
    }
  } catch {
    // Malformed percent-encoding → refuse.
    return safeFallback;
  }
  return raw;
}

/** True when `value` is a same-origin relative path (`/`-prefixed, no scheme). */
export function isSafeRelativePath(value: string): boolean {
  if (value === "") {
    return false;
  }
  // Must be root-relative: single leading slash, not protocol-relative `//`.
  if (!value.startsWith("/") || value.startsWith("//")) {
    return false;
  }
  // Absolute / scheme-bearing (including `/http://…` oddities) and backslash tricks.
  if (value.includes("://") || value.includes("\\")) {
    return false;
  }
  // Reject ALL ASCII control characters (C0 + DEL). Tabs/form-feeds can be
  // normalized away by some browsers and turn `/\t//host` into a protocol-relative
  // Location; CR/LF enable header injection.
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) {
      return false;
    }
  }
  // Scheme after a single slash (e.g. `/javascript:alert(1)`).
  if (/^\/[a-z][a-z0-9+.-]*:/iu.test(value)) {
    return false;
  }
  return true;
}
