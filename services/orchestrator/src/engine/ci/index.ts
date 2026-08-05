// Single import surface for the repo-sourced tiered CI config. Tanren's native
// in-loop gate reads this one contract and runs the declared steps over SSH —
// it is the sole CI authority (Action-less delivery). Contract + parser only —
// no execution lives here.
export {
  CiBootstrap,
  CiConfigV1,
  CiDeploy,
  CiStep,
  CiStepEvidence,
  CiStepRegression,
  CiTiers,
  CiUpgrade,
  CiWhen,
  CiWhenPolicy,
  SUPPORTED_CI_CONFIG_VERSIONS,
  evidenceForStep,
} from "./schema.js";

export {
  CiConfigValidationError,
  CiYamlParseError,
  DEFAULT_CI_CONFIG,
  JUNIT_REPORT_PATH,
  bootstrapCommand,
  deployCommand,
  junitReportFor,
  regressionStepFor,
  resolveCiConfig,
  stepsFor,
  tiersFor,
  upgradeCommand,
} from "./resolve.js";

// THE REGRESSION CONTRACT: the pass→fail transition judgment that makes tests safe to
// run inside the writer's own loop. Pure comparison over parsed JUnit reports — no
// execution, no I/O, no test-runner knowledge.
export {
  MAX_NAMED_REGRESSIONS,
  type RegressionBaseline,
  baselineFromReport,
  confirmRegressions,
  describeRegressions,
  detectRegressions,
  sampleRegressions,
} from "./regression.js";

export { parseYaml } from "./yaml.js";
export type { YamlValue } from "./yaml.js";
