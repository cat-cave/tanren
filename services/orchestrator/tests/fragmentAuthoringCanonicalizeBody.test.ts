// Fixed-point signature canonicalizer for the F2 fragment-authoring writer-rework
// loop (task #150, audit finding H1). The loop halts when the same body +
// rejection recurs; a stubborn writer that adds whitespace or comment noise
// between attempts used to defeat the detector by hashing to a "different" body
// every time, so the loop burned unbounded LLM credits. This test pins the
// invariant: cosmetic-only edits collapse onto ONE canonical signature; genuine
// semantic changes still hash differently.
//
// The canonicalizer has two paths:
//   - STRUCTURAL: parseable bodies map to their parsed `FragmentOp[]` — a body
//     with reordered import statements or extra whitespace between ops hashes
//     identically to its "clean" sibling.
//   - LEXICAL: un-parseable bodies (the common early-writer failure) fall back
//     to a whitespace + comment + trailing-comma normalization, so even a
//     malformed body with cosmetic churn still trips the fixed-point detector.

import { describe, expect, it } from "vitest";
import { canonicalizeBodySignature, lexicallyNormalize } from "../src/engine/templates/index.js";

// ── Structural path — parseable bodies ─────────────────────────────────────

function makeApplyBody(applyLines: string): string {
  return [
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    ``,
    `export const fragment: Fragment = {`,
    `  id: "addon-example",`,
    `  version: "1.0.0",`,
    `  kind: "addon",`,
    `  contract: {},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    applyLines,
    `  },`,
    `};`,
    `export default fragment;`,
  ].join("\n");
}

describe("canonicalizeBodySignature — structural (parseable body) path", () => {
  it("two parseable bodies that differ only in whitespace hash IDENTICALLY", () => {
    const a = makeApplyBody(`    vfs.write("docs/x.md", "hello");`);
    const b = makeApplyBody(`\n\n     vfs.write(     "docs/x.md",     "hello"      );\n\n`);
    expect(canonicalizeBodySignature(a)).toBe(canonicalizeBodySignature(b));
  });

  it("two parseable bodies that differ only in comments hash IDENTICALLY", () => {
    const a = makeApplyBody(`    vfs.write("docs/x.md", "hello");`);
    const b = makeApplyBody(
      [
        `    // this comment did not exist before`,
        `    /* nor did this block comment */`,
        `    vfs.write("docs/x.md", "hello");`,
      ].join("\n"),
    );
    expect(canonicalizeBodySignature(a)).toBe(canonicalizeBodySignature(b));
  });

  it("two parseable bodies that differ SEMANTICALLY (different op arguments) hash DIFFERENTLY", () => {
    const a = makeApplyBody(`    vfs.write("docs/x.md", "hello");`);
    const b = makeApplyBody(`    vfs.write("docs/y.md", "hello");`);
    expect(canonicalizeBodySignature(a)).not.toBe(canonicalizeBodySignature(b));
  });

  it("two parseable bodies that differ SEMANTICALLY (different op order) hash DIFFERENTLY", () => {
    // Op order IS load-bearing (a fragment that appends dep A before B produces a
    // different package.json than one that appends B before A when the versions
    // conflict). The canonicalizer preserves that.
    const a = makeApplyBody(
      [`    vfs.addPackageJsonDep("react", "^19.0.0");`, `    vfs.addPackageJsonDep("preact", "^10.0.0");`].join("\n"),
    );
    const b = makeApplyBody(
      [`    vfs.addPackageJsonDep("preact", "^10.0.0");`, `    vfs.addPackageJsonDep("react", "^19.0.0");`].join("\n"),
    );
    expect(canonicalizeBodySignature(a)).not.toBe(canonicalizeBodySignature(b));
  });

  it("the structural signature is prefixed with 'ops:' so an operator can see the path taken", () => {
    const parseable = makeApplyBody(`    vfs.write("docs/x.md", "hello");`);
    expect(canonicalizeBodySignature(parseable).startsWith("ops:")).toBe(true);
  });
});

// ── Lexical path — un-parseable bodies ─────────────────────────────────────

describe("canonicalizeBodySignature — lexical (un-parseable body) fallback", () => {
  it("two un-parseable bodies that differ only in whitespace hash IDENTICALLY", () => {
    const a = "this is not a valid fragment body";
    const b = "this   is\n\nnot\ta valid   fragment    body";
    expect(canonicalizeBodySignature(a)).toBe(canonicalizeBodySignature(b));
  });

  it("two un-parseable bodies that differ only in comments hash IDENTICALLY", () => {
    const a = "garbage output no apply block";
    const b = "// leading comment\ngarbage /* mid */ output no apply block /* trailing */";
    expect(canonicalizeBodySignature(a)).toBe(canonicalizeBodySignature(b));
  });

  it("two un-parseable bodies that differ SEMANTICALLY still hash DIFFERENTLY", () => {
    const a = "garbage output no apply block";
    const b = "different garbage entirely with different tokens";
    expect(canonicalizeBodySignature(a)).not.toBe(canonicalizeBodySignature(b));
  });

  it("the lexical signature is prefixed with 'raw:' so an operator can see the path taken", () => {
    const unparseable = "no apply block here";
    expect(canonicalizeBodySignature(unparseable).startsWith("raw:")).toBe(true);
  });

  it("lexicallyNormalize collapses whitespace runs to a single space", () => {
    expect(lexicallyNormalize("a   b\t\tc\n\nd")).toBe("a b c d");
  });

  it("lexicallyNormalize strips block + line comments", () => {
    expect(lexicallyNormalize("a // tail comment\n/* block */ b")).toBe("a b");
  });

  it("lexicallyNormalize strips trailing commas inside brackets", () => {
    expect(lexicallyNormalize("foo(a, b,)")).toBe("foo(a, b)");
    expect(lexicallyNormalize("[1, 2, 3,]")).toBe("[1, 2, 3]");
    expect(lexicallyNormalize("{a: 1, b: 2,}")).toBe("{a: 1, b: 2}");
  });
});

// ── The stubborn-writer scenario ────────────────────────────────────────────

describe("canonicalizeBodySignature — stubborn-writer credit-burn defense", () => {
  it("a stubborn writer that only adds whitespace between attempts trips the fixed point on attempt 2", () => {
    // Simulate the writer producing "the same body with a trailing space every
    // time". Under the old raw-hash detector each body hashed differently and
    // the loop ran unbounded; under the canonicalizer they collapse to ONE
    // signature and the loop halts after two attempts.
    const attempt1 = makeApplyBody(`    vfs.write("docs/x.md", "hello");`);
    // attempt2 adds trailing whitespace only.
    const attempt2 = `${attempt1}   `;
    // attempt3 adds a trailing comment.
    const attempt3 = `${attempt2}\n\n// oh look a comment`;
    const sig1 = canonicalizeBodySignature(attempt1);
    const sig2 = canonicalizeBodySignature(attempt2);
    const sig3 = canonicalizeBodySignature(attempt3);
    expect(sig1).toBe(sig2);
    expect(sig2).toBe(sig3);
  });

  it("a writer making REAL progress (different op arguments) does NOT trip the fixed point", () => {
    // Every attempt changes the actual arguments — the canonicalizer must NOT
    // collapse them (that would false-positive the fixed point + halt a
    // legitimately progressing writer).
    const attempt1 = makeApplyBody(`    vfs.write("docs/v1.md", "one");`);
    const attempt2 = makeApplyBody(`    vfs.write("docs/v2.md", "two");`);
    const attempt3 = makeApplyBody(`    vfs.write("docs/v3.md", "three");`);
    const sig1 = canonicalizeBodySignature(attempt1);
    const sig2 = canonicalizeBodySignature(attempt2);
    const sig3 = canonicalizeBodySignature(attempt3);
    expect(sig1).not.toBe(sig2);
    expect(sig2).not.toBe(sig3);
    expect(sig1).not.toBe(sig3);
  });
});
