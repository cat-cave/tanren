// RUNTIME — node + pnpm. The first concrete runtime fragment (the apex default).
//
// Declares:
//   - mise.toml additions: node 24, pnpm 11
//   - package.json (with workspaces declared so frontend/backend fragments can mount
//     subpackages without rewriting it)
//   - tsconfig.json (strict, ESM, modern target; noEmit typecheck config — src+tests)
//   - tsconfig.build.json (emit config that extends tsconfig.json; src-only → dist/)
//   - eslint.config.js (eslint 9 flat config so the `lint` script resolves)
//   - vitest.config.ts (junit reporter wired so the gate's evidence block reads the
//     report at the contract-declared path)
//   - pnpm-workspace.yaml (nodeLinker: hoisted — a FLAT node_modules so Stryker's
//     sibling-glob plugin discovery finds @stryker-mutator/vitest-runner; see the
//     PNPM_WORKSPACE constant for the full root-cause)
//   - cucumber.cjs (Cucumber config rooted at `features/` — the BDD home base/ created)
//   - justfile hook fills for bootstrap / tier-1 / tier-2 / tier-3 / build
//   - contract: { testRunner: "vitest", reportPath: "reports/junit.xml",
//     ciTier2: "pnpm test -- --reporter=junit --outputFile=reports/junit.xml" }

import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const RUNTIME_NODE_PNPM_ID = "runtime-node-pnpm" as const;

// TYPECHECK-only config (the typecheck + IDE config). With `noEmit` and no rootDir,
// typechecking src+tests is valid — no TS6059 ("File is not under rootDir"), which a
// single tsconfig with `rootDir:"src"` + `include:["tests/**"]` triggers. The emit
// config lives in TSCONFIG_BUILD (src-only include + rootDir src ⇒ clean flat dist).
const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
`;

// EMIT config — the build script (`tsc -p tsconfig.build.json`) compiles this. Extends
// the typecheck config, flips `noEmit` off, restores `rootDir:"src"` + emit options, and
// narrows `include` to src-only so `dist/` is a clean flat artifact (tests excluded).
const TSCONFIG_BUILD = `{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
`;

// ESLint flat config — eslint 9 requires `eslint.config.js` at the root; shipping the
// `lint` script (`eslint src tests`) without it aborts with "ESLint couldn't find an
// eslint.config.js" on the tier-1 gate.
const ESLINT_CONFIG = `import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "reports/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
`;

const VITEST_CONFIG = `import { defineConfig } from "vitest/config";

// The JUnit reporter target is the path Tanren's native gate's evidence block reads
// (the runtime fragment declared { reportPath: "reports/junit.xml" } on its contract;
// processCiYml filled the ci.yml evidence to match).
export default defineConfig({
  test: {
    reporters: [["default", { summary: false }], ["junit", { outputFile: "reports/junit.xml" }]],
  },
});
`;

const CUCUMBER_CONFIG = `// Cucumber BDD config rooted at the features/ home base/ created. Step definitions
// live under features/step_definitions/; a fragment adds them.
module.exports = {
  default: {
    paths: ["features/**/*.feature"],
    require: ["features/step_definitions/**/*.cjs"],
    format: ["junit:reports/cucumber-junit.xml"],
  },
};
`;

const STRYKER_CONFIG = `// Mutation testing — PR-B made this a first-class tier. The base/ mutation-baseline
// test asserts THIS file exists; the dogfood test additionally asserts the
// configuration is real (mutate src, exclude tests, reports written to a path the
// .tanren/ci.yml's tier-3 mutation step reads). \`just mutation\` runs stryker with
// json + clear-text reporters; the gate's evidence block reads the json artifact.
export default {
  packageManager: "pnpm",
  testRunner: "vitest",
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  coverageAnalysis: "perTest",
  mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/**/*.spec.ts"],
  thresholds: { high: 80, low: 60, break: 0 },
  timeoutMS: 60000,
  concurrency: 2,
};
`;

const DEMO_ENTRY = `// Tanren node-pnpm runtime — a minimal demo entry so the base/ functional-demo test
// passes on a fresh compose. A frontend/backend fragment may extend this; replacing
// it wholesale is fine, removing it is not (the base test asserts existence).
export function tanrenDemo(): string {
  return "tanren node-pnpm runtime ready";
}

if (import.meta.url === \`file://\${process.argv[1] ?? ""}\`) {
  console.log(tanrenDemo());
}
`;

// The HTTP server entry — the SINGLE artifact that satisfies all three launch
// surfaces at once: the Dockerfile `CMD ["node", "dist/index.js"]` (addon-docker),
// the buildpacks launch `pnpm start` (package.json `scripts.start`), and
// package.json `main`. `tsc -p tsconfig.build.json` compiles `src/index.ts` →
// `dist/index.js` (TSCONFIG_BUILD.include = ["src/**/*.ts"]). Uses `node:http`
// (zero deps) and serves `tanrenDemo()` so the served surface is tied to the same
// demo function the behavioral test asserts. Listens on `process.env.PORT ?? 3000`
// (Fly injects PORT == fly.toml internal_port 3000) on `0.0.0.0` so the container
// edge can reach it. A frontend/backend fragment MAY replace this entry wholesale
// to serve its real UI; removing it drops the served surface the deploy verifies.
const SERVER_ENTRY = `import { createServer } from "node:http";
import { tanrenDemo } from "./demo.js";

// Tanren node-pnpm runtime — minimal HTTP server so the composed scaffold SERVES
// on Fly's internal_port. Fly injects PORT (== fly.toml internal_port 3000);
// fall back to 3000 for local/dev. \`Number(...) || 3000\` coerces a missing, empty,
// or non-numeric PORT to 3000 (an empty string would otherwise become 0 = a random
// port). A frontend/backend fragment may replace this entry wholesale, but removing
// it drops the served surface the deploy verifies.
const port = Number(process.env.PORT) || 3000;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(tanrenDemo());
});

server.listen(port, "0.0.0.0", () => {
  console.log(\`tanren listening on \${port}\`);
});
`;

const DEMO_TEST = `// A test that exercises the demo entry — proves the public surface actually returns
// a result, beyond base/'s presence-only structural assertion.
import { describe, expect, it } from "vitest";
import { tanrenDemo } from "../src/demo.js";

describe("tanren demo", () => {
  it("returns the runtime-ready string", () => {
    expect(tanrenDemo()).toContain("node-pnpm runtime ready");
  });
});
`;

// pnpm settings — pnpm 10+ reads its OWN settings from pnpm-workspace.yaml, NOT
// .npmrc (which now holds only npm-compatible keys: registry, auth). We need
// `nodeLinker: hoisted` so the composed scaffold gets a FLAT, npm-like node_modules
// with the packages' real directories at the top level.
//
// ROOT CAUSE (apex v90 `just mutation` halt): `pnpm stryker run` failed with
// "Cannot find TestRunner plugin \"vitest\". In fact, no TestRunner plugins were
// loaded." even though @stryker-mutator/vitest-runner WAS installed and
// root-resolvable. Stryker's default `plugins: ["@stryker-mutator/*"]` is a glob:
// its PluginLoader discovers plugins by readdir-ing the directory that is a SIBLING
// of @stryker-mutator/core, resolved from core's OWN `import.meta.url`. Under pnpm's
// default isolated linker, node_modules/@stryker-mutator/core is a symlink into
// `.pnpm/@stryker-mutator+core@<v>/node_modules/@stryker-mutator/`, and Node resolves
// import.meta.url to that realpath. The only siblings of core THERE are its own deps
// (api, util, instrumenter — all on Stryker's IGNORED list); vitest-runner lives in a
// DIFFERENT `.pnpm/@stryker-mutator+vitest-runner@.../` dir, so the glob finds zero
// plugins. `nodeLinker: hoisted` places core + vitest-runner as real sibling
// directories under a single top-level node_modules/@stryker-mutator/, so the glob
// finds vitest-runner. (An .npmrc `node-linker=hoisted` does NOT work: pnpm 11 ignores
// node-linker in .npmrc.) Verified live: with this file the scaffold's `pnpm stryker
// run` completes and writes reports/mutation/mutation.json.
const PNPM_WORKSPACE = `# pnpm reads its own settings from HERE (not .npmrc) since pnpm 10.
# nodeLinker: hoisted → a flat, npm-like node_modules. REQUIRED so Stryker's
# plugin-discovery glob (@stryker-mutator/*) finds the vitest-runner as a real
# sibling of @stryker-mutator/core; under the default isolated linker the symlinked
# realpath isolates each plugin in its own .pnpm dir and \`just mutation\` fails with
# "no TestRunner plugins were loaded". Do not remove without re-proving mutation runs.
nodeLinker: hoisted
`;

const MISE_TOML = `# Tanren base/ — toolchain pin. Runtime fragments fill the [tools] block; do not
# add deps via env vars (mise pins the version we ran the gate on).
[tools]
node = "24"
pnpm = "11"
`;

function packageJsonFor(config: TemplateConfig): string {
  return `${JSON.stringify(
    {
      name: config.slug,
      version: "0.0.0",
      private: true,
      type: "module",
      main: "dist/index.js",
      scripts: {
        lint: "eslint src tests",
        typecheck: "tsc -p tsconfig.json --noEmit",
        test: "vitest run",
        build: "tsc -p tsconfig.build.json",
        start: "node dist/index.js",
      },
    },
    null,
    2,
  )}\n`;
}

// SINGLE SOURCE OF TRUTH — the files this runtime fragment WRITES. Any other
// fragment that re-writes one of these paths collides at compose time
// (VfsCollisionError). The `apply()` body writes FROM this set (and mise.toml +
// package.json, which are config-dependent — see OWNED_FILES below), so the set
// can never drift from what is actually written. `providerFragmentAuthorer.ts`
// imports OWNED_FILES to build the writer-guidance "do NOT overwrite these" list,
// and a drift-guard test asserts the guidance names every entry.
//
// `content` is `undefined` for the two config-dependent files (mise.toml is
// overwritten, package.json is derived from `config.slug`); those are still OWNED
// (a re-write collides) but are written on their own lines in `apply()`.
const STATIC_OWNED_FILES: Readonly<Record<string, string>> = {
  "tsconfig.json": TSCONFIG,
  "tsconfig.build.json": TSCONFIG_BUILD,
  "eslint.config.js": ESLINT_CONFIG,
  "vitest.config.ts": VITEST_CONFIG,
  "pnpm-workspace.yaml": PNPM_WORKSPACE,
  "cucumber.cjs": CUCUMBER_CONFIG,
  "stryker.conf.mjs": STRYKER_CONFIG,
  "src/demo.ts": DEMO_ENTRY,
  "src/index.ts": SERVER_ENTRY,
  "tests/demo.test.ts": DEMO_TEST,
  "features/step_definitions/.gitkeep": "",
} as const;

/** Every file path this runtime fragment owns (writes on compose). A fragment that
 * re-writes any of these collides (VfsCollisionError). The authorer guidance is
 * derived from this set so it can never go stale. */
export const RUNTIME_NODE_PNPM_OWNED_FILES: readonly string[] = [
  "mise.toml",
  "package.json",
  ...Object.keys(STATIC_OWNED_FILES),
];

/** Every devDep this runtime fragment declares. A fragment that re-declares one of
 * these at a DIFFERENT version throws the conflict check; same-version is idempotent.
 * The authorer guidance is derived from this set so it can never go stale. */
export const RUNTIME_NODE_PNPM_OWNED_DEVDEPS: Readonly<Record<string, string>> = {
  vitest: "^4.0.0",
  typescript: "^5.6.0",
  // Explicit: `src/index.ts` imports `node:http` + reads `process.env`, and `src/demo.ts`
  // reads `process.argv`. Declaring @types/node (matching the node:24-alpine Docker base)
  // makes the scaffold's `tsc -p tsconfig.build.json` resolve node builtins DIRECTLY,
  // rather than relying on a transitively-hoisted @types/node (fragile — a dep bump could
  // drop it and break the build gate + the Docker image build).
  "@types/node": "^24.0.0",
  eslint: "^9.0.0",
  "@eslint/js": "^9.0.0",
  "typescript-eslint": "^8.0.0",
  "@cucumber/cucumber": "^11.0.0",
  "@stryker-mutator/core": "^9.0.0",
  "@stryker-mutator/vitest-runner": "^9.0.0",
} as const;

export const runtimeNodePnpmFragment: Fragment = {
  id: RUNTIME_NODE_PNPM_ID,
  version: "1.0.0",
  kind: "runtime",
  contract: {
    testRunner: "vitest",
    reportPath: "reports/junit.xml",
    ciTier2: "pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  },
  async apply(vfs: VirtualFileSystem, config: TemplateConfig): Promise<void> {
    // Fill mise.toml's [tools] table (config-dependent OWNED file — overwritten).
    vfs.overwrite("mise.toml", MISE_TOML);

    // package.json — config-dependent OWNED file (derived from config.slug).
    vfs.write("package.json", packageJsonFor(config));

    // The static OWNED files — written FROM the single-source-of-truth map so the
    // exported RUNTIME_NODE_PNPM_OWNED_FILES set cannot drift from what is written.
    for (const [path, content] of Object.entries(STATIC_OWNED_FILES)) {
      vfs.write(path, content);
    }

    // Runtime devDeps — vitest + tooling. Declared FROM the single-source-of-truth
    // map (RUNTIME_NODE_PNPM_OWNED_DEVDEPS) so the exported set cannot drift. Versions
    // are pinned strings; an addon that bumps these declares the bump via
    // addPackageJsonDevDep so the conflict-check surfaces a coordinated bump (or
    // rejects an accidental skew).
    for (const [name, version] of Object.entries(RUNTIME_NODE_PNPM_OWNED_DEVDEPS)) {
      vfs.addPackageJsonDevDep(name, version);
    }

    // Justfile hook fills — the base owns the recipe shell; the runtime fills the
    // recipe BODY via this surface.
    //
    // FRESH-CHECKOUT BOOTSTRAP (task #84 / apex v63): the FIRST `just bootstrap`
    // runs against a freshly composed scaffold that ships a `package.json` but NO
    // `pnpm-lock.yaml` — `--frozen-lockfile` would `ERR_PNPM_NO_LOCKFILE` and halt
    // the per-iteration `tanren-bootstrap` tier before the writer can do anything.
    // `--no-frozen-lockfile` makes the contract EXPLICIT: pnpm generates the
    // lockfile on first run (it is then committed by the writer), updates it when
    // package.json gains a dep, and on later runs with the committed lockfile pnpm
    // still respects it — pnpm only regenerates when the package.json diverges.
    // This matches the interview-prompt doctrine in forge/interview/prompt.ts which
    // already mandates that the FIRST bootstrap must GENERATE the lockfile (never a
    // frozen/locked install). A scaffold that does not bootstrap from a fresh
    // checkout is a doctrine violation — see docs/roadmap/templating-system.md
    // §"every composed scaffold bootstraps from a fresh checkout".
    vfs.appendToJustfileTarget("bootstrap", ["pnpm install --no-frozen-lockfile"]);
    vfs.appendToJustfileTarget("tier-1", ["pnpm lint", "pnpm typecheck"]);
    vfs.appendToJustfileTarget("tier-2", [
      "mkdir -p reports",
      "pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
    ]);
    vfs.appendToJustfileTarget("tier-3", ["pnpm build"]);
    vfs.appendToJustfileTarget("build", ["pnpm build"]);
    // PR-B (NB-2): mutation testing as a first-class tier — stryker run that writes a
    // json report at reports/mutation/mutation.json (the path the base/ ci.yml's
    // tier-3 mutation step's artifact-evidence reads). A runtime fragment that leaves
    // this hook empty is caught by assertRuntimeFillsMutationHook in the dogfood test.
    vfs.appendToJustfileTarget("mutation", [
      "mkdir -p reports/mutation",
      "pnpm stryker run --reporters json,clear-text",
    ]);
  },
};
