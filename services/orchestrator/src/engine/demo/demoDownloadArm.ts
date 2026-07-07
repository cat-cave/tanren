// Demos-as-evidence — the `download` surface EXERCISE ARM (design doc § "Native
// Deployment And Demos"). A `download` surface is a URL-fetchable artifact (a binary
// release, an out-of-band deliverable an operator attests to); the per-behavior
// exercise DOWNLOADS the artifact and — when the behavior declares an expected
// checksum — VERIFIES the observed SHA-256 against it. The recorded detail is the
// observable shape (`GET <url> → HTTP 200, SHA-256 matches` / `does not match`),
// never the body.
//
// PROBE SEAM: `DemoDownloadProbe.fetch` performs one HTTP GET, streams the body
// through a SHA-256 hasher, and returns the observed status + size + hex digest.
// Injectable — scripted in tests, a real `fetch` in production. A transport-level
// failure (DNS/connection) throws, which the arm records as a FAILED behavior. The
// PER-BEHAVIOR expectation (an `expectedSha256`) is read off the behavior's
// free-form metadata (mirrors `surfacePath` on web behaviors); when absent, the arm
// records "downloadable" evidence with the observed digest (never a fabricated
// "matches" verdict when no expectation was declared).
//
// NO BODY BUFFERING for large artifacts: the SHA-256 hash is COMPUTED INCREMENTALLY over
// the streamed response body (never materialized in memory beyond the hasher's window),
// so a large release artifact does not blow the process — the arm hashes what the
// transport streams. Uses Node's `crypto` via `createHash("sha256")` on a streamed
// response body reader.

import { createHash } from "node:crypto";

import type { DemoSurface } from "../contracts/deployAdapter.js";
import type { BehaviorEvidence } from "./demoEvidence.js";

/** The observable result of a `download` fetch — the HTTP status + observed digest + size. */
export interface DownloadResult {
  /** The HTTP status the server returned (200 ⇒ downloadable). */
  status: number;
  /** The SHA-256 hex digest of the downloaded body (empty when status was non-2xx). */
  sha256Hex: string;
  /** The observed body size in bytes (0 when status was non-2xx). */
  sizeBytes: number;
}

/**
 * The download probe the `download` exercise arm runs over. Injectable seam (scripted in
 * tests; a real streaming `fetch` in production) so the arm proves per-behavior exercise
 * WITHOUT a live network call. Resolves to the HTTP status + observed digest + size; a
 * transport-level failure throws (recorded as FAILED evidence by the arm).
 */
export interface DemoDownloadProbe {
  /** Fetch `url` fully, stream-hash the body, and return the observed status/digest/size. */
  fetch(input: { url: string }): Promise<DownloadResult>;
}

/**
 * Read the expected SHA-256 hex digest a behavior may declare on a download surface
 * (from its free-form `metadata.expectedSha256`). Only a plausibly-shaped hex string
 * (64 hex chars, case-insensitive) is honored — anything else is treated as absent so
 * the arm records "downloadable" evidence with the observed digest rather than a bogus
 * "does not match" verdict against a malformed expectation.
 */
export function resolveExpectedSha256(metadata: Record<string, unknown>): string {
  const raw = metadata["expectedSha256"];
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().toLowerCase();
  return /^[0-9a-f]{64}$/u.test(trimmed) ? trimmed : "";
}

/**
 * Exercise ONE behavior against a `download` surface: fetch the artifact, hash it,
 * and (when the behavior declares an `expectedSha256`) verify the digest. Passed:
 *   • 2xx download AND (no expectation OR matching digest).
 * Failed:
 *   • non-2xx (server refused / gone),
 *   • digest mismatch when an expectation was declared,
 *   • transport-level failure (captured in the detail).
 *
 * The detail is the observable shape:
 *   `GET <url> → HTTP 200 (sha256=<8-hex-prefix>…, size=<N>B)` (no expectation),
 *   `GET <url> → HTTP 200 SHA-256 matches` (expectation matched),
 *   `GET <url> → HTTP 200 SHA-256 mismatch (expected <8-hex-prefix>…, got <8-hex-prefix>…)`.
 * Never the body.
 *
 * Returns evidence — NEVER throws on a failed download. The demo records "behavior X
 * failed", it does not abort.
 */
export async function exerciseDownloadBehavior(
  probe: DemoDownloadProbe,
  surface: Extract<DemoSurface, { kind: "download" }>,
  behavior: { behaviorId: string; behaviorTitle: string; metadata: Record<string, unknown> },
): Promise<BehaviorEvidence> {
  const expected = resolveExpectedSha256(behavior.metadata);
  const base: Pick<BehaviorEvidence, "behaviorId" | "behaviorTitle" | "surfaceKind"> = {
    behaviorId: behavior.behaviorId,
    behaviorTitle: behavior.behaviorTitle,
    surfaceKind: "download",
  };
  try {
    const result = await probe.fetch({ url: surface.artifactUrl });
    const downloadable = result.status >= 200 && result.status < 300;
    if (!downloadable) {
      return { ...base, outcome: "failed", detail: `GET ${surface.artifactUrl} → HTTP ${String(result.status)}` };
    }
    if (expected === "") {
      // No declared expectation — evidence is "downloadable"; the observed digest is
      // recorded so a future audit can pin it. Never fabricate a "matches" verdict.
      return {
        ...base,
        outcome: "passed",
        detail:
          `GET ${surface.artifactUrl} → HTTP ${String(result.status)} ` +
          `(sha256=${digestPrefix(result.sha256Hex)}, size=${String(result.sizeBytes)}B)`,
      };
    }
    const matches = expected === result.sha256Hex;
    return {
      ...base,
      outcome: matches ? "passed" : "failed",
      detail: matches
        ? `GET ${surface.artifactUrl} → HTTP ${String(result.status)} SHA-256 matches`
        : `GET ${surface.artifactUrl} → HTTP ${String(result.status)} SHA-256 mismatch ` +
          `(expected ${digestPrefix(expected)}, got ${digestPrefix(result.sha256Hex)})`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...base, outcome: "failed", detail: `GET ${surface.artifactUrl} → unreachable (${message})` };
  }
}

/** Truncate a hex digest for the observable detail — enough to identify, never the whole hash. */
function digestPrefix(hex: string): string {
  return hex === "" ? "<none>" : `${hex.slice(0, 12)}…`;
}

/**
 * Build the production `DemoDownloadProbe` — a real `fetch` GET that streams the body
 * through a SHA-256 hasher (never materialized in memory) and returns the observed
 * status + digest + size. A non-2xx response returns `{ status, sha256Hex: "", sizeBytes: 0 }`
 * without consuming the body; a transport-level failure propagates as a throw.
 */
export function fetchDemoDownloadProbe(fetchImpl: typeof fetch = fetch): DemoDownloadProbe {
  return {
    async fetch({ url }): Promise<DownloadResult> {
      const response = await fetchImpl(url, { method: "GET", redirect: "follow" });
      if (!response.ok) {
        return { status: response.status, sha256Hex: "", sizeBytes: 0 };
      }
      const hasher = createHash("sha256");
      let sizeBytes = 0;
      const body = response.body;
      if (body === null) {
        return { status: response.status, sha256Hex: hasher.digest("hex"), sizeBytes: 0 };
      }
      const reader = body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value = chunk.value;
        if (value !== undefined) {
          hasher.update(value);
          sizeBytes += value.byteLength;
        }
      }
      return { status: response.status, sha256Hex: hasher.digest("hex"), sizeBytes };
    },
  };
}
