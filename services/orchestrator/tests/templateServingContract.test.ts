// SERVING-CONTRACT COHERENCE — the composed node-pnpm + deploy-fly scaffold MUST
// bind a port and answer GET / so the deploy smoke-check passes.
//
// The deploy adapter's `smokeCheck()` GETs the root URL `https://<app>.fly.dev`
// (directApiDeployAdapter.ts); reachable iff 2xx/3xx. Fly maps edge 80/443 →
// `internal_port 3000` (fly.toml) and injects `PORT` for the app process. So the
// composed scaffold MUST listen on `process.env.PORT ?? 3000` and return 200 on
// `GET /`.
//
// This test proves the three launch surfaces are mutually consistent and aligned
// with fly.toml's `internal_port = 3000` — WITHOUT a live Fly call:
//   1. `src/index.ts` exists, reads `process.env.PORT`, and calls `.listen(`.
//   2. `package.json` `main` + `scripts.start` both target `dist/index.js`.
//   3. `tsconfig.build.json` compiles `src/**/*.ts` → `dist/` so the built entry
//      IS `dist/index.js` (the CMD/start target).
//   4. `fly.toml` declares `internal_port = 3000`.
//   5. When `addon-docker` is also composed: the Dockerfile `CMD` targets
//      `node dist/index.js` — matching `main`/`start` (one artifact, three
//      consumers).
//   6. (Optional, gated) materialize + `pnpm build` → `dist/index.js` emitted.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { composeTemplate, loadFragmentLibrary, type TemplateConfig } from "../src/engine/templates/index.js";
import { RUNTIME_NODE_PNPM_OWNED_FILES } from "../src/engine/templates/fragments/library/runtime-node-pnpm.js";

const execFileAsync = promisify(execFile);

const BARE_FLY: TemplateConfig = {
  slug: "serving-contract-bare",
  runtime: "node-pnpm",
  deploy: "fly",
  addons: [],
  examples: [],
};

const FLY_WITH_DOCKER: TemplateConfig = {
  slug: "serving-contract-docker",
  runtime: "node-pnpm",
  deploy: "fly",
  addons: ["docker"],
  examples: [],
};

describe("serving-contract coherence — bare node-pnpm + deploy-fly binds PORT and answers GET /", () => {
  it("src/index.ts exists and binds process.env.PORT via .listen()", async () => {
    const vfs = await composeTemplate(BARE_FLY, loadFragmentLibrary());
    expect(vfs.has("src/index.ts")).toBe(true);
    const entry = vfs.read("src/index.ts");
    expect(entry, "src/index.ts must read process.env.PORT").toMatch(/process\.env\.PORT/u);
    expect(entry, "src/index.ts must call .listen(").toMatch(/\.listen\(/u);
  });

  it("package.json declares main + start targeting dist/index.js", async () => {
    const vfs = await composeTemplate(BARE_FLY, loadFragmentLibrary());
    const pkg = JSON.parse(vfs.read("package.json")) as { main?: string; scripts?: { start?: string } };
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.scripts?.start).toBe("node dist/index.js");
  });

  it("tsconfig.build.json compiles src/**/*.ts to dist/ so the built entry is dist/index.js", async () => {
    const vfs = await composeTemplate(BARE_FLY, loadFragmentLibrary());
    const tsconfig = JSON.parse(vfs.read("tsconfig.build.json")) as {
      compilerOptions?: { outDir?: string };
      include?: string[];
    };
    expect(tsconfig.compilerOptions?.outDir).toBe("dist");
    expect(tsconfig.include).toContain("src/**/*.ts");
  });

  it("fly.toml declares internal_port = 3000 (the port src/index.ts binds)", async () => {
    const vfs = await composeTemplate(BARE_FLY, loadFragmentLibrary());
    expect(vfs.read("fly.toml")).toContain("internal_port = 3000");
  });

  it("Dockerfile CMD matches package.json main/start when addon-docker is composed", async () => {
    const vfs = await composeTemplate(FLY_WITH_DOCKER, loadFragmentLibrary());
    const dockerfile = vfs.read("Dockerfile");
    expect(dockerfile, "Dockerfile CMD must target dist/index.js").toContain('CMD ["node", "dist/index.js"]');
    const pkg = JSON.parse(vfs.read("package.json")) as { main?: string; scripts?: { start?: string } };
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.scripts?.start).toBe("node dist/index.js");
  });

  it("src/index.ts is in the runtime-owned files set (drift-guard coherence)", () => {
    expect(RUNTIME_NODE_PNPM_OWNED_FILES).toContain("src/index.ts");
  });
});

// Optional, strongest proof: materialize the bare compose, run `pnpm build`, and
// assert dist/index.js is actually emitted. Gated behind TANREN_REAL_PNPM=1 so
// `just fast-check` stays hermetic (mirrors the runtimeValiditySmoke live pattern).
describe.skipIf(process.env.TANREN_REAL_PNPM !== "1")(
  "serving-contract coherence — real pnpm build emits dist/index.js",
  () => {
    it("pnpm build produces dist/index.js from the bare compose", async () => {
      const vfs = await composeTemplate(BARE_FLY, loadFragmentLibrary());
      const dir = await mkdtemp(join(tmpdir(), "tanren-serving-contract-"));
      try {
        const flat = vfs.toFlatMap();
        for (const path of Object.keys(flat)) {
          const absPath = join(dir, path);
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, flat[path] ?? "");
        }
        await execFileAsync("pnpm", ["install", "--no-frozen-lockfile"], {
          cwd: dir,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, CI: "true" },
        });
        await execFileAsync("pnpm", ["build"], {
          cwd: dir,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, CI: "true" },
        });
        expect(existsSync(join(dir, "dist", "index.js"))).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      // Real pnpm install + tsc build of the materialized scaffold — needs far more than
      // the 5s default (a cold install alone can take ~1 min). Gated off `just fast-check`.
    }, 180_000);
  },
);
