import { describe, expect, it } from "vitest";
import {
  containsCredentialSubstring,
  looksLikeCredential,
  shannonEntropyBitsPerChar
} from "../src/engine/redaction/highEntropy.js";

describe("high-entropy detector", () => {
  it("flags a 40+ char base64 blob as credential-like", () => {
    expect(looksLikeCredential("Y3JlZGVudGlhbHN1cGVybG9uZ29wYXF1ZXRva2VuMjAyNg==aaaaBBBB")).toBe(true);
  });

  it("flags a hex-shaped SHA-like token", () => {
    expect(looksLikeCredential("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0")).toBe(true);
  });

  it("rejects short strings", () => {
    expect(looksLikeCredential("ghp_abc")).toBe(false);
  });

  it("rejects english words and prose", () => {
    expect(looksLikeCredential("supercalifragilisticexpialidocious")).toBe(false);
    expect(
      looksLikeCredential(
        "the planner decided to decompose this work into three subtasks because the spec mentioned"
      )
    ).toBe(false);
  });

  it("rejects strings with spaces or punctuation outside the token alphabet", () => {
    expect(looksLikeCredential("hello world this is a normal sentence with many words")).toBe(false);
    expect(looksLikeCredential("https://github.com/owner/repo/pull/123")).toBe(false);
  });

  it("entropy: random base64 > english paragraph", () => {
    const base64 = "Y3JlZGVudGlhbHN1cGVybG9uZ29wYXF1ZXRva2VuMjAyNg==";
    const englishOnlyLetters = "thequickbrownfoxjumpsoverthelazydogmany";
    const baseEntropy = shannonEntropyBitsPerChar(base64);
    const englishEntropy = shannonEntropyBitsPerChar(englishOnlyLetters);
    expect(baseEntropy).toBeGreaterThan(englishEntropy);
  });

  it("containsCredentialSubstring catches embedded tokens in log lines", () => {
    expect(
      containsCredentialSubstring("auth=Y3JlZGVudGlhbHN1cGVybG9uZ29wYXF1ZXRva2VuMjAyNg==aaaa")
    ).toBe(true);
  });

  it("containsCredentialSubstring tolerates normal log lines", () => {
    expect(
      containsCredentialSubstring(
        "the writer applied a diff to PHASE1.md and committed deadbeef as the new HEAD"
      )
    ).toBe(false);
  });
});
