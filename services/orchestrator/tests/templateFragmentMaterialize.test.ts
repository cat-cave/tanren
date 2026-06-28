// COMPOSE+MATERIALIZE SEAM — UNIT TESTS (docs/roadmap/templating-system.md).
//
// `buildMaterializeTemplate(deps)` returns the seam the derive consumes on every
// project DAG. PR-G (task #77) collapsed the intermediate `tanren-tmpl-<slug>`
// template seed repo — the composed VFS now lands DIRECTLY in the just-created
// project repo. Tests assert the materializer:
//   1. Composes the chosen config via the production composer (calls the dogfood
//      compose path, not a mock).
//   2. Pushes EVERY composed file to the PROJECT repo's default branch via the
//      injected `pushFile` plumbing (no `createTemplateRepo` dep — there is no
//      separate seed repo to create).
//   3. Returns a `SeededTemplate` with a content-hash-keyed opaque `templateRef`
//      + a `validatedAt` timestamp (no `repoRef` — no GitHub repo exists at
//      this ref).
//
// The composer itself is exercised by the dogfood test; here we only assert the
// materializer's orchestration shape (compose → push-to-project-repo → mint seed).

import { describe, expect, it } from "vitest";
import { buildMaterializeTemplate, type MaterializeDeps, lookupCurated } from "../src/engine/templates/index.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/types.js";

const LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm build",
  build: "pnpm build",
  deploy: "flyctl deploy",
  toolchain: [],
};

const PROJECT_REPO = {
  fullName: "cat-cave/url-shortener",
  repoUrl: "https://github.com/cat-cave/url-shortener",
  defaultBranch: "main",
};

interface PushCall {
  repoUrl: string;
  defaultBranch: string;
  path: string;
  message: string;
  contentLength: number;
}

function buildFakeDeps(): {
  deps: MaterializeDeps;
  pushes: PushCall[];
} {
  const pushes: PushCall[] = [];
  const deps: MaterializeDeps = {
    async pushFile(input) {
      pushes.push({
        repoUrl: input.repoUrl,
        defaultBranch: input.defaultBranch,
        path: input.path,
        message: input.message,
        contentLength: input.content.length,
      });
      return { commitSha: `sha-${pushes.length}` };
    },
  };
  return { deps, pushes };
}

describe("buildMaterializeTemplate — orchestration (PR-G)", () => {
  it("PUSHES every composed file DIRECTLY to the project repo (no separate seed repo)", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io");
    expect(curated).toBeDefined();
    const { deps, pushes } = buildFakeDeps();
    const materialize = buildMaterializeTemplate(deps);
    await materialize({ config: curated!.config, lifecycle: LIFECYCLE, projectRepo: PROJECT_REPO });
    // Every push lands on the project repo's repoUrl + defaultBranch — never a
    // `tanren-tmpl-*` seed-repo URL.
    expect(pushes.length).toBeGreaterThan(5);
    for (const push of pushes) {
      expect(push.repoUrl).toBe(PROJECT_REPO.repoUrl);
      expect(push.defaultBranch).toBe("main");
      expect(push.repoUrl).not.toMatch(/tanren-tmpl-/u);
    }
    // The contract files + .gitignore + a stack-specific file ride in.
    const paths = new Set(pushes.map((p) => p.path));
    expect(paths.has("justfile")).toBe(true);
    expect(paths.has(".tanren/ci.yml")).toBe(true);
    expect(paths.has(".gitignore")).toBe(true);
  });

  it("returns an OPAQUE templateRef (`tanren://composed/<slug>@<contentHash>`) + a validatedAt — NO repoRef", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io")!;
    const { deps } = buildFakeDeps();
    const materialize = buildMaterializeTemplate(deps);
    const seeded = await materialize({
      config: curated.config,
      lifecycle: LIFECYCLE,
      projectRepo: PROJECT_REPO,
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });
    expect(seeded.templateRef.startsWith("tanren://composed/")).toBe(true);
    // The hash suffix is the sha256 PREFIX over the composed VFS (16 hex chars).
    expect(seeded.templateRef).toMatch(/@[0-9a-f]{16}$/u);
    expect(seeded.validatedAt).toBe("2026-06-26T12:00:00.000Z");
    // No `repoRef` field exists on the new SeededTemplate (PR-G — no GitHub repo
    // exists at this ref). The strict-type guarantees it.
    expect((seeded as Record<string, unknown>)["repoRef"]).toBeUndefined();
    expect((seeded as Record<string, unknown>)["validatedSha"]).toBeUndefined();
  });

  it("produces the SAME templateRef when called twice with the same config (content-hash determinism)", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io")!;
    const first = await buildMaterializeTemplate(buildFakeDeps().deps)({
      config: curated.config,
      lifecycle: LIFECYCLE,
      projectRepo: PROJECT_REPO,
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });
    const second = await buildMaterializeTemplate(buildFakeDeps().deps)({
      config: curated.config,
      lifecycle: LIFECYCLE,
      projectRepo: {
        ...PROJECT_REPO,
        fullName: "another-org/another-project",
        repoUrl: "https://github.com/another-org/another-project",
      },
      now: () => new Date("2026-06-27T15:00:00.000Z"),
    });
    // Same config + same fragment library = same composed VFS = same content hash =
    // same templateRef, regardless of which project repo it landed in or when.
    expect(first.templateRef).toBe(second.templateRef);
    // But validatedAt differs (each compose+push has its own timestamp).
    expect(first.validatedAt).not.toBe(second.validatedAt);
  });

  it("also materializes the ruby/bundler curated entry without error", async () => {
    const curated = lookupCurated("ruby/bundler + Rails on Fly.io")!;
    const { deps, pushes } = buildFakeDeps();
    const materialize = buildMaterializeTemplate(deps);
    const seeded = await materialize({ config: curated.config, lifecycle: LIFECYCLE, projectRepo: PROJECT_REPO });
    expect(seeded.templateRef.startsWith("tanren://composed/")).toBe(true);
    expect(pushes.length).toBeGreaterThan(5);
    const paths = new Set(pushes.map((p) => p.path));
    expect(paths.has("Gemfile")).toBe(true);
    expect(paths.has("lib/demo.rb")).toBe(true);
    // Every push targeted the project repo (no tanren-tmpl- intermediate).
    for (const push of pushes) {
      expect(push.repoUrl).toBe(PROJECT_REPO.repoUrl);
    }
  });
});
