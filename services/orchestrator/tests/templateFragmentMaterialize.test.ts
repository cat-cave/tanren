// COMPOSE+MATERIALIZE SEAM — UNIT TESTS (docs/roadmap/templating-system.md).
//
// `buildMaterializeTemplate(deps)` returns the seam the derive consumes on every
// project DAG. Tests assert it:
//   1. Composes the chosen config via the production composer (calls the dogfood
//      compose path, not a mock).
//   2. Creates a template seed repo via the injected `createTemplateRepo` plumbing
//      (real call signature; in-memory fake).
//   3. Pushes EVERY composed file via the injected `pushFile` plumbing (one call
//      per VFS entry; in-memory fake records the sequence).
//   4. Returns a `SeededTemplate` with the freshly-created repo's fullName + a
//      synthesized validatedAt/validatedSha (validated-by-construction).
//
// The composer itself is exercised by the dogfood test; here we only assert the
// materializer's orchestration shape (compose → create → push → mint seed).

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

interface CreateCall {
  owner: string;
  name: string;
  description: string;
  private: boolean;
}

interface PushCall {
  repoUrl: string;
  defaultBranch: string;
  path: string;
  message: string;
  contentLength: number;
}

function buildFakeDeps(): {
  deps: MaterializeDeps;
  creates: CreateCall[];
  pushes: PushCall[];
} {
  const creates: CreateCall[] = [];
  const pushes: PushCall[] = [];
  const deps: MaterializeDeps = {
    async createTemplateRepo(input) {
      creates.push(input);
      return {
        fullName: `${input.owner}/${input.name}`,
        repoUrl: `https://github.com/${input.owner}/${input.name}`,
        defaultBranch: "main",
      };
    },
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
  return { deps, creates, pushes };
}

describe("buildMaterializeTemplate — orchestration", () => {
  it("creates ONE template seed repo with the config slug identity", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io");
    expect(curated).toBeDefined();
    const { deps, creates } = buildFakeDeps();
    const materialize = buildMaterializeTemplate(deps);
    await materialize({ config: curated!.config, lifecycle: LIFECYCLE, owner: "cat-cave" });
    expect(creates.length).toBe(1);
    expect(creates[0]?.owner).toBe("cat-cave");
    expect(creates[0]?.name.startsWith("tanren-tmpl-")).toBe(true);
    expect(creates[0]?.private).toBe(true);
    expect(creates[0]?.description).toContain(LIFECYCLE.stack);
  });

  it("pushes EVERY composed file to the new seed repo's default branch", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io")!;
    const { deps, pushes } = buildFakeDeps();
    const materialize = buildMaterializeTemplate(deps);
    await materialize({ config: curated.config, lifecycle: LIFECYCLE, owner: "cat-cave" });
    expect(pushes.length).toBeGreaterThan(5);
    const branches = new Set(pushes.map((p) => p.defaultBranch));
    expect(branches.size).toBe(1);
    expect(branches.has("main")).toBe(true);
    const paths = new Set(pushes.map((p) => p.path));
    expect(paths.has("justfile")).toBe(true);
    expect(paths.has(".tanren/ci.yml")).toBe(true);
    expect(paths.has(".gitignore")).toBe(true);
  });

  it("returns a SeededTemplate whose repoRef + validated metadata are populated", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io")!;
    const { deps } = buildFakeDeps();
    const materialize = buildMaterializeTemplate(deps);
    const seeded = await materialize({
      config: curated.config,
      lifecycle: LIFECYCLE,
      owner: "cat-cave",
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });
    expect(seeded.templateRef.startsWith("tanren://composed/")).toBe(true);
    expect(seeded.repoRef.startsWith("cat-cave/tanren-tmpl-")).toBe(true);
    expect(seeded.validatedAt).toBe("2026-06-26T12:00:00.000Z");
    // The validated SHA is the LAST push's commit (the head of the composed push set).
    expect(seeded.validatedSha.startsWith("sha-")).toBe(true);
  });

  it("also materializes the ruby/bundler curated entry without error", async () => {
    const curated = lookupCurated("ruby/bundler + Rails on Fly.io")!;
    const { deps, pushes } = buildFakeDeps();
    const materialize = buildMaterializeTemplate(deps);
    const seeded = await materialize({ config: curated.config, lifecycle: LIFECYCLE, owner: "cat-cave" });
    expect(seeded.templateRef.startsWith("tanren://composed/")).toBe(true);
    expect(pushes.length).toBeGreaterThan(5);
    const paths = new Set(pushes.map((p) => p.path));
    expect(paths.has("Gemfile")).toBe(true);
    expect(paths.has("lib/demo.rb")).toBe(true);
  });
});
