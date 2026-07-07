const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Candidate-inbox source-connector cluster. Disjoint from the run-loop (#107),
  // allocator (#147), workflow-stage (#149), forge-conversation (#152),
  // notifications (#157), secret-store (#160), and the refactor-target backend
  // (repos/worker/dal) clusters: this covers the `SourceConnector` seam + the
  // four provider connectors (GitHub Issues / Sentry / Linear / Jira), the
  // `issues` provider-dispatcher, the deterministic triage answerer, and the
  // ingest -> triage -> persist engine + store row-mapping under
  // `engine/forge/inbox/**`. The `forge` cluster mutates
  // `forge/conversation/**` + the proposal/write-tool files only, so this
  // `forge/inbox/**` slice stays disjoint.
  mutate: ["services/orchestrator/src/engine/forge/inbox/**/*.ts"],
  reporters: ["clear-text"],
  // Ratcheted floor (test/mutation-ratchet-inbox). The inbox source-connector
  // cluster was strengthened from 57.10% to 83.57%. Per file: githubConnector
  // 52.68->85.71, sentryConnector 45.39->81.58, linearConnector 54.72->81.13,
  // jiraConnector 68.75->85.80, issuesConnector 83.33->88.89, defaultAnswerer
  // 57.04->79.58, engine 59.77->78.16, store 45.57->97.47, types 70.49->81.97.
  // New behavior-based tests drive each connector through its injected stub
  // transport and assert the exact wire shape (URL/method/headers/auth/query +
  // per_page/first/maxResults cap), the issue->candidate mapping/normalization
  // (id/title/body-line composition, severity, dedupe-via-upsert, skip rules),
  // error/non-200/missing-secret handling, the dispatcher's provider selection,
  // and the store's INSERT/UPSERT/UPDATE SQL + zod row-mapping defaults. `break`
  // sits just below the measured score so this run passes today and a regression
  // below the floor fails. The remaining survivors are dominated by genuine
  // equivalents: the deterministic answerer's per-word STOPWORDS list entries
  // (`the`/`a`/`to`/`for`/`of`/... mutated to `""` — pinning each individually
  // would contort tests), the `asString` `value.length > 0` boundary (an empty
  // string and `undefined` are observationally identical downstream), the
  // 8000/300-char `.slice()` caps fed inputs that never reach the limit, the
  // `replace(/\/+$/,"")` trailing-slash trims on inputs with no trailing slash,
  // the production `Fetch{Sentry,Linear,Jira}HttpClient` `= fetch` constructor
  // defaults (connectors inject a fake, never the real fetch), and the `types.ts`
  // schema `.default(...)` mutants on fields mapSource/mapCandidate always
  // supply explicitly. See the PR body.
  thresholds: { high: 80, low: 60, break: 83 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-inbox",
  concurrency: 4,
  timeoutMS: 60000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
