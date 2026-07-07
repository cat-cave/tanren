const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Notification channels + dispatch cluster. Disjoint from the run-loop (#107),
  // allocator (#147), workflow-stage (#149), and forge (#152) clusters: this
  // covers the nine channel adapters (ntfy/slack/github_checks/teams/discord/
  // email/twilio/pagerduty/webhook), the NotificationChannel registry/factory,
  // the dispatcher routing/fan-out, and the severity + matrix evaluation the
  // dispatcher routes through.
  mutate: ["services/orchestrator/src/engine/notifications/**/*.ts"],
  reporters: ["clear-text"],
  // Ratcheted floor (test/mutation-ratchet-notifications). The notification
  // channels + dispatch cluster was strengthened from 61.68% to 87.04%
  // (channels 59.17->87.83, dispatcher 39.88->69.05, schemas 57.27->94.55,
  // store 50.00->80.56, registry 86.67->93.33, matrix 95.24->98.41; per-channel:
  // slack 47.92->89.58, discord 48.08->84.62, teams 55.84->93.51, githubChecks
  // 54.95->82.42, email 67.19->95.31, twilio 66.67->86.36, pagerduty
  // 64.06->85.94, ntfy 68.75->85.94, webhook 70.83->83.33). `break` sits just
  // below the measured score so this run passes today and a regression below the
  // floor fails. The ~92 remaining survivors are dominated by genuine
  // equivalents: the `truncate`/cap boundaries fed inputs that never exceed the
  // limit (slack 150 / discord 256-4096 / teams card / pagerduty 1024 / twilio
  // 1500 / ntfy 4096 caps and the `max - 3` ellipsis arithmetic), the
  // `safeReadText`/`.trim()` no-ops on the error path, the `defaultLog` console
  // wrapper + injected `now`/`log` defaults the dispatcher never exercises under
  // an injected clock, and the `promote(warn)`/`promote(fail)` ladder arms that
  // are unreachable because every event that promotes has an `ok`/`info` base.
  // See the PR body.
  thresholds: { high: 80, low: 60, break: 85 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-notify",
  concurrency: 4,
  timeoutMS: 60000,
  // Stryker's default `dryRunTimeoutMinutes` is 5. The full vitest suite runs
  // once against every mutated cluster in the initial dry run; on GitHub's
  // ubuntu-latest runner it now brushes that ceiling (June 8 baseline: 3m43s;
  // June 15+ runs: >5m timeouts as the codebase grew). Bumped to 15 for headroom.
  dryRunTimeoutMinutes: 15,
};
export default config;
