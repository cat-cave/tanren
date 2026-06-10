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
  // FRESH-REPO-SAFE BOOTSTRAP (apex v32): a from-scratch greenfield repo has no
  // lockfile yet, so the first bootstrap is a plain (non-frozen) install that
  // GENERATES the lockfile — never `--frozen-lockfile`, which would fail the cold
  // bootstrap (ERR_PNPM_NO_LOCKFILE) before any lockfile exists.
  bootstrap: "pnpm install",
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

describe("buildScaffoldDescription · narrows the writer to project CODE (contract files materialized)", () => {
  it("tells the writer the contract files are pre-committed + to leave them alone", () => {
    const desc = buildScaffoldDescription(TS_LIFECYCLE);
    // v27 fix: the contract files are materialized deterministically, not authored.
    expect(desc.toLowerCase()).toMatch(/already committed|pre-committed|materialized/u);
    expect(desc).toContain("justfile");
    expect(desc).toContain(".tanren/ci.yml");
    // The writer is told NOT to author/re-define the contract files.
    expect(desc.toLowerCase()).toMatch(/do not author|do not .*re-?define|leave them|intact/u);
    // The writer's job is the actual project code.
    expect(desc.toLowerCase()).toContain("project");
  });

  it("surfaces the lifecycle commands as CONTEXT (so code matches the stack) — no hardcoded stack", () => {
    const desc = buildScaffoldDescription(TS_LIFECYCLE);
    // The six conventional targets appear (context for the project code).
    for (const target of ["just bootstrap", "just tier-1", "just tier-2", "just tier-3", "just build", "just deploy"]) {
      expect(desc).toContain(target);
    }
    // It NEVER inlines a ci.yml body (the deleted hardcode embedded one).
    expect(desc).not.toContain("version: 1\nbootstrap:");
    expect(desc.toLowerCase()).toContain("test report");
  });

  it("a TS capture surfaces pnpm commands and ZERO Rust", () => {
    const desc = buildScaffoldDescription(TS_LIFECYCLE);
    expect(desc).toContain("ts/pnpm");
    // The bootstrap command is surfaced VERBATIM as captured — and the captured
    // greenfield bootstrap is a fresh-repo-safe non-frozen install.
    expect(desc).toContain("pnpm install");
    expect(desc).toContain("pnpm lint && pnpm typecheck");
    expect(desc).not.toContain("cargo");
  });

  it("steers the writer to a fresh-repo bootstrap that commits the generated lockfile (apex v32)", () => {
    const desc = buildScaffoldDescription(TS_LIFECYCLE);
    // The greenfield scaffold's captured bootstrap is NON-frozen (the prompt no
    // longer suggests --frozen-lockfile), so the cold `just bootstrap` works.
    expect(desc).not.toContain("--frozen-lockfile");
    // The writer is explicitly told the bootstrap runs on a fresh repo and the
    // generated lockfile must be committed (not gitignored/omitted).
    expect(desc.toLowerCase()).toMatch(/fresh repo|clean checkout/u);
    expect(desc.toLowerCase()).toMatch(/commit the (generated )?lockfile|lockfile.*commit/u);
    expect(desc.toLowerCase()).toMatch(/not gitignore|do not gitignore|not.*omit/u);
  });

  it("a Rust capture surfaces cargo commands and ZERO pnpm/vitest (no hardcoded stack)", () => {
    const desc = buildScaffoldDescription(RUST_LIFECYCLE);
    expect(desc).toContain("rust/cargo");
    expect(desc).toContain("cargo fetch");
    expect(desc).toContain("cargo clippy --all-targets -- -D warnings");
    expect(desc).toContain("cargo build --release");
    expect(desc).not.toContain("pnpm");
    expect(desc).not.toContain("vitest");
  });

  it("a non-code (novel translation) capture surfaces pandoc/aspell — the contract is fully general", () => {
    const desc = buildScaffoldDescription(NOVEL_LIFECYCLE);
    expect(desc).toContain("novel/pandoc");
    expect(desc).toContain("aspell check chapters/*.md");
    expect(desc).toContain("pandoc chapters/*.md --to epub --output book.epub");
    expect(desc).not.toContain("pnpm");
    expect(desc).not.toContain("cargo");
  });
});

describe("buildScaffoldAcceptanceCriteria · asserts the writer's narrowed job, not a toolchain", () => {
  it("requires real project code + the contract files left intact, with the green bar on bootstrap/tier-1/build", () => {
    const criteria = buildScaffoldAcceptanceCriteria(RUST_LIFECYCLE);
    const joined = criteria.join("\n");
    // The writer's job is real project code for the declared stack.
    expect(joined).toContain("rust/cargo");
    // The contract files are materialized — the writer leaves them intact.
    expect(joined).toContain(".tanren/ci.yml");
    expect(joined.toLowerCase()).toMatch(/materialized|intact|never the contract/u);
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

  it("requires the from-scratch bootstrap to generate + COMMIT the lockfile (apex v32)", () => {
    const criteria = buildScaffoldAcceptanceCriteria(TS_LIFECYCLE);
    const lockfileCriterion = criteria.find((c) => /lockfile/u.test(c) && /commit/iu.test(c));
    expect(lockfileCriterion).toBeDefined();
    expect(lockfileCriterion?.toLowerCase()).toMatch(/no lockfile|clean checkout|fresh/u);
    expect(lockfileCriterion?.toLowerCase()).toMatch(/generates the lockfile|reproducible/u);
    // Stack-agnostic: no frozen-install literal baked into the criteria.
    expect(criteria.join("\n")).not.toContain("--frozen-lockfile");
  });
});
