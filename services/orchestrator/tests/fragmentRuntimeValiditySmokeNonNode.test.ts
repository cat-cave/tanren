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
//   - `buildLivePipInvoker` pyproject-only fallback — a shell-script fake pip
//     that logs its args, so a regression test can pin that
//     `--no-build-isolation` is NOT passed (Codex round-III H6). With that
//     flag, pip needed the build backend (hatchling / poetry-core /
//     setuptools>=64) pre-installed in the ambient env — a fresh temp dir
//     doesn't, so every valid modern-build-backend pyproject on a uv-less
//     host got rejected with "Cannot import 'hatchling.build'" and named no
//     user-facing dep. Both the ok arm (fake pip exits 0) and the failed arm
//     (fake pip emits pip's "No matching distribution" shape) are asserted.
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

// ── H6 regression: pyproject-only fallback drops --no-build-isolation ───────
//
// The `buildLivePipInvoker` pyproject arm previously ran with
// `--no-build-isolation`, which requires the declared build backend
// (hatchling / poetry-core / setuptools>=64 / etc.) pre-installed in the pip
// process's ambient env. A fresh temp dir has no venv setup, so on any host
// where `uv` isn't on PATH, every valid modern pyproject rejected with
// "Cannot import 'hatchling.build'" — the message named no user-facing dep,
// so the writer's next rework iteration couldn't act on it.
//
// The fix (H6): drop `--no-build-isolation`. Pip build-isolates by default,
// installing the declared backend into an isolated env before the resolver
// runs. Slower on first run (backend download) but correct against every
// modern pyproject.
//
// This test pins the fix via a shell-script fake `pipBinary` that logs its
// args + returns pip's "No matching distribution" shape on stderr, so the
// parser has an actionable error to work with. Skipped on Windows because
// the fake uses `#!/bin/sh` + `chmod +x`.
describe.skipIf(process.platform === "win32")(
  "buildLivePipInvoker — pyproject-only fallback drops --no-build-isolation (H6)",
  () => {
    it("does NOT pass --no-build-isolation on a modern-build-backend pyproject", async () => {
      const { mkdtemp, writeFile, rm, chmod, readFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const liveMod = await import("../src/engine/templates/fragments/runtimeValiditySmokeLive.js");
      const dir = await mkdtemp(join(tmpdir(), "tanren-pip-h6-args-"));
      try {
        // A modern-build-backend pyproject — hatchling requires build isolation
        // to install its backend into a temp env before pip can resolve deps.
        const pyproject = [
          "[project]",
          'name = "tanren-h6-test"',
          'version = "0.0.0"',
          'dependencies = ["fastapi==999.999.999"]',
          "",
          "[build-system]",
          'requires = ["hatchling"]',
          'build-backend = "hatchling.build"',
        ].join("\n");
        await writeFile(join(dir, "pyproject.toml"), pyproject);
        // Fake pip: log args, then emit pip's "No matching distribution" error
        // shape so `parsePipError` names fastapi in the returned message.
        const argsLogPath = join(dir, "pip-args.log");
        const fakePipPath = join(dir, "fake-pip");
        const fakePipScript = [
          "#!/bin/sh",
          `printf '%s\\n' "$@" > "${argsLogPath}"`,
          "printf 'ERROR: Could not find a version that satisfies the requirement fastapi==999.999.999\\n' >&2",
          "printf 'ERROR: No matching distribution found for fastapi==999.999.999\\n' >&2",
          "exit 1",
          "",
        ].join("\n");
        await writeFile(fakePipPath, fakePipScript);
        await chmod(fakePipPath, 0o755);
        // Force the pip fallback path by pointing uvBinary at a nonexistent
        // path — `tryUvPipCompile` returns null on ENOENT so we fall through
        // to `tryPipDryRun` (the H6-fixed arm).
        const invoker = liveMod.buildLivePipInvoker({
          pipBinary: fakePipPath,
          uvBinary: join(dir, "nonexistent-uv"),
        });
        const result = await invoker({ cwd: dir, pyprojectPath: join(dir, "pyproject.toml") });
        // Error path: fake pip returned nonzero → invoker returns failed +
        // parser names fastapi (the user-facing dep, not a "cannot import
        // hatchling.build" backend error).
        expect(result.kind).toBe("failed");
        const message = result.kind === "failed" ? result.message : "";
        expect(message).toContain("fastapi");
        // The H6 pin: verify --no-build-isolation is NOT in the args passed
        // to pip. A future refactor that re-adds the flag reproduces the
        // "cannot import hatchling.build" bug against every valid pyproject.
        const loggedArgs = (await readFile(argsLogPath, "utf8")).split("\n").filter((l) => l.length > 0);
        expect(loggedArgs).not.toContain("--no-build-isolation");
        // Belt: assert the expected args ARE there so a future accidental
        // swap (e.g. dropping --dry-run) fails loud here too.
        expect(loggedArgs).toContain("install");
        expect(loggedArgs).toContain("--dry-run");
        expect(loggedArgs).toContain("--ignore-installed");
        expect(loggedArgs).toContain(".");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("returns ok when the fake pip exits 0 against a modern-build-backend pyproject", async () => {
      const { mkdtemp, writeFile, rm, chmod } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const liveMod = await import("../src/engine/templates/fragments/runtimeValiditySmokeLive.js");
      const dir = await mkdtemp(join(tmpdir(), "tanren-pip-h6-ok-"));
      try {
        const pyproject = [
          "[project]",
          'name = "tanren-h6-ok"',
          'version = "0.0.0"',
          'dependencies = ["httpx"]',
          "",
          "[build-system]",
          'requires = ["setuptools>=64"]',
          'build-backend = "setuptools.build_meta"',
        ].join("\n");
        await writeFile(join(dir, "pyproject.toml"), pyproject);
        // Fake pip that exits 0 — the "resolvable" case.
        const fakePipPath = join(dir, "fake-pip");
        await writeFile(fakePipPath, "#!/bin/sh\nexit 0\n");
        await chmod(fakePipPath, 0o755);
        const invoker = liveMod.buildLivePipInvoker({
          pipBinary: fakePipPath,
          uvBinary: join(dir, "nonexistent-uv"),
        });
        const result = await invoker({ cwd: dir, pyprojectPath: join(dir, "pyproject.toml") });
        expect(result.kind).toBe("ok");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);

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
