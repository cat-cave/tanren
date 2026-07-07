// Tests for `selectFragmentConfig` (docs/roadmap/templating-system.md).
//
// The single fragment-only scaffold-selection entry point:
//   - a curated stack short-circuits to its `TemplateConfig` (ready, every
//     referenced fragment present in the bundled library);
//   - an unknown stack synthesizes a config from lifecycle tokens; if any
//     referenced fragment is missing from the library, the decision is
//     `missing-fragments` with a `FragmentSpec` per missing slot;
//   - a malformed lifecycle (empty stack) throws `UnresolvableLifecycleError`
//     (no silent default);
//   - `deriveTemplateConfigFromLifecycle` is the pure projection callers can
//     reuse without library coverage analysis.

import { describe, expect, it } from "vitest";
import {
  defaultTestRunnerForRuntime,
  deriveTemplateConfigFromLifecycle,
  selectFragmentConfig,
  UnresolvableLifecycleError,
} from "../src/engine/templates/fragments/selectFragmentConfig.js";
import { loadFragmentLibrary, loadFragmentLibraryForTests } from "../src/engine/templates/fragments/library/index.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/index.js";

function tsLifecycle(overrides: Partial<CaptureLifecycle> = {}): CaptureLifecycle {
  return {
    stack: "ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io",
    bootstrap: "pnpm install",
    tier1: "pnpm lint && pnpm typecheck",
    tier2: "pnpm build && pnpm test",
    tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
    build: "pnpm build",
    deploy: "fly deploy --remote-only",
    upgrade: "",
    toolchain: [],
    ...overrides,
  };
}

describe("selectFragmentConfig — curated short-circuit", () => {
  it("resolves a curated ts/pnpm + React Router + Prisma + Fly stack to ready", () => {
    const result = selectFragmentConfig(tsLifecycle(), loadFragmentLibrary());
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.config.slug).toBe("ts-node-pnpm-react-router-prisma-postgres-fly");
    expect(result.config.runtime).toBe("node-pnpm");
    expect(result.config.frontend).toBe("react-router");
    expect(result.config.db).toBe("postgres-prisma");
    expect(result.config.deploy).toBe("fly");
    expect(result.reasons.some((r) => r.startsWith("curated:"))).toBe(true);
  });

  it("resolves the curated ts/pnpm + Remix stack to ready (frontend-remix bundled)", () => {
    const result = selectFragmentConfig(
      tsLifecycle({ stack: "ts/pnpm + Remix + Prisma + PostgreSQL on Fly.io" }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.config.frontend).toBe("remix");
  });

  it("resolves the curated ruby/bundler + Fly stack to ready", () => {
    const result = selectFragmentConfig(
      tsLifecycle({ stack: "ruby/bundler + Rails on Fly.io", deploy: "fly deploy" }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.config.runtime).toBe("ruby-bundler");
    expect(result.config.deploy).toBe("fly");
  });
});

describe("selectFragmentConfig — missing-fragments synthesis", () => {
  it("returns missing-fragments when the lifecycle synthesizes a config the library does not cover", () => {
    // An unknown runtime token — `selectFragmentConfig` derives
    // `runtime: <token>` verbatim and reports the missing fragment so the
    // per-fragment authoring DAG can fill it. The library has bundled
    // `runtime-node-pnpm` and `runtime-ruby-bundler` only; a "rust-cargo" stack
    // synthesizes `runtime-rust` (open-world tokenization) which is unresolved.
    const result = selectFragmentConfig(
      tsLifecycle({ stack: "rust-cargo + Fly", deploy: "fly deploy" }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("missing-fragments");
    if (result.kind !== "missing-fragments") return;
    expect(result.config.runtime).toBe("rust");
    expect(result.missing.some((m) => m.id === "runtime-rust")).toBe(true);
    expect(result.reasons.some((r) => r.startsWith("missing:"))).toBe(true);
  });

  it("uses the test-only library seam to construct ad-hoc libraries", () => {
    // Sanity check the test seam returns a usable library that resolves a
    // curated config (the bundled defaults are present + nothing extra).
    const library = loadFragmentLibraryForTests();
    const result = selectFragmentConfig(tsLifecycle(), library);
    expect(result.kind).toBe("ready");
  });

  it("returns missing-fragments when an unknown stack token has no bundled fragment", () => {
    // The runtime token "russian-fanfiction-tools" maps to itself (open world);
    // no bundled fragment exists ⇒ missing-fragments.
    const library = loadFragmentLibrary();
    const result = selectFragmentConfig(tsLifecycle({ stack: "russian-fanfiction-tools + fly" }), library);
    expect(result.kind).toBe("missing-fragments");
    if (result.kind !== "missing-fragments") return;
    expect(result.missing.length).toBeGreaterThan(0);
    expect(result.missing.some((m) => m.kind === "runtime")).toBe(true);
    expect(result.reasons.some((r) => r.startsWith("missing:"))).toBe(true);
  });
});

describe("selectFragmentConfig — fail-loud unresolvable lifecycle", () => {
  it("throws on an empty stack (never silently defaults)", () => {
    expect(() => deriveTemplateConfigFromLifecycle(tsLifecycle({ stack: "" }))).toThrow(UnresolvableLifecycleError);
  });
});

describe("selectFragmentConfig — unknown deploy halts loud (Codex H3 #1)", () => {
  // Regression pin: the previous `deriveDeployLabel` silently fell through to
  // `return "none"` when it couldn't identify a deploy target. An opaque command
  // like `heroku container:release web` was treated as no-deploy, silently
  // dropping the deploy phase. The fix mirrors the runtime open-world path:
  // return the first deploy token verbatim so the missing-fragments decision
  // spawns per-fragment authoring for `deploy-<token>`.

  it("returns missing-fragments (not silent 'none') for an unrecognized deploy verb", () => {
    const result = selectFragmentConfig(
      tsLifecycle({
        stack: "russian-fanfiction-tools",
        deploy: "heroku container:release web -a myapp",
      }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("missing-fragments");
    if (result.kind !== "missing-fragments") return;
    expect(result.config.deploy).toBe("heroku");
    expect(result.missing.some((m) => m.kind === "deploy" && m.id === "deploy-heroku")).toBe(true);
  });

  it("still recognizes 'none' / 'no-op' / 'noop' as the explicit no-deploy marker", () => {
    const result = selectFragmentConfig(
      tsLifecycle({ stack: "russian-fanfiction-tools", deploy: "none" }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("missing-fragments");
    if (result.kind !== "missing-fragments") return;
    expect(result.config.deploy).toBe("none");
    // deploy-none IS a bundled fragment, so it is NOT reported missing.
    expect(result.missing.some((m) => m.kind === "deploy")).toBe(false);
  });

  it("throws UnresolvableLifecycleError when lifecycle.deploy is empty (no silent 'none')", () => {
    expect(() => deriveTemplateConfigFromLifecycle(tsLifecycle({ stack: "some-runtime", deploy: "" }))).toThrow(
      UnresolvableLifecycleError,
    );
  });
});

describe("selectFragmentConfig — per-runtime testRunner required contract (Codex H3 #2)", () => {
  // Regression pin: the previous `RUNTIME_REQUIRED_CONTRACT` forced every
  // runtime to declare `testRunner: "vitest"` — a bogus contract for non-Node
  // stacks (Ruby → rspec, Go → go-test, Python → pytest, Rust → cargo-test).
  // The bundled ruby-bundler fragment already declares `rspec`; the required
  // contract now MATCHES per language, and the authoring DAG for an
  // unrecognized runtime is not force-fed `vitest`.

  it("maps the Node/TypeScript family to vitest", () => {
    expect(defaultTestRunnerForRuntime("node-pnpm")).toBe("vitest");
    expect(defaultTestRunnerForRuntime("node")).toBe("vitest");
    expect(defaultTestRunnerForRuntime("ts")).toBe("vitest");
    expect(defaultTestRunnerForRuntime("typescript")).toBe("vitest");
    expect(defaultTestRunnerForRuntime("js")).toBe("vitest");
  });

  it("maps the Ruby family to rspec (matches library/runtime-ruby-bundler.ts contract)", () => {
    expect(defaultTestRunnerForRuntime("ruby-bundler")).toBe("rspec");
    expect(defaultTestRunnerForRuntime("ruby")).toBe("rspec");
    expect(defaultTestRunnerForRuntime("rails")).toBe("rspec");
    expect(defaultTestRunnerForRuntime("bundler")).toBe("rspec");
  });

  it("maps Go to go-test", () => {
    expect(defaultTestRunnerForRuntime("go")).toBe("go-test");
    expect(defaultTestRunnerForRuntime("golang")).toBe("go-test");
    expect(defaultTestRunnerForRuntime("go-modules")).toBe("go-test");
  });

  it("maps Python to pytest", () => {
    expect(defaultTestRunnerForRuntime("python")).toBe("pytest");
    expect(defaultTestRunnerForRuntime("poetry")).toBe("pytest");
    expect(defaultTestRunnerForRuntime("pip")).toBe("pytest");
    expect(defaultTestRunnerForRuntime("pipenv")).toBe("pytest");
  });

  it("maps Rust to cargo-test", () => {
    expect(defaultTestRunnerForRuntime("rust")).toBe("cargo-test");
    expect(defaultTestRunnerForRuntime("cargo")).toBe("cargo-test");
    expect(defaultTestRunnerForRuntime("rust-cargo")).toBe("cargo-test");
  });

  it("returns undefined for an unrecognized runtime (open world — authorer proposes)", () => {
    expect(defaultTestRunnerForRuntime("russian-fanfiction-tools")).toBeUndefined();
    expect(defaultTestRunnerForRuntime("brainfuck")).toBeUndefined();
  });

  it("stamps testRunner: cargo-test on the missing-runtime FragmentSpec for a Rust stack", () => {
    // The runtime label derives verbatim (`rust`) — no bundled fragment covers
    // it, so it lands in `missing`. The required contract MUST carry
    // `testRunner: "cargo-test"`, not `vitest`.
    const result = selectFragmentConfig(
      tsLifecycle({ stack: "rust + fly", deploy: "fly deploy" }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("missing-fragments");
    if (result.kind !== "missing-fragments") return;
    const runtimeSpec = result.missing.find((m) => m.kind === "runtime");
    expect(runtimeSpec).toBeDefined();
    expect(runtimeSpec?.requiredContract.testRunner).toBe("cargo-test");
    expect(runtimeSpec?.requiredContract.reportPath).toBe("reports/junit.xml");
  });

  it("stamps testRunner: go-test on the missing-runtime FragmentSpec for a Go stack", () => {
    const result = selectFragmentConfig(
      tsLifecycle({ stack: "go + fly", deploy: "fly deploy" }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("missing-fragments");
    if (result.kind !== "missing-fragments") return;
    const runtimeSpec = result.missing.find((m) => m.kind === "runtime");
    expect(runtimeSpec).toBeDefined();
    expect(runtimeSpec?.requiredContract.testRunner).toBe("go-test");
  });

  it("stamps testRunner: pytest on the missing-runtime FragmentSpec for a Python stack", () => {
    const result = selectFragmentConfig(
      tsLifecycle({ stack: "python + fly", deploy: "fly deploy" }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("missing-fragments");
    if (result.kind !== "missing-fragments") return;
    const runtimeSpec = result.missing.find((m) => m.kind === "runtime");
    expect(runtimeSpec).toBeDefined();
    expect(runtimeSpec?.requiredContract.testRunner).toBe("pytest");
  });

  it("leaves testRunner unset for an unrecognized runtime label (no vitest force-fill)", () => {
    const result = selectFragmentConfig(
      tsLifecycle({ stack: "russian-fanfiction-tools + fly" }),
      loadFragmentLibrary(),
    );
    expect(result.kind).toBe("missing-fragments");
    if (result.kind !== "missing-fragments") return;
    const runtimeSpec = result.missing.find((m) => m.kind === "runtime");
    expect(runtimeSpec).toBeDefined();
    expect(runtimeSpec?.requiredContract.testRunner).toBeUndefined();
    // reportPath is language-agnostic and remains required.
    expect(runtimeSpec?.requiredContract.reportPath).toBe("reports/junit.xml");
  });
});
