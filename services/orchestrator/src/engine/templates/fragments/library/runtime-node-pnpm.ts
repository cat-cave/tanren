// RUNTIME — node + pnpm. The first concrete runtime fragment (the apex default).
//
// Declares:
//   - mise.toml additions: node 24, pnpm 11
//   - package.json (with workspaces declared so frontend/backend fragments can mount
//     subpackages without rewriting it)
//   - tsconfig.json (strict, ESM, modern target)
//   - vitest.config.ts (junit reporter wired so the gate's evidence block reads the
//     report at the contract-declared path)
//   - cucumber.cjs (Cucumber config rooted at `features/` — the BDD home base/ created)
//   - justfile hook fills for bootstrap / tier-1 / tier-2 / tier-3 / build
//   - contract: { testRunner: "vitest", reportPath: "reports/junit.xml",
//     ciTier2: "pnpm test -- --reporter=junit --outputFile=reports/junit.xml" }

import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const RUNTIME_NODE_PNPM_ID = "runtime-node-pnpm" as const;

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
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
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
    // Fill mise.toml's [tools] table.
    vfs.overwrite(
      "mise.toml",
      `# Tanren base/ — toolchain pin. Runtime fragments fill the [tools] block; do not
# add deps via env vars (mise pins the version we ran the gate on).
[tools]
node = "24"
pnpm = "11"
`,
    );

    vfs.write(
      "package.json",
      `${JSON.stringify(
        {
          name: config.slug,
          version: "0.0.0",
          private: true,
          type: "module",
          scripts: {
            lint: "eslint src tests",
            typecheck: "tsc -p tsconfig.json --noEmit",
            test: "vitest run",
            build: "tsc -p tsconfig.json",
          },
        },
        null,
        2,
      )}\n`,
    );

    vfs.write("tsconfig.json", TSCONFIG);
    vfs.write("vitest.config.ts", VITEST_CONFIG);
    vfs.write("cucumber.cjs", CUCUMBER_CONFIG);
    vfs.write("stryker.conf.mjs", STRYKER_CONFIG);
    vfs.write("src/demo.ts", DEMO_ENTRY);
    vfs.write("tests/demo.test.ts", DEMO_TEST);
    vfs.write("features/step_definitions/.gitkeep", "");

    // Runtime deps — vitest + tooling. Versions are pinned strings; an addon that
    // bumps these declares the bump via addPackageJsonDevDep so the conflict-check
    // surfaces a coordinated bump (or rejects an accidental skew).
    vfs.addPackageJsonDevDep("vitest", "^4.0.0");
    vfs.addPackageJsonDevDep("typescript", "^5.6.0");
    vfs.addPackageJsonDevDep("eslint", "^9.0.0");
    vfs.addPackageJsonDevDep("@cucumber/cucumber", "^11.0.0");
    vfs.addPackageJsonDevDep("@stryker-mutator/core", "^9.0.0");
    vfs.addPackageJsonDevDep("@stryker-mutator/vitest-runner", "^9.0.0");

    // Justfile hook fills — the base owns the recipe shell; the runtime fills the
    // recipe BODY via this surface.
    vfs.appendToJustfileTarget("bootstrap", ["pnpm install --frozen-lockfile"]);
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
