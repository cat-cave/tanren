// DETERMINISTIC contract-file projection (v27 fix) — the contract files are
// MATERIALIZED from the captured lifecycle, never LLM-authored.
//
// The bug found live on apex v27: the LLM writer mangled the `.tanren/ci.yml` YAML
// shape. The fix: `materializeContractFiles(lifecycle)` produces the exact bytes of
// both contract files deterministically. These tests pin the KEY invariants:
//   1. the materialized `.tanren/ci.yml` === SKELETON_CI_CONFIG VERBATIM and
//      round-trips through the REAL `resolveCiConfig`;
//   2. the materialized justfile has all SIX conventional targets, each filled with
//      the EXACT captured lifecycle command;
//   3. no LLM, no hardcoded stack: a Rust / novel lifecycle fills cargo / pandoc
//      just the same, and the ci.yml is identical for every stack.

import { describe, expect, it } from "vitest";
import { resolveCiConfig } from "../src/engine/ci/index.js";
import type { ProjectLifecycle } from "../src/engine/config/index.js";
import {
  SKELETON_CI_CONFIG,
  SKELETON_CI_CONFIG_PATH,
  SKELETON_JUSTFILE_PATH,
  SKELETON_MISE_CONFIG_PATH,
  materializeContractFiles,
  renderLifecycleJustfile,
  renderMiseToml,
} from "../src/engine/forge/scaffold/index.js";

const TS_LIFECYCLE: ProjectLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  // The project's declared dependency-bump verb (environment-management.md §4.5).
  upgrade: "pnpm update --latest",
  // The project's declared toolchain — materialized into a mise.toml [tools] table.
  toolchain: [
    { name: "node", version: "24" },
    { name: "pnpm", version: "10" },
  ],
};

const RUST_LIFECYCLE: ProjectLifecycle = {
  stack: "rust/cargo",
  bootstrap: "cargo fetch",
  tier1: "cargo clippy --all-targets -- -D warnings",
  tier2: "cargo test",
  tier3: "cargo clippy --all-targets -- -D warnings && cargo test",
  build: "cargo build --release",
  deploy: "flyctl deploy",
  upgrade: "cargo update",
  toolchain: [{ name: "rust", version: "stable" }],
};

// A non-code lifecycle — the contract's generality proof. It declares NO mise
// toolchain (a pure-shell/system-package stack) — so NO mise.toml is materialized.
// It also declares NO `upgrade` verb (nothing to upgrade) — so that target STUBs.
const NOVEL_LIFECYCLE: ProjectLifecycle = {
  stack: "novel/pandoc",
  bootstrap: "pip install -r requirements.txt",
  tier1: "aspell check chapters/*.md",
  tier2: "python scripts/consistency-check.py",
  tier3: "aspell check chapters/*.md && python scripts/consistency-check.py",
  build: "pandoc chapters/*.md --to epub --output book.epub",
  deploy: "python scripts/publish.py",
  upgrade: "",
  toolchain: [],
};

// A multi-line command (newline-joined in the capture) — each line must become its
// own TAB-indented recipe step.
const MULTILINE_LIFECYCLE: ProjectLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "corepack enable\npnpm install --frozen-lockfile",
  tier1: "pnpm lint",
  tier2: "pnpm test",
  tier3: "pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
  upgrade: "pnpm update --latest",
  toolchain: [],
};

const TARGETS = ["bootstrap", "tier-1", "tier-2", "tier-3", "build", "deploy", "upgrade"] as const;

// The justfile's recipe BODIES — the TAB-indented command lines (a leading comment
// may list example stacks as guidance, which is not an executed command). Assertions
// that a cross-stack command does NOT leak check these, not the header comment.
function recipeBodies(justfile: string): string[] {
  return justfile.split("\n").filter((l) => l.startsWith("\t"));
}

describe("materializeContractFiles · the .tanren/ci.yml is SKELETON_CI_CONFIG verbatim", () => {
  it("for every stack the ci.yml === SKELETON_CI_CONFIG (identical, stack-agnostic)", () => {
    for (const lifecycle of [TS_LIFECYCLE, RUST_LIFECYCLE, NOVEL_LIFECYCLE]) {
      const ci = materializeContractFiles(lifecycle).find((f) => f.path === SKELETON_CI_CONFIG_PATH);
      expect(ci).toBeDefined();
      expect(ci?.content).toBe(SKELETON_CI_CONFIG);
    }
  });

  it("the materialized ci.yml round-trips through the REAL resolveCiConfig", () => {
    const ci = materializeContractFiles(RUST_LIFECYCLE).find((f) => f.path === SKELETON_CI_CONFIG_PATH);
    const config = resolveCiConfig(ci?.content ?? "");
    expect(config.version).toBe(1);
    expect(config.bootstrap?.run).toBe("just bootstrap");
    expect((config.tiers.fast ?? []).map((s) => s.run)).toEqual(["just tier-1"]);
    expect((config.tiers.slow ?? []).map((s) => s.run)).toEqual(["just tier-2"]);
    expect((config.tiers.merge ?? []).map((s) => s.run)).toEqual(["just tier-3"]);
    expect(config.when.fast).toEqual(["per_iteration"]);
    expect(config.when.slow).toEqual(["pre_audit"]);
    expect(config.when.merge).toEqual(["pre_merge"]);
  });

  it("the ci.yml run commands name NO stack — every step defers to `just`", () => {
    const ci = materializeContractFiles(RUST_LIFECYCLE).find((f) => f.path === SKELETON_CI_CONFIG_PATH);
    const runs = (ci?.content ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("run:"));
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).toMatch(/run: just /u);
      expect(run).not.toMatch(/pnpm|cargo|pandoc/u);
    }
  });
});

describe("materializeContractFiles · the justfile is filled from the lifecycle (all 6 targets, exact commands)", () => {
  it("has all six conventional targets, each with the EXACT captured command", () => {
    const justfile =
      materializeContractFiles(TS_LIFECYCLE).find((f) => f.path === SKELETON_JUSTFILE_PATH)?.content ?? "";
    for (const target of TARGETS) {
      expect(justfile).toContain(`${target}:`);
    }
    // Each captured command appears verbatim as a recipe body.
    expect(justfile).toContain("pnpm install --frozen-lockfile");
    expect(justfile).toContain("pnpm lint && pnpm typecheck");
    expect(justfile).toContain("pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml");
    // The `upgrade` verb (environment-management.md §4.5) fills its target with the
    // project's declared bump command — Tanren names no dependency manager.
    expect(justfile).toContain("pnpm update --latest");
    // No OTHER stack leaks into the RECIPE BODIES (the header comment lists example
    // stacks as guidance — that is not an executed command; assert on tab lines).
    for (const body of recipeBodies(justfile)) {
      expect(body).not.toMatch(/\bcargo\b/u);
    }
  });

  it("no STUB target remains — every recipe runs the real command, not an echo-define placeholder", () => {
    const justfile =
      materializeContractFiles(RUST_LIFECYCLE).find((f) => f.path === SKELETON_JUSTFILE_PATH)?.content ?? "";
    expect(justfile).not.toContain("tanren: define");
    expect(justfile).not.toContain("exit 1");
    expect(justfile).toContain("cargo fetch");
    expect(justfile).toContain("cargo clippy --all-targets -- -D warnings");
    expect(justfile).toContain("cargo build --release");
    for (const body of recipeBodies(justfile)) {
      expect(body).not.toMatch(/\bpnpm\b/u);
    }
  });

  it("recipe bodies are TAB-indented (just requires a tab) — including multi-line commands per line", () => {
    const justfile = renderLifecycleJustfile(MULTILINE_LIFECYCLE);
    const lines = justfile.split("\n");
    // bootstrap's two-line command yields two consecutive TAB-indented recipe lines.
    const bootstrapIdx = lines.findIndex((l) => l === "bootstrap:");
    expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
    expect(lines[bootstrapIdx + 1]).toBe("\tcorepack enable");
    expect(lines[bootstrapIdx + 2]).toBe("\tpnpm install --frozen-lockfile");
  });

  it("is fully general — a novel/pandoc lifecycle fills the same six targets", () => {
    const justfile = renderLifecycleJustfile(NOVEL_LIFECYCLE);
    for (const target of TARGETS) {
      expect(justfile).toContain(`${target}:`);
    }
    expect(justfile).toContain("aspell check chapters/*.md");
    expect(justfile).toContain("pandoc chapters/*.md --to epub --output book.epub");
    for (const body of recipeBodies(justfile)) {
      expect(body).not.toMatch(/\bpnpm\b|\bcargo\b/u);
    }
  });

  it("is DETERMINISTIC — same lifecycle yields byte-identical files", () => {
    const a = materializeContractFiles(TS_LIFECYCLE);
    const b = materializeContractFiles(TS_LIFECYCLE);
    expect(a).toEqual(b);
  });

  it("an UNDECLARED `upgrade` verb renders a LOUD STUB (exit 1), never a silent no-op", () => {
    // The novel/pandoc lifecycle declares no `upgrade` command (nothing to upgrade). The
    // filled justfile must STUB that target — an empty recipe would silently pass a
    // version-change gate, which §4.5 forbids. The other six targets stay filled.
    const justfile = renderLifecycleJustfile(NOVEL_LIFECYCLE);
    expect(justfile).toContain("upgrade:");
    // The stub line names the upgrade target + exits 1.
    expect(justfile).toMatch(/upgrade:\n\t@echo "tanren: define 'upgrade'.*&& exit 1/u);
    // The DECLARED targets are NOT stubbed.
    expect(justfile).toContain("aspell check chapters/*.md");
    expect(justfile).toContain("pandoc chapters/*.md --to epub --output book.epub");
  });

  it("a DECLARED `upgrade` verb fills the target with the real command (no stub)", () => {
    const justfile = renderLifecycleJustfile(RUST_LIFECYCLE);
    expect(justfile).toMatch(/upgrade:\n\tcargo update/u);
    expect(justfile).not.toContain("tanren: define 'upgrade'");
  });
});

describe("materializeContractFiles · the manifest at the conventional paths", () => {
  it("when a toolchain is declared: ci.yml + justfile + mise.toml, nothing else", () => {
    const files = materializeContractFiles(TS_LIFECYCLE);
    expect(files.map((f) => f.path).sort()).toEqual(
      [SKELETON_CI_CONFIG_PATH, SKELETON_JUSTFILE_PATH, SKELETON_MISE_CONFIG_PATH].sort(),
    );
    expect(files).toHaveLength(3);
  });

  it("when NO toolchain is declared: ci.yml + justfile only — NO mise.toml (Tanren invents no versions)", () => {
    const files = materializeContractFiles(NOVEL_LIFECYCLE);
    expect(files.map((f) => f.path).sort()).toEqual([SKELETON_CI_CONFIG_PATH, SKELETON_JUSTFILE_PATH].sort());
    expect(files.find((f) => f.path === SKELETON_MISE_CONFIG_PATH)).toBeUndefined();
    expect(files).toHaveLength(2);
  });
});

describe("renderMiseToml / materializeContractFiles · the mise.toml is rendered from the toolchain list", () => {
  it("renders a [tools] table with each tool=version, sorted + deterministic", () => {
    const toml = renderMiseToml([
      { name: "pnpm", version: "10" },
      { name: "node", version: "24" },
    ]);
    expect(toml).toContain("[tools]");
    expect(toml).toContain('node = "24"');
    expect(toml).toContain('pnpm = "10"');
    // Tools are emitted in stable name-sorted order (node before pnpm).
    expect(toml.indexOf('node = "24"')).toBeLessThan(toml.indexOf('pnpm = "10"'));
    // Deterministic: same name→version set (any order) → byte-identical output.
    expect(
      renderMiseToml([
        { name: "node", version: "24" },
        { name: "pnpm", version: "10" },
      ]),
    ).toBe(toml);
  });

  it("de-duplicates a repeated tool last-wins (never a duplicate [tools] key)", () => {
    const toml = renderMiseToml([
      { name: "node", version: "20" },
      { name: "node", version: "24" },
    ]);
    expect(toml).toContain('node = "24"');
    expect(toml).not.toContain('node = "20"');
    // Exactly one `node = ` line.
    expect((toml.match(/^node = /gmu) ?? []).length).toBe(1);
  });

  it("materializes the mise.toml from the lifecycle toolchain, at the conventional path", () => {
    const mise = materializeContractFiles(TS_LIFECYCLE).find((f) => f.path === SKELETON_MISE_CONFIG_PATH);
    expect(mise).toBeDefined();
    expect(mise?.content).toContain("[tools]");
    expect(mise?.content).toContain('node = "24"');
    expect(mise?.content).toContain('pnpm = "10"');
  });

  it("renders a non-node toolchain just the same (stack-agnostic) — a rust toolchain", () => {
    const mise = materializeContractFiles(RUST_LIFECYCLE).find((f) => f.path === SKELETON_MISE_CONFIG_PATH);
    expect(mise?.content).toContain('rust = "stable"');
    // No OTHER tool leaks into the [tools] BODY (the header comment lists node/pnpm as
    // guidance — that is not a declared tool; assert on the `<tool> = "<v>"` lines).
    const toolLines = (mise?.content ?? "").split("\n").filter((l) => / = "/u.test(l));
    expect(toolLines).toEqual(['rust = "stable"']);
  });

  it("escapes a version-spec so it cannot break the TOML string", () => {
    const toml = renderMiseToml([{ name: "node", version: 'a"b\\c' }]);
    expect(toml).toContain('node = "a\\"b\\\\c"');
  });
});
