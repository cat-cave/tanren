// Single import surface for the repo-sourced tiered CI config. Tanren's native
// in-loop gate reads this one contract and runs the declared steps over SSH —
// it is the sole CI authority (Action-less delivery). Contract + parser only —
// no execution lives here.
export {
  CI_WHEN_VALUES,
  CiBootstrap,
  CiConfigV1,
  CiStep,
  CiTiers,
  CiWhen,
  CiWhenPolicy,
  SUPPORTED_CI_CONFIG_VERSIONS,
} from "./schema.js";

export {
  CiConfigValidationError,
  CiYamlParseError,
  DEFAULT_CI_CONFIG,
  bootstrapCommand,
  resolveCiConfig,
  stepsFor,
  tiersFor,
} from "./resolve.js";

export { parseYaml } from "./yaml.js";
export type { YamlValue } from "./yaml.js";
