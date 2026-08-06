import { describe, expect, it } from "vitest";
import {
  decodeBase64Content,
  decodeCommit,
  decodeCompare,
  decodeComparePage,
  decodeCompareStatus,
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

  it("rejects partial commits and malformed compare identities instead of returning a partial domain result", () => {
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
    expect(
      decodeCompare({
        status: "ahead",
        total_commits: 2,
        commits: [
          { author: { login: "alice" }, committer: null },
          { author: null, committer: { login: "alice" } },
        ],
      }),
    ).toEqual({
      status: "ahead",
      commits: [
        { authorLogin: "alice", committerLogin: "" },
        { authorLogin: "", committerLogin: "alice" },
      ],
    });
    expect(() =>
      decodeCompare({ status: "ahead", total_commits: 1, commits: [{ author: {}, committer: { login: "alice" } }] }),
    ).toThrow(/author login/iu);
    expect(() =>
      decodeCompare({ status: "ahead", total_commits: 1, commits: [{ author: { login: "alice" } }] }),
    ).toThrow(/committer response was not an object/iu);
  });

  it("accepts GitHub's omitted binary/rename patch but rejects malformed file DTOs and content encodings", () => {
    expect(decodeCompareFiles({ files: [{ filename: "image.png" }] })).toEqual([
      { filename: "image.png", patch: undefined },
    ]);
    expect(() => decodeCompareFiles({ files: [{ filename: "a.ts", patch: null }] })).toThrow(/patch response/iu);
    expect(() => decodeCompareFiles({ files: [{ patch: "p" }] })).toThrow(/filename/iu);
    expect(() =>
      decodeCompareFiles({ files: Array.from({ length: 300 }, () => ({ filename: "a", patch: "p" })) }),
    ).toThrow(/files limit/iu);
    expect(() =>
      decodeCompareFiles({ files: Array.from({ length: 301 }, () => ({ filename: "a", patch: "p" })) }),
    ).toThrow(/files limit/iu);
    expect(
      decodeCompareFiles({ files: [{ filename: "large.diff", patch: "x".repeat(200_000) }] })[0]?.patch,
    ).toHaveLength(200_000);
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

  it("keeps status reads valid when compare commits are paginated, while author pages remain strict", () => {
    const partial = { status: "ahead", total_commits: 101, commits: [] };
    expect(decodeCompareStatus(partial)).toBe("ahead");
    expect(decodeComparePage(partial, false)).toMatchObject({ status: "ahead", totalCommits: 101, commits: [] });
    expect(() => decodeCompare(partial)).toThrow(/total_commits/iu);
  });
});
