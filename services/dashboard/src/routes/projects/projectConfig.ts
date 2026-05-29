/**
 * projectConfig — pure helpers for normalizing a project's routing/escape-hatch
 * config. Extracted from routes/projects/index.tsx to keep that file under the
 * 500-line architecture cap. resolveConfig fills a defaulted, schema-complete
 * working copy so the settings PATCH always sends a valid config.
 */
import { ROLE_IDS, type EscapeHatches, type ProjectConfig, type RoutingTable } from "../../api/types.js";
import { ESCAPE_HATCH_DEFAULTS } from "../../components/project/SettingsBody.js";

export function resolveConfig(config: ProjectConfig | undefined): {
  routing: RoutingTable;
  escapeHatches: EscapeHatches;
} {
  const routing = emptyRoutingTable();
  if (config?.routing !== undefined) {
    for (const role of ROLE_IDS) {
      const chain = config.routing[role]?.chain;
      if (Array.isArray(chain)) routing[role].chain = chain;
    }
  }
  const escapeHatches: EscapeHatches = {
    ...ESCAPE_HATCH_DEFAULTS,
    ...config?.escapeHatches,
  };
  return { routing, escapeHatches };
}

export function emptyRoutingTable(): RoutingTable {
  return {
    plan: { chain: [] },
    write: { chain: [] },
    check: { chain: [] },
    audit: { chain: [] },
    demo: { chain: [] },
    forge: { chain: [] },
  };
}
