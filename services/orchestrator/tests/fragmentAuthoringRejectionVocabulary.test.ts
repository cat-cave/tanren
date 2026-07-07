// Rejection vocabulary — the writer-facing error messages parseFragmentBody
// throws (task #150, audit finding H4). Every rejection reaches the writer as
// `previousAttempt.rejection` on the NEXT authoring call; the writer-rework
// loop's ability to converge depends on the rejection naming the specific op +
// giving a concrete accepted alternative. A generic "unsupported vfs
// operation" without direction leaves the writer no path forward and the loop
// halts at the fixed point burning credits.
//
// These tests pin the message shape: on each rejection class the message
// (a) names the specific op the writer used, (b) enumerates the accepted
// alternatives, and (c) hints at the closest legitimate replacement.

import { describe, expect, it } from "vitest";
import { FragmentBodyParseError, parseFragmentBody } from "../src/engine/templates/index.js";

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

function captureRejection(bodyTs: string): string {
  try {
    parseFragmentBody(bodyTs);
  } catch (err) {
    if (err instanceof FragmentBodyParseError) return err.message;
    throw err;
  }
  throw new Error("expected parseFragmentBody to throw");
}

describe("parseFragmentBody rejection vocabulary — 'unsupported vfs operation'", () => {
  it("names the specific method the writer tried + lists ALL allowed ops so the writer can self-correct", () => {
    const body = bodyWith(`    vfs.readFile("/etc/passwd");`);
    const reason = captureRejection(body);
    expect(reason).toContain("vfs.readFile");
    // The full legend of allowed ops is included so the writer sees the accepted set.
    expect(reason).toContain("vfs.write");
    expect(reason).toContain("vfs.overwrite");
    expect(reason).toContain("vfs.addPackageJsonDep");
    expect(reason).toContain("vfs.addPackageJsonDevDep");
    expect(reason).toContain("vfs.addEnvVar");
    expect(reason).toContain("vfs.appendToJustfileTarget");
  });

  it("hints at the closest accepted replacement for a read-like method name", () => {
    const body = bodyWith(`    vfs.getFile("foo");`);
    const reason = captureRejection(body);
    // The suggestion for read-like names calls out that reads are unsupported +
    // points to bake-in at authoring time.
    expect(reason).toMatch(/does NOT support reads|bake it into the literal/iu);
  });

  it("hints at addPackageJsonDep for install-like method names", () => {
    const body = bodyWith(`    vfs.installDep("react");`);
    const reason = captureRejection(body);
    expect(reason).toContain("vfs.addPackageJsonDep");
  });

  it("hints at overwrite for delete-like method names", () => {
    const body = bodyWith(`    vfs.deleteFile("foo");`);
    const reason = captureRejection(body);
    expect(reason).toContain("vfs.overwrite");
  });

  it("explicitly denies interpolation/branching/loops so the writer stops trying those shapes", () => {
    const body = bodyWith(`    vfs.magicalOp("x");`);
    const reason = captureRejection(body);
    expect(reason).toMatch(/string interpolation|conditionals|loops/iu);
  });
});

describe("parseFragmentBody rejection vocabulary — argument count", () => {
  it("names the op + expected/got count + a concrete example for that op", () => {
    // vfs.write expects 2 args; give it 1 to trigger the arg-count rejection.
    const body = bodyWith(`    vfs.write("only-one-arg");`);
    const reason = captureRejection(body);
    expect(reason).toContain("vfs.write expects 2 args");
    expect(reason).toContain(`vfs.write("docs/hello.md"`);
  });

  it("names an addPackageJsonDep example when addPackageJsonDep is misused", () => {
    // Give addPackageJsonDep 3 args.
    const body = bodyWith(`    vfs.addPackageJsonDep("react", "^19.0.0", "extra");`);
    const reason = captureRejection(body);
    expect(reason).toContain("vfs.addPackageJsonDep expects 2 args");
    expect(reason).toMatch(/react|\^19/u);
  });
});

describe("parseFragmentBody rejection vocabulary — 'no apply block'", () => {
  it("names the required signature + gives a full-fragment example", () => {
    const reason = captureRejection("this is not a valid fragment module");
    expect(reason).toContain("apply(vfs, config)");
    expect(reason).toContain("export const fragment");
    expect(reason).toContain("export default fragment");
  });
});

describe("parseFragmentBody rejection vocabulary — string / array literal expectations", () => {
  it("string-literal rejection names the accepted forms + rejects interpolation up-front", () => {
    // Two args, but the second one is an identifier (not a literal). This forces
    // parseStringLiteral to fail on a non-literal token — the rejection must
    // explain that ONLY literals are accepted.
    const body = bodyWith(`    vfs.write("docs/x.md", someVariable);`);
    const reason = captureRejection(body);
    expect(reason).toMatch(/double-quoted|backtick|literal string|Only literal/iu);
    // The example makes the accepted call shape concrete.
    expect(reason).toContain(`vfs.write(`);
  });

  it("array-literal rejection names the accepted shape + a concrete example", () => {
    const body = bodyWith(`    vfs.appendToJustfileTarget("bootstrap", "not-an-array");`);
    const reason = captureRejection(body);
    expect(reason).toContain("array literal");
    expect(reason).toContain("appendToJustfileTarget");
    expect(reason).toContain("bootstrap");
  });
});
