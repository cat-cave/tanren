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
  materializeContractFiles,
  renderLifecycleJustfile,
} from "../src/engine/forge/scaffold/index.js";

const TS_LIFECYCLE: ProjectLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
};

const RUST_LIFECYCLE: ProjectLifecycle = {
  stack: "rust/cargo",
  bootstrap: "cargo fetch",
  tier1: "cargo clippy --all-targets -- -D warnings",
  tier2: "cargo test",
  tier3: "cargo clippy --all-targets -- -D warnings && cargo test",
  build: "cargo build --release",
  deploy: "flyctl deploy",
};

// A non-code lifecycle — the contract's generality proof.
const NOVEL_LIFECYCLE: ProjectLifecycle = {
  stack: "novel/pandoc",
  bootstrap: "pip install -r requirements.txt",
  tier1: "aspell check chapters/*.md",
  tier2: "python scripts/consistency-check.py",
  tier3: "aspell check chapters/*.md && python scripts/consistency-check.py",
  build: "pandoc chapters/*.md --to epub --output book.epub",
  deploy: "python scripts/publish.py",
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
};

const TARGETS = ["bootstrap", "tier-1", "tier-2", "tier-3", "build", "deploy"] as const;

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
});

describe("materializeContractFiles · the manifest is exactly the two contract files at their conventional paths", () => {
  it("is the ci.yml + justfile, nothing else", () => {
    const files = materializeContractFiles(TS_LIFECYCLE);
    expect(files.map((f) => f.path).sort()).toEqual([SKELETON_CI_CONFIG_PATH, SKELETON_JUSTFILE_PATH].sort());
    expect(files).toHaveLength(2);
  });
});
