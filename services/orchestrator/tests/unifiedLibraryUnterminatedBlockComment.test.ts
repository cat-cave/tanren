// Regression coverage for F2: an unterminated top-level block comment must
// reject the fragment body rather than silently dropping every later operation.

import { describe, expect, it } from "vitest";
import { FragmentBodyParseError, parseFragmentBody } from "../src/engine/templates/index.js";
import { collectVfsStatements } from "../src/engine/templates/fragments/fragmentBodyWalker.js";

function bodyWith(applyBody: string): string {
  return [
    `export const fragment = {`,
    `  async apply(vfs: unknown, _config: unknown) {`,
    applyBody,
    `  },`,
    `};`,
    `export default fragment;`,
  ].join("\n");
}

describe("fragment-body walker — unterminated top-level block comments", () => {
  it("throws instead of silently dropping the operations after an unclosed block comment", () => {
    const applyBody = [
      '    vfs.write("docs/first.md", "first");',
      "    /* this comment never closes",
      '    vfs.write("docs/dropped.md", "must not disappear");',
    ].join("\n");

    expect(() => collectVfsStatements(applyBody)).toThrowError(FragmentBodyParseError);
    expect(() => collectVfsStatements(applyBody)).toThrow("unterminated block comment in fragment body");
    expect(() => parseFragmentBody(bodyWith(applyBody))).toThrowError(FragmentBodyParseError);
    expect(() => parseFragmentBody(bodyWith(applyBody))).toThrow("unterminated block comment in fragment body");
  });

  it("parses every operation after a properly closed top-level block comment", () => {
    const ops = parseFragmentBody(
      bodyWith(
        [
          '    vfs.write("docs/first.md", "first");',
          "    /* this comment closes normally */",
          '    vfs.write("docs/second.md", "second");',
        ].join("\n"),
      ),
    );

    expect(ops).toEqual([
      { kind: "write", path: "docs/first.md", content: "first" },
      { kind: "write", path: "docs/second.md", content: "second" },
    ]);
  });
});
