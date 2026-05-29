// Single import surface for the repo-sourced tiered CI config. Both GitHub
// Actions (via the CI poller) and the future in-loop gate read this one
// contract so the same steps run in both places. Contract + parser only — no
// execution lives here.
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
