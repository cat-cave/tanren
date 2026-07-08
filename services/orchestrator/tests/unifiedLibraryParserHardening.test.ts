// Parser-hardening regression pins for the F2 fragment body parser
// (`unifiedLibrary.ts:parseFragmentBody`). Two apex-frontier bugs the historical
// implementation carried:
//
//   Bug 1 (Claude HIGH #1) — the applyMatch regex was non-greedy:
//     /apply\s*\([^)]*\)[^{]*\{([\s\S]*?)\}.../u
//   The lazy `([\s\S]*?)\}` captured up to the FIRST `}` in the body regardless
//   of string-literal / template-literal / comment nesting. Any inline template
//   literal containing `}` — JSON, tsconfig.json, package.json, JSX object
//   expressions — silently truncated the body BEFORE the constrained-subset
//   state machine ran. Result: fragment `apply()` became a no-op, "passed"
//   composition smoke, and shipped.
//
//   Bug 2 (Codex #6) — the state-machine parser scanned for `vfs.` calls and
//   IGNORED everything else. Non-vfs code in apply() — conditionals, loops,
//   `fs.writeFileSync`, `process.env`, `Math.random()`, arrow-fn assignments —
//   was silently dropped rather than rejected. The persisted TS source then
//   had code the interpreter did not run: a prompt-injection surface on a
//   hostile writer + a confusing bug on an honest writer.
//
// These tests pin BOTH fixes: balanced-brace body extraction that respects
// strings/templates/comments, plus explicit rejection of non-vfs statements
// with a writer-facing message that names the offending prefix.

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

// ── Bug 1: balanced-brace body extraction ──────────────────────────────────

describe("parseFragmentBody — balanced-brace body extraction (Bug 1: Claude HIGH #1)", () => {
  it("extracts ALL ops when the body contains a template literal with a JSON-like `}`", () => {
    // The historical non-greedy regex would stop at the first `}` inside the
    // template — the tsconfig closer — so only the first vfs.write (or none)
    // would be picked up and the remaining ops silently vanished.
    const body = bodyWith(
      [
        '    vfs.write("tsconfig.json", `{"compilerOptions":{"target":"ES2022"}}`);',
        '    vfs.write("src/demo.ts", "export const x = 1;\\n");',
        '    vfs.addPackageJsonDevDep("vitest", "^4.0.0");',
      ].join("\n"),
    );
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toMatchObject({ kind: "write", path: "tsconfig.json" });
    expect(ops[1]).toMatchObject({ kind: "write", path: "src/demo.ts" });
    expect(ops[2]).toMatchObject({ kind: "devDep", name: "vitest", version: "^4.0.0" });
  });

  it("extracts all ops when a template literal carries a nested `${...}` interpolation", () => {
    // `${...}` opens a fresh code region inside a backtick — its own `{` / `}`
    // must NOT confuse the outer body-brace walker. The walker's stack tracks
    // an independent brace depth per template-expr frame.
    const body = bodyWith(
      [
        // A template literal that interpolates another expression containing braces.
        '    vfs.write(`config.json`, `{"key":"value"}`);',
        '    vfs.write("src/second.ts", "export const y = 2;\\n");',
      ].join("\n"),
    );
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ kind: "write", path: "src/second.ts" });
  });

  it("extracts all ops when a `// line comment` contains a brace", () => {
    // The extractor treats `//` comments as opaque — a `}` inside a line
    // comment must NOT end the body.
    const body = bodyWith(
      [
        "    // this comment has a { brace } inside it",
        '    vfs.write("docs/a.md", "content");',
        '    vfs.write("docs/b.md", "content");',
      ].join("\n"),
    );
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ kind: "write", path: "docs/a.md" });
    expect(ops[1]).toMatchObject({ kind: "write", path: "docs/b.md" });
  });

  it("extracts all ops when a `/* block comment */` contains a brace", () => {
    const body = bodyWith(
      [
        "    /* block comment with a { brace } inside — do not truncate here */",
        '    vfs.write("docs/x.md", "hello");',
        '    vfs.addPackageJsonDep("react", "^19.0.0");',
      ].join("\n"),
    );
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ kind: "write", path: "docs/x.md" });
    expect(ops[1]).toMatchObject({ kind: "dep", name: "react", version: "^19.0.0" });
  });

  it("extracts all ops when a string literal contains an escaped quote followed by `}`", () => {
    // `\"` inside a double-quoted string must NOT terminate the string, so a
    // trailing `}` past the escape stays inside the string and does not close
    // the body.
    const body = bodyWith(
      [
        // Escaped quote in a stringified JSON object literal.
        '    vfs.write("data.json", "{\\"nested\\":\\"value with } brace\\"}");',
        '    vfs.write("docs/y.md", "hello");',
      ].join("\n"),
    );
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(2);
    expect(ops[1]).toMatchObject({ kind: "write", path: "docs/y.md" });
  });

  it("throws FragmentBodyParseError with a clear message when braces are genuinely unbalanced", () => {
    // A malformed body that never closes the apply block — the walker must
    // reach EOF and throw, rather than silently truncating.
    const malformed = [
      `import { type Fragment, type VirtualFileSystem, type TemplateConfig } from "../types.js";`,
      `export const fragment: Fragment = {`,
      `  id: "addon-x", version: "1.0.0", kind: "addon", contract: {},`,
      `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
      `    vfs.write("docs/x.md", "hello");`,
      // Intentionally omit the closing brace of the apply body AND the object.
    ].join("\n");
    let err: unknown;
    try {
      parseFragmentBody(malformed);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toContain("unbalanced braces");
  });
});

// ── Bug 2: reject non-vfs statements in apply() body ────────────────────────

describe("parseFragmentBody — reject non-vfs statements (Bug 2: Codex #6)", () => {
  it("rejects an `if (...) { vfs.write(...); }` guard around a vfs call", () => {
    // The historical parser interpreted the guarded op UNCONDITIONALLY (it
    // scanned for `vfs.` inside the guard body and picked it up). The persisted
    // source had a conditional the interpreter did not respect. Reject.
    const body = bodyWith(`    if (_config.foo) { vfs.write("a", "b"); }`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/non-vfs statement/u);
    expect((err as FragmentBodyParseError).message).toContain("if");
  });

  it("rejects a bare `fs.writeFileSync(...)` call", () => {
    const body = bodyWith(`    fs.writeFileSync("/tmp/x", "y");`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/non-vfs statement/u);
    expect((err as FragmentBodyParseError).message).toContain("fs.writeFileSync");
  });

  it("rejects a `for` loop even when the loop body contains a valid vfs call", () => {
    const body = bodyWith(`    for (const k of ["a","b"]) vfs.write(k, "content");`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/non-vfs statement/u);
  });

  it("rejects an inline arrow function assignment", () => {
    const body = bodyWith(`    const helper = () => vfs.write("x", "y"); helper();`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/non-vfs statement/u);
  });

  it("rejects an `await` prefix on a vfs call (the parser is call-shape-strict)", () => {
    const body = bodyWith(`    await vfs.write("a", "b");`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/non-vfs statement/u);
  });

  it("rejects `vfs.write.bind(...)` — the parser demands a direct `vfs.<method>(...)` call shape", () => {
    const body = bodyWith(`    vfs.write.bind(vfs)("x", "y");`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/non-vfs statement/u);
  });

  it("rejects `console.log(...)` between vfs calls (silently dropped historically)", () => {
    const body = bodyWith(
      [
        '    vfs.write("docs/x.md", "hello");',
        '    console.log("debug");',
        '    vfs.write("docs/y.md", "hello");',
      ].join("\n"),
    );
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/non-vfs statement/u);
    expect((err as FragmentBodyParseError).message).toContain("console.log");
  });

  it("ACCEPTS a body of only vfs.* calls, blank lines, and comments (positive control)", () => {
    const body = bodyWith(
      [
        "    // a leading line comment",
        "",
        '    vfs.write("docs/a.md", "content-a");',
        "    /* a block comment between calls */",
        "",
        '    vfs.write("docs/b.md", "content-b");',
        "    // a trailing comment",
      ].join("\n"),
    );
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ kind: "write", path: "docs/a.md" });
    expect(ops[1]).toMatchObject({ kind: "write", path: "docs/b.md" });
  });

  it("ACCEPTS a body with the full constrained-subset op vocabulary (positive control)", () => {
    // Every op the writer may declare — proves the assertion pass does not
    // false-positive on any of the accepted shapes.
    const body = bodyWith(
      [
        '    vfs.write("docs/x.md", "content");',
        '    vfs.overwrite("package.json", "{}");',
        '    vfs.addPackageJsonDep("react", "^19.0.0");',
        '    vfs.addPackageJsonDevDep("vitest", "^4.0.0");',
        '    vfs.addEnvVar("DATABASE_URL", "postgres://x");',
        '    vfs.appendToJustfileTarget("bootstrap", ["pnpm install"]);',
      ].join("\n"),
    );
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(6);
    expect(ops.map((o) => o.kind)).toEqual(["write", "overwrite", "dep", "devDep", "env", "just"]);
  });
});

// ── Bug 3 (Claude H5): parseStringLiteral single-pass unescape order ────────

function firstWriteOp(applyBody: string): { path: string; content: string } {
  const body = bodyWith(applyBody);
  const ops = parseFragmentBody(body);
  const first = ops[0];
  if (first === undefined || first.kind !== "write") {
    throw new Error(`expected first op to be a write, got ${JSON.stringify(first)}`);
  }
  return { path: first.path, content: first.content };
}

function bytesOf(s: string): string {
  return Array.from(s)
    .map((c) => (c.codePointAt(0) ?? 0).toString(16).padStart(2, "0"))
    .join(" ");
}

describe("parseFragmentBody — string-literal escape decoding (Bug 3: Claude H5)", () => {
  // The historical multi-pass `.replaceAll` chain ran `\\n → newline` BEFORE
  // `\\\\ → \\`. Any string source that carried `\\n` (an escaped backslash
  // followed by `n` — 3 bytes: 5c 5c 6e) was silently corrupted to `\<newline>`
  // (2 bytes: 5c 0a). These pins prove the single-pass decoder consumes ONE
  // escape at a time so the order-dependence is gone.

  it("decodes `\\n` as a newline (1 char, 0x0a)", () => {
    const { content } = firstWriteOp('    vfs.write("a", "hello\\nworld");');
    expect(content).toBe("hello\nworld");
    expect(content).toHaveLength(11);
  });

  it("decodes `\\\\n` as backslash + letter n (2 chars, 5c 6e — NOT a newline)", () => {
    // This is the H5 regression case. Under the buggy multi-pass chain the
    // output was `\<newline>` (2 chars, 5c 0a). Under single-pass the `\\`
    // consumes both backslashes into ONE literal `\`, leaving the trailing `n`
    // as a plain character.
    const { content } = firstWriteOp('    vfs.write("a", "\\\\n");');
    expect(content).toBe("\\n");
    expect(content).toHaveLength(2);
    expect(bytesOf(content)).toBe("5c 6e");
  });

  it("decodes `\\\\` as a single backslash (1 char, 5c)", () => {
    const { content } = firstWriteOp('    vfs.write("a", "\\\\");');
    expect(content).toBe("\\");
    expect(content).toHaveLength(1);
    expect(bytesOf(content)).toBe("5c");
  });

  it("decodes `a\\\\nb` as `a`, `\\`, `n`, `b` — 4 chars, escape NOT consuming the letter n", () => {
    const { content } = firstWriteOp('    vfs.write("a", "a\\\\nb");');
    expect(content).toBe("a\\nb");
    expect(content).toHaveLength(4);
    expect(bytesOf(content)).toBe("61 5c 6e 62");
  });

  it("decodes `a\\nb` as a, newline, b — 3 chars (positive control)", () => {
    const { content } = firstWriteOp('    vfs.write("a", "a\\nb");');
    expect(content).toBe("a\nb");
    expect(content).toHaveLength(3);
    expect(bytesOf(content)).toBe("61 0a 62");
  });

  it("decodes `\\\\\\n` (3 backslashes + n) as backslash + newline — 2 chars, 5c 0a (nested escapes)", () => {
    // Left-to-right consumption of the 4-byte captured group `\\\n` (5c 5c 5c 6e):
    //   pos 0: `\\` → write `\` (5c), advance 2
    //   pos 2: `\n` → write newline (0a), advance 2
    // Result: backslash + newline (2 bytes, 5c 0a). This proves left-to-right
    // consumption is order-INDEPENDENT — the second escape's `\n` is only seen
    // AFTER the first `\\` collapsed the leading pair.
    const { content } = firstWriteOp('    vfs.write("a", "\\\\\\n");');
    expect(content).toBe("\\\n");
    expect(content).toHaveLength(2);
    expect(bytesOf(content)).toBe("5c 0a");
  });

  it("decodes `\\t` as a tab and `\\r` as a carriage return (extended vocabulary)", () => {
    const { content } = firstWriteOp('    vfs.write("a", "col1\\tcol2\\r\\n");');
    expect(content).toBe("col1\tcol2\r\n");
  });

  it('decodes `\\"` as a double-quote inside a double-quoted string', () => {
    const { content } = firstWriteOp('    vfs.write("a", "she said \\"hi\\"");');
    expect(content).toBe('she said "hi"');
  });

  it("decodes `\\`` as a backtick inside a backtick string", () => {
    const { content } = firstWriteOp("    vfs.write(`a`, `code: \\`x\\``);");
    expect(content).toBe("code: `x`");
  });

  it("preserves an unknown escape `\\0` as backslash + `0` (backward-compat with the old chain)", () => {
    // The old multi-pass chain did NOT decode \0 / \x / \u, so anything a
    // fragment carried past those code points round-tripped. The new decoder
    // preserves them the same way rather than silently dropping the backslash.
    const { content } = firstWriteOp('    vfs.write("a", "null:\\0end");');
    expect(content).toBe("null:\\0end");
  });

  it("REGRESSION PIN: the existing escaped-JSON exemplar still decodes correctly", () => {
    // The Bug-1 test above pushes a JSON-in-double-quotes string with `\"`
    // through the parser. Prove the H5 fix does not alter that decode path.
    const body = bodyWith('    vfs.write("data.json", "{\\"nested\\":\\"value\\"}");');
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "write",
      path: "data.json",
      content: '{"nested":"value"}',
    });
  });
});

// ── Bug 4 (Claude M5): splitArgs single-quote tracking ─────────────────────

describe("parseFragmentBody — single-quoted args (Bug 4: Claude M5)", () => {
  it("rejects a single-quoted arg with an actionable 'use double quotes' message (NOT an arg-count error)", () => {
    // Historical: splitArgs did not track `'…'`. A call like
    //   vfs.write('a,b', 'c')
    // fanned out into 3 args because the comma inside `'a,b'` was treated as a
    // top-level split point. The writer then saw THREE cryptic "expected a
    // string literal" errors — one per arg — instead of ONE clear "use double
    // quotes or backticks" message. With single-quote tracking the arg list
    // splits into 2, each rejected individually with the single-quote-specific
    // message.
    const body = bodyWith(`    vfs.write('a,b', 'c');`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    const msg = (err as FragmentBodyParseError).message;
    expect(msg).toMatch(/single-quoted strings are not accepted/u);
    expect(msg).toMatch(/double quotes|backticks/u);
    // Must NOT surface as an arg-count error (which would happen if the comma
    // inside `'a,b'` fanned the call out into 3 args).
    expect(msg).not.toMatch(/expects 2 args, got 3/u);
  });

  it("keeps a single-quoted arg with an embedded comma OPAQUE — no split on the inner comma", () => {
    // Even though the args are single-quoted (and thus rejected), the arg
    // count should be 2, not 3. The rejection wins on string-type, not on
    // arg-count.
    const body = bodyWith(`    vfs.addPackageJsonDep('name,with,commas', 'version');`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    const msg = (err as FragmentBodyParseError).message;
    expect(msg).toMatch(/single-quoted strings are not accepted/u);
    expect(msg).not.toMatch(/expects 2 args, got \d/u);
  });

  it("rejects a mixed double-quoted + single-quoted call with the single-quote message on the offending arg", () => {
    const body = bodyWith(`    vfs.write("docs/x.md", 'content');`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/single-quoted strings are not accepted/u);
  });

  it("keeps a single-quoted element inside an array-arg opaque (array split does not fan on inner commas)", () => {
    // Prove the fix also flows through parseArrayOfStrings — the shared splitter
    // treats `'a,b'` as opaque so the array is 1 element, not 2.
    const body = bodyWith(`    vfs.appendToJustfileTarget("bootstrap", ['a,b']);`);
    let err: unknown;
    try {
      parseFragmentBody(body);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FragmentBodyParseError);
    expect((err as FragmentBodyParseError).message).toMatch(/single-quoted strings are not accepted/u);
  });

  it("still accepts a body that mixes double quotes + backticks (positive control)", () => {
    const body = bodyWith(
      ['    vfs.write("docs/x.md", `multi', "line", "content`);", '    vfs.write("docs/y.md", "single-line");'].join(
        "\n",
      ),
    );
    const ops = parseFragmentBody(body);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ kind: "write", path: "docs/x.md" });
    expect(ops[0]!.kind === "write" && ops[0].content).toBe("multi\nline\ncontent");
  });
});
