// Unit tests for same-origin relative `next` validation (open-redirect hardening).

import { describe, expect, it } from "vitest";
import { isSafeRelativePath, safeNextPath } from "../src/auth/safeNext.js";

describe("isSafeRelativePath", () => {
  it("accepts root-relative paths with query/hash", () => {
    expect(isSafeRelativePath("/")).toBe(true);
    expect(isSafeRelativePath("/projects")).toBe(true);
    expect(isSafeRelativePath("/projects?tab=runs")).toBe(true);
    expect(isSafeRelativePath("/runs/r1#timeline")).toBe(true);
  });

  it("rejects absolute URLs and protocol-relative targets", () => {
    expect(isSafeRelativePath("https://evil.example/phish")).toBe(false);
    expect(isSafeRelativePath("http://evil.example")).toBe(false);
    expect(isSafeRelativePath("//evil.example/phish")).toBe(false);
    expect(isSafeRelativePath("///evil.example")).toBe(false);
  });

  it("rejects scheme-bearing and backslash tricks", () => {
    expect(isSafeRelativePath("/javascript:alert(1)")).toBe(false);
    expect(isSafeRelativePath("/http://evil.example")).toBe(false);
    expect(isSafeRelativePath("/\\evil.example")).toBe(false);
    expect(isSafeRelativePath("projects")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
  });

  it("rejects CR/LF/NUL/tab and other control characters", () => {
    expect(isSafeRelativePath("/ok\r\nLocation: https://evil.example")).toBe(false);
    expect(isSafeRelativePath("/ok\0x")).toBe(false);
    // Tab-normalized protocol-relative: `/\t//host` must not pass.
    expect(isSafeRelativePath("/\t//evil.example")).toBe(false);
    expect(isSafeRelativePath("/\u000C//evil.example")).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("returns the path when safe", () => {
    expect(safeNextPath("/projects")).toBe("/projects");
    expect(safeNextPath("/runs/r1?tab=events")).toBe("/runs/r1?tab=events");
  });

  it("falls back for missing/unsafe input", () => {
    expect(safeNextPath()).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example", "/home")).toBe("/home");
  });

  it("rejects percent-encoded protocol-relative payloads after decode", () => {
    // "%2F%2F" decodes to "//" — the classic protocol-relative open-redirect.
    const encodedHost = `%2F%2F${"evil"}.example`;
    const encodedPath = `%2F%2F${"evil"}.example%2F${"phish"}`;
    expect(safeNextPath(encodedHost)).toBe("/");
    expect(safeNextPath(encodedPath)).toBe("/");
  });

  it("rejects a non-relative custom fallback (including missing raw)", () => {
    expect(safeNextPath("//evil", "//also-evil")).toBe("/");
    expect(safeNextPath(null, "https://evil.example")).toBe("/");
    expect(safeNextPath("", "//evil.example")).toBe("/");
  });
});
