const config = {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "vitest.stryker.config.ts", related: false },
  coverageAnalysis: "all",
  // Forge conversation + write-action-approval cluster. Disjoint from the
  // run-loop (#107), allocator (#147), and workflow-stage (#149) clusters: this
  // covers the askForge conversation engine + answerer loop, the write-action
  // propose→approve→execute lifecycle (#139 proposal store + proposalDecision),
  // and the capability/audience gating the writes flow through.
  mutate: [
    "services/orchestrator/src/engine/forge/conversation/**/*.ts",
    "services/orchestrator/src/engine/forge/proposals.ts",
    "services/orchestrator/src/engine/forge/proposalDecision.ts",
    "services/orchestrator/src/engine/forge/tools/write.ts",
    "services/orchestrator/src/engine/forge/tools/authz.ts",
  ],
  reporters: ["clear-text"],
  // Ratcheted floor (test/mutation-ratchet-forge). The Forge conversation +
  // write-action-approval cluster was strengthened from 40.00% to 82.28%
  // (answerer 23.40->91.49, engine 74.29->88.57, prompt 0->72.45,
  // authz 49.06->98.11, proposals 55.36->94.64; proposalDecision held 96.97,
  // write.ts 13.51->29.73 — its uncovered bulk is the create_spec/trigger_run
  // bodies that delegate to the deeply-transactional createSpec /
  // createQueuedRunFromSpec, covered by the projectSpec + route suites, not
  // this cluster). `break` sits just below the measured score so this run
  // passes today and a regression below the floor fails. The ~48 remaining
  // survivors are dominated by genuine equivalents: the SYSTEM_PREAMBLE prose
  // StringLiterals + cosmetic `""` section separators in prompt.ts (a flipped
  // sentence/blank line changes no observable behavior the engine consumes),
  // the duplicated `forge thread not found` guard message (the turn store
  // re-throws the same text), and the injected timeoutMs/audience defaults.
  // See the PR body.
  thresholds: { high: 80, low: 60, break: 80 },
  logLevel: "warn",
  tempDirName: "reports/mutation/.stryker-tmp-forge",
  concurrency: 4,
  timeoutMS: 60000,
};
export default config;
