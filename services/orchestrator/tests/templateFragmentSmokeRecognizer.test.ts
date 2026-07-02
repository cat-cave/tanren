// SMOKE-RECOGNIZER TESTS (apex v72 fix — task #144).
//
// The composer's `assertRuntimeAddedFunctionalTest` (compose.ts:439) rejects a
// composition unless SOME fragment shipped a test file with a meaningful
// assertion — the load-bearing behavioral constraint. Before this PR the
// recognizer only understood TypeScript/JavaScript (`tests/*.test.ts` with
// `expect(...).toXxx`) and Ruby (`spec/*_spec.rb` with `expect(...).to`) —
// apex v72's Go/Fly/SQLite pick halted at just-in-time template creation
// because the LLM-authored runtime-go fragment shipped a plausible `*_test.go`
// with `t.Errorf`, but the recognizer only knew TS/Ruby forms and rejected it
// twice, then halted at the fixed point. The recognizer was pinned to TS/Ruby
// by construction — no autonomous project could start on Go, Python, or Rust.
//
// This suite exercises the extended recognizer through the SAME live path
// (composeTemplate) that runs inside the smoke composition — a runtime fragment
// that writes ONLY a Go/Python/Rust test with a valid assertion must compose;
// a fragment whose test contains ONLY `t.Log(...)` or ONLY file-presence checks
// must be rejected. Skeleton BASE_SKELETON_TEST_PATHS is still rejected.
//
// The paired fail-fast: `authorOneFragment` rejects a runtime whose label maps
// to no supported language (`unsupported_runtime_language`) BEFORE the first
// LLM call — the writer-rework loop would otherwise burn attempts to a
// fixed point on the same "no meaningful test" rejection. Tested via
// `deriveRuntimeLanguage`.

import { describe, expect, it } from "vitest";
import {
  composeTemplate,
  deriveRuntimeLanguage,
  type Fragment,
  loadFragmentLibrary,
  RUNTIME_NODE_PNPM_ID,
  type TemplateConfig,
} from "../src/engine/templates/index.js";

// ── Test scaffolding ────────────────────────────────────────────────────────
//
// Build a node-pnpm-labeled runtime fragment (so we ride the existing bundled
// library's phase wiring) whose apply() writes the base files needed to satisfy
// the composer's post-process invariants (package.json, stryker.conf.mjs, all
// justfile hooks including `mutation`) PLUS one caller-provided test file at
// caller-provided path. The recognizer under test is content- + path-shape-
// based and does not care that the surrounding runtime "identity" is node-pnpm.

interface TestFile {
  path: string;
  content: string;
}

function buildRuntimeWith(files: readonly TestFile[]): Fragment {
  return {
    id: RUNTIME_NODE_PNPM_ID,
    version: "0.0.0-recognizer-test",
    kind: "runtime",
    contract: { testRunner: "vitest", reportPath: "reports/junit.xml" },
    async apply(vfs) {
      // Structural surface the composer's post-process invariants require.
      vfs.write("package.json", `{\n  "name": "smoke-recognizer"\n}\n`);
      vfs.write("src/demo.ts", "export {};\n");
      // Stryker config with `mutate: [` to satisfy the runtime-mutation-config
      // dogfood check (only exercised when the fragment is registered in the
      // full library; kept here for completeness).
      vfs.write("stryker.conf.mjs", 'export default { mutate: ["src/**"] };\n');
      // Every base justfile target must be filled — an unfilled target throws
      // an unknown-target error only when a fragment fills an unrecognized one,
      // but processCiYml + assertRuntimeAddedFunctionalTest also require these
      // hooks be populated for a well-formed composition.
      vfs.appendToJustfileTarget("bootstrap", ["echo bootstrap"]);
      vfs.appendToJustfileTarget("tier-1", ["echo tier1"]);
      vfs.appendToJustfileTarget("tier-2", ["echo tier2"]);
      vfs.appendToJustfileTarget("tier-3", ["echo tier3"]);
      vfs.appendToJustfileTarget("build", ["echo build"]);
      vfs.appendToJustfileTarget("mutation", ["pnpm stryker run"]);
      // The caller-provided test files under exercise.
      for (const file of files) {
        vfs.write(file.path, file.content);
      }
    },
  };
}

async function composeWith(files: readonly TestFile[]): Promise<void> {
  const library = loadFragmentLibrary();
  library.replaceForTests(buildRuntimeWith(files));
  await composeTemplate(
    {
      slug: "smoke-recognizer",
      runtime: "node-pnpm",
      deploy: "none",
      addons: [],
      examples: [],
    } as TemplateConfig,
    library,
  );
}

// ── Accepting recognized test-file forms ────────────────────────────────────

describe("smoke-recognizer — accepted forms (apex v72 fix)", () => {
  it("accepts a TypeScript `tests/*.test.ts` with a meaningful matcher (regression guard)", async () => {
    const ts = [
      "import { it, expect } from 'vitest';",
      "it('adds', () => {",
      "  expect(1 + 1).toBe(2);",
      "});",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "tests/adder.test.ts", content: ts }])).resolves.toBeUndefined();
  });

  it("accepts a Ruby `spec/*_spec.rb` with `expect(...).to eq` (regression guard)", async () => {
    const rb = [
      "require 'rspec'",
      "RSpec.describe 'adder' do",
      "  it 'adds' do",
      "    expect(1 + 1).to eq(2)",
      "  end",
      "end",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "spec/adder_spec.rb", content: rb }])).resolves.toBeUndefined();
  });

  it("accepts a Go `pkg/foo_test.go` with `t.Errorf`", async () => {
    const go = [
      "package foo",
      "",
      'import "testing"',
      "",
      "func TestAdder(t *testing.T) {",
      "  got := 1 + 1",
      "  if got != 2 {",
      '    t.Errorf("expected 2 got %d", got)',
      "  }",
      "}",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "pkg/foo_test.go", content: go }])).resolves.toBeUndefined();
  });

  it("accepts a Go `pkg/foo_test.go` with `if got != want { t.Fatalf(...) }`", async () => {
    const go = [
      "package foo",
      "",
      'import "testing"',
      "",
      "func TestDouble(t *testing.T) {",
      "  got := double(3)",
      "  want := 6",
      "  if got != want {",
      '    t.Fatalf("double(3) = %d, want %d", got, want)',
      "  }",
      "}",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "pkg/foo_test.go", content: go }])).resolves.toBeUndefined();
  });

  it("accepts a Go `pkg/foo_test.go` with testify `assert.Equal(t, ...)`", async () => {
    const go = [
      "package foo",
      "",
      "import (",
      '  "testing"',
      '  "github.com/stretchr/testify/assert"',
      ")",
      "",
      "func TestAdder(t *testing.T) {",
      "  assert.Equal(t, 2, 1+1)",
      "}",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "pkg/foo_test.go", content: go }])).resolves.toBeUndefined();
  });

  it("accepts a co-located Go test at the crate root (`main_test.go`)", async () => {
    const go = [
      "package main",
      "",
      'import "testing"',
      "",
      "func TestMainFlow(t *testing.T) {",
      '  if got := greet("world"); got != "hello world" {',
      '    t.Errorf("greet returned %q", got)',
      "  }",
      "}",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "main_test.go", content: go }])).resolves.toBeUndefined();
  });

  it("accepts a Python `tests/test_foo.py` with bare `assert x == 42`", async () => {
    const py = ["def test_adder():", "    assert 1 + 1 == 2", ""].join("\n");
    await expect(composeWith([{ path: "tests/test_foo.py", content: py }])).resolves.toBeUndefined();
  });

  it("accepts a Python `tests/test_foo.py` with `self.assertEqual(...)` (unittest)", async () => {
    const py = [
      "import unittest",
      "",
      "class AdderTest(unittest.TestCase):",
      "    def test_adder(self):",
      "        self.assertEqual(1 + 1, 2)",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "tests/test_foo.py", content: py }])).resolves.toBeUndefined();
  });

  it("accepts a Python `pkg/foo_test.py` (pytest alt-naming, co-located)", async () => {
    const py = ["def test_double():", "    assert double(3) == 6", ""].join("\n");
    await expect(composeWith([{ path: "pkg/foo_test.py", content: py }])).resolves.toBeUndefined();
  });

  it("accepts a Rust `tests/foo.rs` with `assert_eq!`", async () => {
    const rs = ["#[test]", "fn test_adder() {", "    assert_eq!(1 + 1, 2);", "}", ""].join("\n");
    await expect(composeWith([{ path: "tests/foo.rs", content: rs }])).resolves.toBeUndefined();
  });
});

// ── Rejecting non-assertion / skeleton-shaped content ───────────────────────

describe("smoke-recognizer — rejected forms (apex v72 fix)", () => {
  it("rejects a Go test file that ONLY calls `t.Log(...)` (no meaningful assertion)", async () => {
    const go = [
      "package foo",
      "",
      'import "testing"',
      "",
      "func TestLogsOnly(t *testing.T) {",
      '  t.Log("something happened")',
      '  t.Logf("but %s", "no assertion")',
      "}",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "pkg/foo_test.go", content: go }])).rejects.toThrow(
      /no runtime added a meaningful functional test or BDD scenario/u,
    );
  });

  it("rejects a Go test file that only checks file presence (no t.Errorf / t.Fatal / testify)", async () => {
    // A Go test that stat's a file but only `t.Log`s the result — file-presence
    // check with NO meaningful assertion pattern. The recognizer requires one
    // of `t.Errorf`/`t.Fatal`/testify `assert.*` — this file has none.
    const go = [
      "package foo",
      "",
      "import (",
      '  "os"',
      '  "testing"',
      ")",
      "",
      "func TestFilePresence(t *testing.T) {",
      '  _, err := os.Stat("foo.go")',
      '  t.Logf("stat err: %v", err)',
      "}",
      "",
    ].join("\n");
    await expect(composeWith([{ path: "pkg/foo_test.go", content: go }])).rejects.toThrow(
      /no runtime added a meaningful functional test or BDD scenario/u,
    );
  });

  it("rejects the BASE_SKELETON_TEST_PATHS default (mutation-baseline + functional-demo only)", async () => {
    // The base fragment ships tests/mutation-baseline.test.ts +
    // tests/functional-demo.test.ts unconditionally; both are in
    // BASE_SKELETON_TEST_PATHS and are EXCLUDED from the recognizer count. A
    // runtime that adds NO further test file must be rejected.
    await expect(composeWith([])).rejects.toThrow(/no runtime added a meaningful functional test or BDD scenario/u);
  });

  it("rejects a Python test file with `def test_` but no assertion", async () => {
    const py = ["def test_something():", "    x = 1 + 1", "    print(x)", ""].join("\n");
    await expect(composeWith([{ path: "tests/test_foo.py", content: py }])).rejects.toThrow(
      /no runtime added a meaningful functional test or BDD scenario/u,
    );
  });

  it("rejects a Rust file with `#[test]` but no `assert!` macro", async () => {
    const rs = ["#[test]", "fn test_something() {", "    let x = 1 + 1;", '    println!("x = {}", x);', "}", ""].join(
      "\n",
    );
    await expect(composeWith([{ path: "tests/foo.rs", content: rs }])).rejects.toThrow(
      /no runtime added a meaningful functional test or BDD scenario/u,
    );
  });
});

// ── The paired fail-fast: unsupported_runtime_language ──────────────────────

describe("deriveRuntimeLanguage — the paired fail-fast (apex v72 fix)", () => {
  it("maps `node-pnpm`, `typescript`, `ts`, `js` → ts", () => {
    expect(deriveRuntimeLanguage("node-pnpm")).toBe("ts");
    expect(deriveRuntimeLanguage("typescript")).toBe("ts");
    expect(deriveRuntimeLanguage("ts")).toBe("ts");
    expect(deriveRuntimeLanguage("js")).toBe("ts");
    expect(deriveRuntimeLanguage("node")).toBe("ts");
  });

  it("maps `ruby-bundler`, `rails`, `bundler` → ruby", () => {
    expect(deriveRuntimeLanguage("ruby-bundler")).toBe("ruby");
    expect(deriveRuntimeLanguage("rails")).toBe("ruby");
    expect(deriveRuntimeLanguage("bundler")).toBe("ruby");
  });

  it("maps `go`, `golang`, `go-modules` → go", () => {
    expect(deriveRuntimeLanguage("go")).toBe("go");
    expect(deriveRuntimeLanguage("golang")).toBe("go");
    expect(deriveRuntimeLanguage("go-modules")).toBe("go");
  });

  it("maps `python`, `python-uv`, `py`, `poetry`, `uv` → python", () => {
    expect(deriveRuntimeLanguage("python")).toBe("python");
    expect(deriveRuntimeLanguage("python-uv")).toBe("python");
    expect(deriveRuntimeLanguage("py")).toBe("python");
    expect(deriveRuntimeLanguage("poetry")).toBe("python");
  });

  it("maps `rust`, `rust-cargo`, `cargo` → rust", () => {
    expect(deriveRuntimeLanguage("rust")).toBe("rust");
    expect(deriveRuntimeLanguage("rust-cargo")).toBe("rust");
    expect(deriveRuntimeLanguage("cargo")).toBe("rust");
  });

  it("returns null for an unrecognized label (the fail-fast trigger)", () => {
    expect(deriveRuntimeLanguage("russian-fanfiction")).toBeNull();
    expect(deriveRuntimeLanguage("kotlin")).toBeNull();
    expect(deriveRuntimeLanguage("haskell")).toBeNull();
    expect(deriveRuntimeLanguage("")).toBeNull();
  });
});
