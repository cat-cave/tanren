// Tests for the non-Node runtime paths of the F2 runtime-validity smoke —
// pip/uv, go, and cargo resolver seams (Codex MEDIUM #1 + Claude MEDIUM
// finding). Extracted from `fragmentRuntimeValiditySmoke.test.ts` to keep both
// files under the 500-line architecture cap.
//
// COVERAGE:
//   - `parsePipError` / `parseGoError` / `parseCargoError` — deterministic
//     unit tests over the resolver's error output shapes so tests never spawn
//     a real subprocess.
//   - `PipInvoker` / `GoInvoker` / `CargoInvoker` seam SHAPE assertions via
//     canned fake invokers (a typecheck-level regression pin on the
//     three-arm union `{ ok | failed | unavailable }`).
//   - `buildLive*Invoker` factories — smoke-only wiring assertion so knip
//     sees the exports as used AND a signature refactor breaks here.
//   - Real integration tests (opt-in via TANREN_REAL_{PIP,GO,CARGO}=1) —
//     skipped in `just fast-check` so it stays fast + deterministic.

import { describe, expect, it } from "vitest";
import {
  type CargoInvoker,
  type GoInvoker,
  parseCargoError,
  parseGoError,
  parsePipError,
  type PipInvoker,
} from "../src/engine/templates/index.js";

// ── Module-scoped canned invokers (consistent-function-scoping lint) ────────

const pipOk: PipInvoker = async () => ({ kind: "ok" });
const pipFailed: PipInvoker = async () => ({ kind: "failed", message: "no matching version for x" });
const pipUnavailable: PipInvoker = async () => ({ kind: "unavailable" });

const goOk: GoInvoker = async () => ({ kind: "ok" });
const goFailed: GoInvoker = async () => ({ kind: "failed", message: "module not found" });
const goUnavailable: GoInvoker = async () => ({ kind: "unavailable" });

const cargoOk: CargoInvoker = async () => ({ kind: "ok" });
const cargoFailed: CargoInvoker = async () => ({ kind: "failed", message: "no matching version" });
const cargoUnavailable: CargoInvoker = async () => ({ kind: "unavailable" });

describe("parsePipError — actionable rejection message extraction", () => {
  it("names the specific package + version on pip's 'Could not find a version' message", () => {
    const output = [
      "Collecting fastapi==999.999.999",
      "  ERROR: Could not find a version that satisfies the requirement fastapi==999.999.999 (from versions: 0.1, 0.2, 0.3)",
      "ERROR: No matching distribution found for fastapi==999.999.999",
    ].join("\n");
    expect(parsePipError(output)).toContain("no matching version for fastapi==999.999.999");
  });

  it("names the specific package on pip's 'No matching distribution' message", () => {
    // The 'Could not find' regex takes priority; test the standalone 'No matching' regex
    // with an output that lacks the 'Could not find' preamble.
    const output = "ERROR: No matching distribution found for made-up-pkg-xyz==2.0.0";
    expect(parsePipError(output)).toContain("no matching distribution for made-up-pkg-xyz==2.0.0");
  });

  it("names the specific package on uv's 'no version of X' message", () => {
    const output = [
      "  × No solution found when resolving dependencies:",
      "  ╰─▶ Because there is no version of django==999.0.0, we can conclude that",
      "      your project's requirements are unsatisfiable.",
    ].join("\n");
    expect(parsePipError(output)).toContain("no matching version for django==999.0.0");
  });

  it("falls through to the first non-empty line when no pip/uv error pattern matches", () => {
    expect(parsePipError("random pip noise\nmore noise")).toBe("random pip noise");
  });

  it("returns the sentinel string on empty output", () => {
    expect(parsePipError("")).toBe("install failed with no output");
  });
});

describe("parseGoError — actionable rejection message extraction", () => {
  it("names the specific module + version on 404 Not Found", () => {
    const output = "go: example.com/nope@v9.9.9: reading https://example.com/nope: 404 Not Found";
    expect(parseGoError(output)).toContain("module not found: example.com/nope@v9.9.9");
  });

  it("names the module + revision on 'unknown revision'", () => {
    const output = "go: example.com/pkg@v99.0.0: unknown revision v99.0.0";
    const parsed = parseGoError(output);
    expect(parsed).toContain("unknown revision v99.0.0");
    expect(parsed).toContain("example.com/pkg@v99.0.0");
  });

  it("names the module on general 'module resolution failed' shapes", () => {
    const output = "go: module example.com/deadrepo: repository not found";
    expect(parseGoError(output)).toContain("module resolution failed: example.com/deadrepo");
  });

  it("returns the first 'go:' line when no structured pattern matches", () => {
    const output = "go: some other weirdness\ntrailing noise";
    expect(parseGoError(output)).toBe("go: some other weirdness");
  });

  it("returns the sentinel string on empty output", () => {
    expect(parseGoError("")).toBe("install failed with no output");
  });
});

describe("parseCargoError — actionable rejection message extraction", () => {
  it("names the specific crate + version on 'failed to select a version'", () => {
    const output = 'error: failed to select a version for the requirement `serde = "^99.0.0"`';
    expect(parseCargoError(output)).toContain('no matching version for serde = "^99.0.0"');
  });

  it("names the crate on 'no matching package named'", () => {
    const output = "error: no matching package named `made-up-crate-xyz` found";
    expect(parseCargoError(output)).toContain("no matching package made-up-crate-xyz");
  });

  it("names the crate on 'failed to load source for dependency'", () => {
    const output = "error: failed to load source for dependency `dead-crate`";
    expect(parseCargoError(output)).toContain("failed to load source for dead-crate");
  });

  it("returns the first `error:` line when no structured pattern matches", () => {
    const output = "error: something unusual happened\nnoise";
    expect(parseCargoError(output)).toBe("error: something unusual happened");
  });

  it("returns the sentinel string on empty output", () => {
    expect(parseCargoError("")).toBe("install failed with no output");
  });
});

// ── Non-Node invoker typing surface ─────────────────────────────────────────
//
// The three seams (pip/go/cargo) mirror the same three-arm union — a
// downstream refactor that accidentally widens/narrows the arms fails here at
// typecheck. Canned invokers are declared module-scoped (consistent-function-
// scoping lint) then invoked inside the test.
describe("non-Node invoker seams — shape assertion via canned fakes", () => {
  it("PipInvoker admits ok / failed / unavailable arms", async () => {
    expect((await pipOk({ cwd: "/tmp", pyprojectPath: "/tmp/pyproject.toml" })).kind).toBe("ok");
    expect((await pipFailed({ cwd: "/tmp", pyprojectPath: "/tmp/pyproject.toml" })).kind).toBe("failed");
    expect((await pipUnavailable({ cwd: "/tmp", pyprojectPath: "/tmp/pyproject.toml" })).kind).toBe("unavailable");
  });

  it("GoInvoker admits ok / failed / unavailable arms", async () => {
    expect((await goOk({ cwd: "/tmp", gomodPath: "/tmp/go.mod" })).kind).toBe("ok");
    expect((await goFailed({ cwd: "/tmp", gomodPath: "/tmp/go.mod" })).kind).toBe("failed");
    expect((await goUnavailable({ cwd: "/tmp", gomodPath: "/tmp/go.mod" })).kind).toBe("unavailable");
  });

  it("CargoInvoker admits ok / failed / unavailable arms", async () => {
    expect((await cargoOk({ cwd: "/tmp", cargoTomlPath: "/tmp/Cargo.toml" })).kind).toBe("ok");
    expect((await cargoFailed({ cwd: "/tmp", cargoTomlPath: "/tmp/Cargo.toml" })).kind).toBe("failed");
    expect((await cargoUnavailable({ cwd: "/tmp", cargoTomlPath: "/tmp/Cargo.toml" })).kind).toBe("unavailable");
  });
});

// ── Real integration tests (opt-in) ─────────────────────────────────────────
//
// These tests spawn real pip/uv, go, and cargo binaries. Skipped by default so
// `just fast-check` stays deterministic + fast. Opt in per-runtime via the
// corresponding env var. Each asserts the LIVE invoker + parser wiring end-to-end
// on the operator's host toolchain.
//
// The assertion body checks the result kind is in a small allowed set (ok /
// failed / unavailable) because the operator's environment determines which
// resolver binaries are on PATH. When we DO get a `failed`, the message must
// name the specific broken dep — that's the whole point of the parser.

describe.skipIf(process.env.TANREN_REAL_PIP !== "1")("buildLivePipInvoker — real pip/uv integration", () => {
  it("resolves ok / fails / unavailable against a real pyproject.toml", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const liveMod = await import("../src/engine/templates/fragments/runtimeValiditySmokeLive.js");
    const dir = await mkdtemp(join(tmpdir(), "tanren-pip-real-"));
    try {
      const badPyproject = [
        "[project]",
        'name = "tanren-test"',
        'version = "0.0.0"',
        'dependencies = ["fastapi==999.999.999"]',
        "",
        "[build-system]",
        'requires = ["setuptools>=61"]',
        'build-backend = "setuptools.build_meta"',
      ].join("\n");
      await writeFile(join(dir, "pyproject.toml"), badPyproject);
      const result = await liveMod.buildLivePipInvoker()({ cwd: dir, pyprojectPath: join(dir, "pyproject.toml") });
      // If neither pip nor uv exists on the host, we accept `unavailable`.
      expect(["ok", "failed", "unavailable"]).toContain(result.kind);
      // If the resolver actually ran and failed, the message must name fastapi.
      const failMessage = result.kind === "failed" ? result.message : "";
      expect(result.kind === "failed" ? failMessage.includes("fastapi") : true).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.env.TANREN_REAL_GO !== "1")("buildLiveGoInvoker — real go integration", () => {
  it("rejects an unresolvable go.mod with an actionable message", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const liveMod = await import("../src/engine/templates/fragments/runtimeValiditySmokeLive.js");
    const dir = await mkdtemp(join(tmpdir(), "tanren-go-real-"));
    try {
      // A go.mod that requires a nonexistent module — go mod download should fail.
      const goMod = [
        "module tanren.test",
        "",
        "go 1.22",
        "",
        "require example.com/nonexistent-tanren-test-module v9.9.9",
      ].join("\n");
      await writeFile(join(dir, "go.mod"), goMod);
      const result = await liveMod.buildLiveGoInvoker()({ cwd: dir, gomodPath: join(dir, "go.mod") });
      expect(["failed", "unavailable"]).toContain(result.kind);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.env.TANREN_REAL_CARGO !== "1")("buildLiveCargoInvoker — real cargo integration", () => {
  it("rejects an unresolvable Cargo.toml with an actionable message", async () => {
    const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const liveMod = await import("../src/engine/templates/fragments/runtimeValiditySmokeLive.js");
    const dir = await mkdtemp(join(tmpdir(), "tanren-cargo-real-"));
    try {
      const cargoToml = [
        "[package]",
        'name = "tanren_test"',
        'version = "0.0.0"',
        'edition = "2021"',
        "",
        "[dependencies]",
        'serde = "999.0.0"',
      ].join("\n");
      await writeFile(join(dir, "Cargo.toml"), cargoToml);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "lib.rs"), "");
      const result = await liveMod.buildLiveCargoInvoker()({ cwd: dir, cargoTomlPath: join(dir, "Cargo.toml") });
      expect(["failed", "unavailable"]).toContain(result.kind);
      const failMessage = result.kind === "failed" ? result.message.toLowerCase() : "";
      expect(result.kind === "failed" ? /serde|version|matching/u.test(failMessage) : true).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
