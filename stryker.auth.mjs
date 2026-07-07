const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Operator-authentication + session/identity cluster. Disjoint from the
  // run-loop (#107), allocator (#147), workflow-stage (#149), forge (#152),
  // notifications (#157), secret-store (#160), inbox (#163), and the
  // refactor-target backend (repos/worker/dal) clusters: this covers the
  // operator-auth lane only — the `IdentityProvider` seam + github_oauth /
  // generic OIDC / Authentik-preset / local_dev providers, the OIDC/Authentik
  // env builders, session/token/identity persistence + the actor-context scope
  // derivation in `identityStore.ts`, and the request auth middleware
  // (actor-context resolution + org/scope derivation). It deliberately EXCLUDES
  // the P2 mTLS internal service-auth (engine/contracts/mtlsChannel*,
  // routes/internal/**), which is a separate worker/internal lane.
  mutate: ["services/orchestrator/src/auth/**/*.ts", "services/orchestrator/src/middleware/auth.ts"],
  reporters: ["clear-text"],
  // Ratcheted floor (test/mutation-ratchet-auth). The operator-auth + identity
  // cluster was strengthened from 52.42% to 78.43%. Per file: authentikEnv
  // 100->100, identityProvider 0->100, localDevProvider 14.29->100, schemas
  // 0->88.33, oidcProvider 63.70->80.00, middleware/auth 51.88->80.45,
  // identityStore 62.91->80.28, devLogin 53.85->76.92, githubProvider
  // 56.56->68.85, oidcEnv 32.35->67.65. New behavior-based tests drive each
  // provider through an injected fetch stub and assert the mapped IdentityClaims
  // (OIDC/GitHub claim precedence, group->org lowercasing, numeric-subject
  // coercion), the token/userinfo wire shape (method/Content-Type/grant_type/
  // bearer-not-secret), discovery caching + non-ok/malformed error mapping, the
  // Authentik-preset + env-override resolution and per-credential gating, the
  // IdentityStore session/token expiry boundaries + the actor-context scope
  // derivation (platform/org/project admin/member, org-membership resolution,
  // cross-org deny), the request middleware's accept/reject decisions (bearer
  // vs session vs localDev, CSRF on state-changing methods, public-path bypass,
  // org/scope derivation, cookie parsing), and the identity/session/token zod
  // schema validation contract (enum members, .min(1), nullable, defaults).
  // `break` sits just below the measured score so this run passes today and a
  // regression below the floor fails. The remaining survivors are dominated by
  // genuine equivalents: the IdentityStore SQL-string mutants the fake pool's
  // `startsWith` matcher ignores, the `?? null` / `?? 0` row-default fallbacks,
  // the `updated_at`/`last_used_at = now()` clauses never read back, the
  // production `= fetch` constructor defaults (every provider injects a stub),
  // and the github/oidc `Accept` header literals with no observable effect. See
  // the PR body.
  thresholds: { high: 80, low: 60, break: 78 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-auth",
  concurrency: 4,
  timeoutMS: 60000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
