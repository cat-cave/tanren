// upgrade barrel — the version-change-as-DAG-node generator (environment-management.md
// §4.5/§7 P1). The operator `upgrade` route + tests import the typed surface from here.

export {
  UPGRADE_SPEC_TITLE,
  generateUpgradeSpec,
  type GenerateUpgradeSpecDeps,
  type GenerateUpgradeSpecInput,
  type GenerateUpgradeSpecResult,
  type UpgradeRefusalReason,
} from "./generator.js";
