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
