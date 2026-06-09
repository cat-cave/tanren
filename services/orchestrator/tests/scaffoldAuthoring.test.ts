// Lifecycle-driven scaffold authoring (the stack-flexible contract, Wave B).
//
// The apex v25/v26 bug: the interview captured the architecture as a free-form
// string but the scaffold IGNORED it and hardcoded pnpm via the (now deleted)
// `scaffoldCiConfig.ts`. The fix: the architecture step captures a CONCRETE
// lifecycle (the stack commands behind the conventional justfile targets) and the
// scaffold AUTHORS the justfile from it — with ZERO hardcoded stack.
//
// This unit-tests the authoring functions directly (no DB): a Rust capture yields
// cargo commands, a TS capture yields pnpm — proving the scaffold bakes in NO
// stack. The end-to-end derive path (interview → scaffold spec) is covered in
// visionInterview.test.ts.

import { describe, expect, it } from "vitest";
import {
  buildScaffoldAcceptanceCriteria,
  buildScaffoldDescription,
  type CaptureLifecycle,
} from "../src/engine/forge/interview/index.js";

const TS_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
};

const RUST_LIFECYCLE: CaptureLifecycle = {
  stack: "rust/cargo",
  bootstrap: "cargo fetch",
  tier1: "cargo clippy --all-targets -- -D warnings",
  tier2: "cargo test",
  tier3: "cargo clippy --all-targets -- -D warnings && cargo test",
  build: "cargo build --release",
  deploy: "flyctl deploy",
};

// A non-code project — the contract's generality proof: a Russian-novel
// translation conforms identically (tier-1 = spellcheck, build = render epub).
const NOVEL_LIFECYCLE: CaptureLifecycle = {
  stack: "novel/pandoc",
  bootstrap: "pip install -r requirements.txt",
  tier1: "aspell check chapters/*.md",
  tier2: "python scripts/consistency-check.py",
  tier3: "aspell check chapters/*.md && python scripts/consistency-check.py",
  build: "pandoc chapters/*.md --to epub --output book.epub",
  deploy: "python scripts/publish.py",
};

describe("buildScaffoldDescription · authors the justfile FROM the captured lifecycle (no hardcoded stack)", () => {
  it("starts from the bare skeleton and fills the six conventional justfile targets", () => {
    const desc = buildScaffoldDescription(TS_LIFECYCLE);
    expect(desc).toMatch(/bare .*skeleton/iu);
    expect(desc).toContain("justfile");
    for (const target of ["just bootstrap", "just tier-1", "just tier-2", "just tier-3", "just build", "just deploy"]) {
      expect(desc).toContain(target);
    }
  });

  it("keeps the .tanren/ci.yml as the stable lifecycle→`just <target>` map, NOT a hardcoded ci.yml body", () => {
    const desc = buildScaffoldDescription(TS_LIFECYCLE);
    expect(desc).toContain(".tanren/ci.yml");
    expect(desc.toLowerCase()).toContain("per_iteration");
    expect(desc.toLowerCase()).toContain("pre_audit");
    expect(desc.toLowerCase()).toContain("pre_merge");
    // The deleted hardcode embedded a full `version: 1\nbootstrap: …` pnpm ci.yml
    // verbatim. The lifecycle authoring NEVER inlines a ci.yml body or stack into it.
    expect(desc).not.toContain("version: 1\nbootstrap:");
    // References the test-report convention rather than a baked-in JUnit path.
    expect(desc.toLowerCase()).toContain("test report");
  });

  it("a TS capture yields pnpm commands and ZERO Rust", () => {
    const desc = buildScaffoldDescription(TS_LIFECYCLE);
    expect(desc).toContain("ts/pnpm");
    expect(desc).toContain("pnpm install --frozen-lockfile");
    expect(desc).toContain("pnpm lint && pnpm typecheck");
    expect(desc).not.toContain("cargo");
  });

  it("a Rust capture yields cargo commands and ZERO pnpm/vitest (no hardcoded stack)", () => {
    const desc = buildScaffoldDescription(RUST_LIFECYCLE);
    expect(desc).toContain("rust/cargo");
    expect(desc).toContain("cargo fetch");
    expect(desc).toContain("cargo clippy --all-targets -- -D warnings");
    expect(desc).toContain("cargo build --release");
    expect(desc).not.toContain("pnpm");
    expect(desc).not.toContain("vitest");
  });

  it("a non-code (novel translation) capture yields pandoc/aspell — the contract is fully general", () => {
    const desc = buildScaffoldDescription(NOVEL_LIFECYCLE);
    expect(desc).toContain("novel/pandoc");
    expect(desc).toContain("aspell check chapters/*.md");
    expect(desc).toContain("pandoc chapters/*.md --to epub --output book.epub");
    expect(desc).not.toContain("pnpm");
    expect(desc).not.toContain("cargo");
  });
});

describe("buildScaffoldAcceptanceCriteria · asserts the contract shape, not a toolchain", () => {
  it("requires a filled justfile + a stable ci.yml map, with the green bar on bootstrap/tier-1/build", () => {
    const criteria = buildScaffoldAcceptanceCriteria(RUST_LIFECYCLE);
    const joined = criteria.join("\n");
    // The justfile fills the conventional targets (no STUB remains).
    expect(joined).toContain("bootstrap/tier-1/tier-2/tier-3/build/deploy");
    expect(joined).toContain("rust/cargo");
    // The ci.yml is the lifecycle→`just <target>` map.
    expect(joined).toContain(".tanren/ci.yml");
    expect(joined).toContain("just tier-1");
    // The green bar is bootstrap/tier-1/build — NOT the test tier.
    const greenCriterion = criteria.find((c) => /each exits 0|are green/u.test(c));
    expect(greenCriterion).toBeDefined();
    expect(greenCriterion).toContain("just bootstrap");
    expect(greenCriterion).toContain("just tier-1");
    expect(greenCriterion).toContain("just build");
    expect(criteria.some((c) => /(just tier-2|just tier-3).*exits 0/u.test(c))).toBe(false);
    // No stack literal hardcoded into the criteria beyond the declared stack label.
    expect(joined).not.toContain("pnpm");
  });
});
