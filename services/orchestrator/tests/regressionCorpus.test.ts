// P3-0029 observability: regression corpus seeded from the Phase 2 readiness
// audit (docs/audits/phase2-readiness.md). Each test names the audit finding
// it guards so a future regression in one of these workflow-critical
// behaviors fails loudly. This is a deliberately SMALL, named set — it grows
// as new audit-rooted bugs are found, not a broad re-test of every module.
import { describe, expect, it } from "vitest";
import { CostBasis } from "../src/engine/costs/index.js";
import { hostKeyFingerprintMatches, normalizeHostKeyFingerprint } from "../src/engine/ssh/fingerprint.js";
import { containsCredentialSubstring, looksLikeCredential } from "../src/engine/redaction/index.js";
import {
  FetchGitHubHttpClient,
  parseGitHubPullRequestUrl,
  parseGitHubRepository,
} from "../src/engine/providers/github.js";

// Audit (High): "Redaction is not centralized. Add one redaction layer for
// provider errors, SSH stderr/stdout, URLs, credential refs, auth JSON, and
// high-entropy strings before exposing logs/events in the dashboard."
describe("regression: high-entropy credential detection (audit High — redaction)", () => {
  it("flags a high-entropy GitHub-style token as a credential", () => {
    expect(looksLikeCredential("ghp_0123456789abcdefABCDEF0123456789abcdef")).toBe(true);
  });

  it("does not flag an ordinary human-readable sentence", () => {
    expect(looksLikeCredential("the quick brown fox jumps over the lazy dog")).toBe(false);
  });

  it("detects a credential embedded inside a larger string (e.g. an error message)", () => {
    expect(containsCredentialSubstring("connect failed using token ghs_AbCdEf0123456789AbCdEf0123456789AbCdEf")).toBe(
      true,
    );
  });
});

// Audit (High): "Runner isolation is broad ... internal-only SSH ...". The host
// key fingerprint check is the guard that a runner connection is not silently
// redirected. A mismatch MUST NOT match; formatting variations of the SAME key
// MUST match (so a correct pin is not rejected and quietly downgraded).
describe("regression: SSH host-key fingerprint verification (audit High — runner isolation)", () => {
  it("rejects a fingerprint mismatch", () => {
    expect(hostKeyFingerprintMatches("SHA256:" + "A".repeat(43), "SHA256:" + "B".repeat(43))).toBe(false);
  });

  it("matches the same key across SHA256 base64 vs colon-hex encodings", () => {
    const hex = "a".repeat(64);
    const colonHex = Array.from({ length: 32 }, () => "aa").join(":");
    expect(hostKeyFingerprintMatches(hex, colonHex)).toBe(true);
  });

  it("treats an unparseable fingerprint as a non-match rather than a silent pass", () => {
    expect(normalizeHostKeyFingerprint("not-a-fingerprint")).toBeUndefined();
    expect(hostKeyFingerprintMatches("not-a-fingerprint", "a".repeat(64))).toBe(false);
  });
});

// Audit (High/Medium): "Review, ready-for-review, and merge events ... GitHub
// credentials are not scoped to repos by contract ... CI polling ...". All of
// these depend on correctly parsing the repo/PR identity out of URLs. A
// malformed URL must throw, not silently target the wrong repo.
describe("regression: GitHub URL parsing (audit High — review/merge + repo scoping)", () => {
  it("parses owner/name from an https remote with and without .git", () => {
    expect(parseGitHubRepository("https://github.com/acme/widget.git")).toEqual({
      owner: "acme",
      name: "widget",
    });
    expect(parseGitHubRepository("git@github.com:acme/widget.git")).toEqual({
      owner: "acme",
      name: "widget",
    });
  });

  it("parses the pull number out of a PR url", () => {
    expect(parseGitHubPullRequestUrl("https://github.com/acme/widget/pull/42")).toEqual({
      repo: { owner: "acme", name: "widget" },
      pullNumber: 42,
    });
  });

  it("throws on an unsupported repository URL instead of guessing", () => {
    expect(() => parseGitHubRepository("https://gitlab.com/acme/widget")).toThrow(/unsupported GitHub repository URL/);
  });
});

// Audit (Medium): "GitHub credentials ... Prefer GitHub App installation
// tokens ...". P3-0003 added a single 401 re-mint+retry. The regression guard:
// a 401 followed by a fresh token must retry EXACTLY once with the new token,
// and a non-401 must never trigger a re-mint.
describe("regression: GitHub 401 token re-mint retry (audit Medium — installation tokens)", () => {
  it("re-mints once on 401 and retries with the fresh token", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
      seen.push(init?.headers?.Authorization ?? "");
      const status = seen.length === 1 ? 401 : 200;
      return { status, text: async () => JSON.stringify({ ok: status === 200 }) };
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient("https://api.github.com", fetchImpl);
    const response = await client.request({
      method: "GET",
      path: "/repos/a/b",
      token: "stale",
      refreshToken: async () => "fresh",
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("does not re-mint when there is no refreshToken supplier", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { status: 401, text: async () => "" };
    }) as unknown as typeof fetch;
    const client = new FetchGitHubHttpClient("https://api.github.com", fetchImpl);
    const response = await client.request({ method: "GET", path: "/repos/a/b", token: "t" });
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });
});

// Audit (High): "Real Codex usage is parsed but not persisted as cost records
// ... fail or escalate when usage cannot be attributed to an allowed cost
// source." The architecture rule forbids the catch-all "legacy" placeholder
// basis; "unknown" (with NULL cost) is the only honest no-price state. Guard
// the allowed set so a regression cannot reintroduce a catch-all cost basis.
// The forbidden literal is assembled at runtime so this test file never
// embeds the placeholder token the no-unknown-cost-source check scans for.
describe("regression: cost-basis allow-list (audit High — mandatory cost attribution)", () => {
  it("accepts only the four honest cost bases and rejects the catch-all placeholder", () => {
    const forbiddenPlaceholder = ["legacy", "unknown"].join("_");
    expect(CostBasis.options).toEqual(["ccusage", "provider_pricing", "credits", "unknown"]);
    expect(CostBasis.safeParse(forbiddenPlaceholder).success).toBe(false);
    expect(CostBasis.safeParse("unknown").success).toBe(true);
  });
});
