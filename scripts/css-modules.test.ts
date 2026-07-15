import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SHELL_MODULE_DIR, SHELL_MODULES } from "../services/dashboard/src/design/shell-manifest.mjs";

/**
 * CSS split regression for both design surfaces (the dashboard shell and the
 * hi-fi prototype). Both were split from oversized single files into ordered
 * modules so the 500-line source cap holds. This test does NOT store the
 * original on disk — it pins the pre-split SHA-256 byte digest, byte count,
 * line count, and top-level rule count, reconstructs the content from the
 * current modules, and compares. A loss, duplication, reorder, or any byte
 * change in a module fails at least one pin.
 *
 * Ordering authorities (one source of truth per surface — no duplicated lists):
 *   • dashboard shell — `src/design/shell-manifest.mjs`, the SAME module the
 *     build (`services/dashboard/scripts/build-client.mjs`) imports. The build
 *     and the test cannot drift because neither hardcodes the stem list.
 *   • hi-fi body — the `styles.css` entry itself. Its `./styles/<stem>.css`
 *     `@import` lines are parsed in order, so the entry IS the authority.
 */

const LINE_MAX = 500;

type SurfacePin = {
  sha256: string;
  bytes: number;
  lines: number;
  rules: number;
};

// Dashboard shell — pinned pre-split reconstruction of the six modules listed in
// shell-manifest.mjs (base, topbar, sidenav, main, palette, theme). The dir +
// stem list come from the manifest; the pins live here.
const SHELL: SurfacePin = {
  sha256: "d17ea53ec187a0f04660a077dd701444352aee7dca936596383dc8347f470c1d",
  bytes: 17159,
  lines: 846,
  rules: 120,
};

// Hi-fi body — pinned pre-split reconstruction of the five content modules
// imported by styles.css. Excludes the entry banner and tokens.css (a separate
// token file the entry pulls in as-is).
const STYLES: SurfacePin = {
  sha256: "c436bd432c82718254da8aa67ecba7e4e4b68a852a55b89cc39e051fb0167763",
  bytes: 87116,
  lines: 1894,
  rules: 705,
};

const STYLES_ENTRY_PATH = "tanren-hi-fidelity/project/styles.css";
const STYLES_MODULE_DIR = "tanren-hi-fidelity/project/styles";

// The verbatim styles.css entry: the original two-line banner, the unchanged
// tokens import, then exactly the five ordered content-module imports and no
// extra content/imports. Asserted byte-for-byte below so the authority itself
// cannot silently drift.
const EXPECTED_STYLES_ENTRY =
  "/* Tanren Hi-fi \u00B7 custom layer on top of design system tokens.\n" +
  '   Two surfaces: data-theme="dark" (ink) and data-theme="light" (ash). */\n' +
  '@import url("./tokens.css");\n' +
  '@import url("./styles/shell-primitives.css");\n' +
  '@import url("./styles/runs-review.css");\n' +
  '@import url("./styles/forge-form.css");\n' +
  '@import url("./styles/settings-costs.css");\n' +
  '@import url("./styles/spec-audits.css");\n';

const EXPECTED_STYLES_STEMS = ["shell-primitives", "runs-review", "forge-form", "settings-costs", "spec-audits"];

function countLines(text: string): number {
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

/**
 * Comment-aware brace-depth counter for top-level CSS blocks. Counts blocks
 * opened by a `{` at depth 0 — rules, at-rules, @media, @keyframes, etc.
 * Closings inside @media/@keyframes are at depth ≥ 1 and are NOT counted.
 * Comments and strings are skipped so braces inside them cannot perturb the
 * count. This replaces the prior fake counter that only counted lines which were
 * exactly `}`, which mis-counted single-line rules, nested closings, and
 * commented-out braces (see the hostile fixtures below).
 */
function countTopLevelRules(text: string): number {
  let depth = 0;
  let rules = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "{") {
      if (depth === 0) rules++;
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      depth--;
      i++;
      continue;
    }
    i++;
  }
  return rules;
}

// The prior fake counter — kept ONLY to prove the hostile fixtures below
// actually break it (and thus exercise the new counter). A line that is exactly
// `}` is treated as a top-level close; everything else is ignored.
function countTopLevelRulesFake(text: string): number {
  return text.split("\n").filter((line) => line === "}").length;
}

async function readModule(dir: string, stem: string): Promise<string> {
  return readFile(resolve(dir, `${stem}.css`), "utf8");
}

async function reconstruct(dir: string, stems: string[]): Promise<string> {
  const parts: string[] = [];
  for (const stem of stems) parts.push(await readModule(dir, stem));
  return parts.join("");
}

function cssStems(entries: string[]): string[] {
  return entries
    .filter((name) => name.endsWith(".css"))
    .map((name) => name.slice(0, -4))
    .toSorted();
}

describe("top-level CSS rule counter (comment-aware brace depth)", () => {
  it("counts a single-line rule (the fake counter counts zero)", () => {
    const css = ".a { color: red; }\n";
    expect(countTopLevelRules(css)).toBe(1);
    expect(countTopLevelRulesFake(css)).toBe(0);
  });

  it("counts each top-level rule even when they share lines or are nested", () => {
    const css = [
      ".a { color: red; }",
      ".b { color: blue; }",
      "@media (min-width: 1px) {",
      "  .c { color: green; }",
      "  .d {",
      "    color: yellow;",
      "  }",
      "}",
      "",
    ].join("\n");
    // Two top-level rules (.a, .b) + one top-level @media block = 3. The inner
    // .c/.d live at depth 1 and are NOT top-level.
    expect(countTopLevelRules(css)).toBe(3);
    // The fake counter counts only lines that are EXACTLY `}` (no indentation):
    // just the unindented @media close = 1. It misses the single-line .a/.b
    // entirely and cannot tell the @media is one block — that is why the prior
    // pin under-counted the hi-fi surface (213 vs the real 705).
    expect(countTopLevelRulesFake(css)).toBe(1);
  });

  it("ignores braces inside comments and strings", () => {
    const css = [
      "/* a commented rule with braces:",
      ".fake {",
      "  color: red;",
      "}",
      "*/",
      '.real { content: "}"; color: red; }',
      ".other { color: blue; }",
      "",
    ].join("\n");
    // Truth: .real + .other = 2 top-level rules. The commented block and the
    // `}` inside the string literal must not count.
    expect(countTopLevelRules(css)).toBe(2);
    // The fake counter counts the `}` line inside the comment as a close = 1
    // and misses both single-line real rules.
    expect(countTopLevelRulesFake(css)).toBe(1);
  });

  it("counts @keyframes as one top-level block regardless of inner stops", () => {
    const css = "@keyframes pulse {\n  0% { opacity: 1; }\n  50% { opacity: 0.5; }\n  100% { opacity: 1; }\n}\n";
    expect(countTopLevelRules(css)).toBe(1);
  });
});

describe("dashboard shell CSS split regression", () => {
  it("uses the same manifest the build uses (no duplicated stem list)", () => {
    expect(SHELL_MODULES).toEqual(["base", "topbar", "sidenav", "main", "palette", "theme"]);
    expect(SHELL_MODULE_DIR).toBe("services/dashboard/src/design/shell");
  });

  it("reconstructs the pre-split digest, byte, line, and rule counts", async () => {
    const text = await reconstruct(SHELL_MODULE_DIR, SHELL_MODULES);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(SHELL.sha256);
    expect(Buffer.byteLength(text, "utf8")).toBe(SHELL.bytes);
    expect(countLines(text)).toBe(SHELL.lines);
    expect(countTopLevelRules(text)).toBe(SHELL.rules);
  });

  it("keeps every module at or below 500 lines and the stems distinct", async () => {
    expect(new Set(SHELL_MODULES).size).toBe(SHELL_MODULES.length);
    for (const stem of SHELL_MODULES) {
      expect(countLines(await readModule(SHELL_MODULE_DIR, stem))).toBeLessThanOrEqual(LINE_MAX);
    }
  });

  it("contains exactly the six expected module stems — no ignored extras", async () => {
    expect(cssStems(await readdir(SHELL_MODULE_DIR))).toEqual([...SHELL_MODULES].toSorted());
  });
});

describe("hi-fi styles CSS split regression", () => {
  it("styles.css entry is verbatim: banner, tokens import, five ordered module imports", async () => {
    const entry = await readFile(resolve(STYLES_ENTRY_PATH), "utf8");
    expect(entry).toBe(EXPECTED_STYLES_ENTRY);
  });

  it("reconstructs the pre-split digest, byte, line, and rule counts", async () => {
    const text = await reconstruct(STYLES_MODULE_DIR, EXPECTED_STYLES_STEMS);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe(STYLES.sha256);
    expect(Buffer.byteLength(text, "utf8")).toBe(STYLES.bytes);
    expect(countLines(text)).toBe(STYLES.lines);
    expect(countTopLevelRules(text)).toBe(STYLES.rules);
  });

  it("keeps every module at or below 500 lines and the stems distinct", async () => {
    expect(new Set(EXPECTED_STYLES_STEMS).size).toBe(EXPECTED_STYLES_STEMS.length);
    for (const stem of EXPECTED_STYLES_STEMS) {
      expect(countLines(await readModule(STYLES_MODULE_DIR, stem))).toBeLessThanOrEqual(LINE_MAX);
    }
  });

  it("contains exactly the five expected module stems — no ignored extras", async () => {
    expect(cssStems(await readdir(STYLES_MODULE_DIR))).toEqual([...EXPECTED_STYLES_STEMS].toSorted());
  });
});
