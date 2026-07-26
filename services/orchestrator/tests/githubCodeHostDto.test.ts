import { describe, expect, it } from "vitest";
import {
  decodeBase64Content,
  decodeCommit,
  decodeCompare,
  decodeCompareFiles,
  decodeDefaultBranch,
  decodeRefSha,
} from "../src/engine/providers/githubCodeHostDto.js";

describe("GitHubCodeHost read DTOs", () => {
  it("rejects missing default branches and a ref that is not bound to the requested branch", () => {
    expect(() => decodeDefaultBranch({})).toThrow(/default_branch/iu);
    expect(() => decodeRefSha({ ref: "refs/heads/main", object: {} }, "refs/heads/main")).toThrow(/sha/iu);
    expect(() => decodeRefSha({ ref: "refs/heads/other", object: { sha: "abc" } }, "refs/heads/main")).toThrow(
      /bind/iu,
    );
  });

  it("rejects partial commits and compare results instead of returning a partial domain result", () => {
    expect(() => decodeCommit({ sha: "abc", message: "m", tree: { sha: "tree" } }, "abc")).toThrow(/parents/iu);
    expect(() => decodeCompare({ status: "ahead", total_commits: 2, commits: [{ author: { login: "a" } }] })).toThrow(
      /total_commits/iu,
    );
    expect(() =>
      decodeCompare({
        status: "ahead",
        total_commits: 1,
        commits: [{ author: { login: "a" }, committer: {} }],
      }),
    ).toThrow(/committer login/iu);
  });

  it("rejects files without a patch and content with unsupported or malformed encodings", () => {
    expect(() => decodeCompareFiles({ files: [{ filename: "a.ts" }] })).toThrow(/patch/iu);
    expect(() =>
      decodeCompareFiles({ files: Array.from({ length: 300 }, () => ({ filename: "a", patch: "p" })) }),
    ).toThrow(/files limit/iu);
    expect(() => decodeBase64Content({ encoding: "utf-8", content: "text" })).toThrow(/unsupported encoding/iu);
    expect(() => decodeBase64Content({ encoding: "base64", content: "not base64?" })).toThrow(/malformed base64/iu);
  });

  it("decodes a fully bound response only after every required field is present", () => {
    expect(decodeRefSha({ ref: "refs/heads/main", object: { sha: "abc" } }, "refs/heads/main")).toBe("abc");
    expect(
      decodeCompare({
        status: "ahead",
        total_commits: 1,
        commits: [{ author: { login: "alice" }, committer: { login: "alice" } }],
      }),
    ).toEqual({ status: "ahead", commits: [{ authorLogin: "alice", committerLogin: "alice" }] });
  });
});
