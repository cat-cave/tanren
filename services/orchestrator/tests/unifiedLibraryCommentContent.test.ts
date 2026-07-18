// Regression coverage for #1064 P1-B: parser comment handling must be lexical,
// never a raw regex that rewrites content inside vfs string arguments.

import { describe, expect, it } from "vitest";
import { parseFragmentBody } from "../src/engine/templates/index.js";

function bodyWith(applyBody: string): string {
  return [
    `import { type Fragment, type VirtualFileSystem, type TemplateConfig } from "../types.js";`,
    `export const fragment: Fragment = {`,
    `  id: "addon-x", version: "1.0.0", kind: "addon", contract: {},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    applyBody,
    `  },`,
    `};`,
    `export default fragment;`,
  ].join("\n");
}

describe("parseFragmentBody — comment-looking string content (#1064)", () => {
  it("preserves both writes and their exact comment-looking content", () => {
    // A raw `/* ... */` strip starts in the first write and ends in the second;
    // `//` also erases a raw line suffix. These are file content, not comments.
    const firstContent = ['const source = "https://example.test/a//b";', 'const open = "/* starts here";'].join("\n");
    const secondContent = ['const close = "ends here */";', 'const exact = "/* stays intact */";'].join("\n");
    const body = bodyWith(
      [
        `    vfs.write("src/first.ts", \`${firstContent}\`);`,
        `    vfs.write("src/second.ts", \`${secondContent}\`);`,
      ].join("\n"),
    );

    expect(parseFragmentBody(body)).toEqual([
      { kind: "write", path: "src/first.ts", content: firstContent },
      { kind: "write", path: "src/second.ts", content: secondContent },
    ]);
  });
});
