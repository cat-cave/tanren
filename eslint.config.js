// Type-aware lint pass (Track B wave 4).
//
// oxlint (oxlintrc.json) remains the primary fast linter; it runs the broad
// AST-only ruleset. ESLint here is intentionally NARROW: it exists ONLY to add
// the handful of high-value rules that require full type information and that
// oxlint cannot do today (floating/misused promises, awaiting non-thenables).
// We deliberately do NOT enable the typescript-eslint recommended set — that
// would duplicate and conflict with oxlint and red-wall the repo.
//
// Scope: services/*/src, db/src, cli/src — the source we ship. Tests, scripts,
// dist and the hi-fidelity mock are excluded; type-aware linting is slow and
// these rules target shipped async code (orchestrator/worker bug risks).
import tseslint from "typescript-eslint";

// The scoped source carries a few `eslint-disable unicorn/no-thenable`
// directives that target oxlint (which loads the unicorn plugin). ESLint here
// does not load unicorn, so without this it would error on the unknown rule.
// Registering a no-op `unicorn` plugin namespace lets those directives parse
// cleanly while keeping this ESLint pass focused on the 3 typed rules below.
const oxlintUnicornCompat = {
  rules: {
    "no-thenable": { meta: {}, create: () => ({}) },
  },
};

// The three high-value rules that require full type information.
const typedRules = {
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/await-thenable": "error",
};

const sharedPlugins = {
  "@typescript-eslint": tseslint.plugin,
  unicorn: oxlintUnicornCompat,
};

export default tseslint.config(
  {
    // dist output and the hi-fidelity mock are never linted.
    ignores: ["**/dist/**", "tanren-hi-fidelity/**"],
  },
  {
    // Server / library source: typed via the nearest per-workspace
    // tsconfig.json, discovered automatically by the project service.
    files: [
      "services/*/src/**/*.{ts,tsx}",
      "db/src/**/*.ts",
      "cli/src/**/*.ts",
    ],
    // The dashboard browser client has its own tsconfig (tsconfig.client.json)
    // and is handled by the dedicated block below.
    ignores: ["services/dashboard/src/client/**"],
    plugins: sharedPlugins,
    linterOptions: {
      // oxlint owns unused-disable reporting; don't double-report here.
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: typedRules,
  },
  {
    // Dashboard browser client: typed via its dedicated client tsconfig (DOM
    // libs, bundler resolution) rather than the server tsconfig. Floating
    // promises here are real bugs too, so it stays in scope.
    files: ["services/dashboard/src/client/**/*.ts"],
    plugins: sharedPlugins,
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "services/dashboard/tsconfig.client.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: typedRules,
  },
);
