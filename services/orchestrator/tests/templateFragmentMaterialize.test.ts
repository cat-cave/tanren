// LIVE MATRIX-HIT MATERIALIZER — UNIT TESTS (PR-C).
//
// `buildMaterializeCuratedTemplate(deps)` returns the seam derive consumes on a
// `compose-from-fragments` decision. Tests assert it:
//   1. Composes the curated entry via the production composer (calls the dogfood
//      compose path, not a mock).
//   2. Creates a template repo via the injected `createTemplateRepo` plumbing
//      (real call signature; in-memory fake).
//   3. Pushes EVERY composed file via the injected `pushFile` plumbing (one call
//      per VFS entry; in-memory fake records the sequence).
//   4. Returns a `SelectedTemplate` with the freshly-created repo's fullName +
//      a synthesized `TemplateValidationProof` (validated-by-construction).
//
// The composer itself is exercised by the dogfood test; here we only assert the
// materializer's orchestration shape (compose → create → push → mint proof).

import { describe, expect, it } from "vitest";
import {
  buildMaterializeCuratedTemplate,
  lookupCurated,
  type MaterializeCuratedDeps,
} from "../src/engine/templates/index.js";
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
  deps: MaterializeCuratedDeps;
  creates: CreateCall[];
  pushes: PushCall[];
} {
  const creates: CreateCall[] = [];
  const pushes: PushCall[] = [];
  const deps: MaterializeCuratedDeps = {
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

describe("buildMaterializeCuratedTemplate — orchestration", () => {
  it("creates ONE template repo with the curated entry's identity", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io");
    expect(curated).toBeDefined();
    const { deps, creates } = buildFakeDeps();
    const materialize = buildMaterializeCuratedTemplate(deps);
    await materialize({ curated: curated!, lifecycle: LIFECYCLE, owner: "cat-cave" });
    expect(creates.length).toBe(1);
    expect(creates[0]?.owner).toBe("cat-cave");
    expect(creates[0]?.name.startsWith("tanren-tmpl-")).toBe(true);
    expect(creates[0]?.private).toBe(true);
    expect(creates[0]?.description).toContain(curated!.stack);
  });

  it("pushes EVERY composed file to the new template repo's default branch", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io")!;
    const { deps, pushes } = buildFakeDeps();
    const materialize = buildMaterializeCuratedTemplate(deps);
    await materialize({ curated, lifecycle: LIFECYCLE, owner: "cat-cave" });
    expect(pushes.length).toBeGreaterThan(5);
    // Every push targets the same fresh repo + the default branch from createTemplateRepo.
    const branches = new Set(pushes.map((p) => p.defaultBranch));
    expect(branches.size).toBe(1);
    expect(branches.has("main")).toBe(true);
    // Critical base-protected files must have been pushed.
    const paths = new Set(pushes.map((p) => p.path));
    expect(paths.has("justfile")).toBe(true);
    expect(paths.has(".tanren/ci.yml")).toBe(true);
    expect(paths.has(".gitignore")).toBe(true);
  });

  it("returns a SelectedTemplate whose repoRef + validationProof are populated", async () => {
    const curated = lookupCurated("ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io")!;
    const { deps } = buildFakeDeps();
    const materialize = buildMaterializeCuratedTemplate(deps);
    const selected = await materialize({
      curated,
      lifecycle: LIFECYCLE,
      owner: "cat-cave",
      now: () => new Date("2026-06-26T12:00:00.000Z"),
    });
    expect(selected.templateRef).toBe(`tanren://fragments/${curated.id}`);
    expect(selected.repoRef.startsWith("cat-cave/tanren-tmpl-")).toBe(true);
    expect(selected.validationProof.positiveControlsPassed).toBe(true);
    expect(selected.validationProof.auditorClean).toBe(true);
    expect(selected.validationProof.validatedAt).toBe("2026-06-26T12:00:00.000Z");
    // The negative-control results mirror the agent path's success shape (proven).
    expect(selected.validationProof.negativeControls.typecheck).toBe("proven");
    expect(selected.validationProof.negativeControls.lint).toBe("proven");
    expect(selected.validationProof.negativeControls.test).toBe("proven");
    expect(selected.validationProof.negativeControls.mutation).toBe("proven");
    // The validated SHA is the LAST push's commit (the head of the composed push set).
    expect(selected.validationProof.validatedSha.startsWith("sha-")).toBe(true);
  });

  it("also materializes the ruby/bundler curated entry without error", async () => {
    const curated = lookupCurated("ruby/bundler + Rails on Fly.io")!;
    const { deps, pushes } = buildFakeDeps();
    const materialize = buildMaterializeCuratedTemplate(deps);
    const selected = await materialize({ curated, lifecycle: LIFECYCLE, owner: "cat-cave" });
    expect(selected.templateRef).toBe("tanren://fragments/ruby-bundler-fly");
    expect(pushes.length).toBeGreaterThan(5);
    // Ruby-specific files made it through.
    const paths = new Set(pushes.map((p) => p.path));
    expect(paths.has("Gemfile")).toBe(true);
    expect(paths.has("lib/demo.rb")).toBe(true);
  });
});
