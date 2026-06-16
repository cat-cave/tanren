/**
 * projectConfig — pure helpers for normalizing a project's routing config.
 * Extracted from routes/projects/index.tsx to keep that file under the 500-line
 * architecture cap. resolveConfig fills a defaulted, schema-complete working copy
 * so the settings PATCH always sends a valid config. (The escape-hatch limits are
 * gone — apex v35: no hardcoded attempt caps to normalize.)
 */
import { ROLE_IDS, type ProjectConfig, type RoutingTable } from "../../api/types.js";

export function resolveConfig(config: ProjectConfig | undefined): {
  routing: RoutingTable;
} {
  const routing = emptyRoutingTable();
  if (config?.routing !== undefined) {
    for (const role of ROLE_IDS) {
      const chain = config.routing[role]?.chain;
      if (Array.isArray(chain)) routing[role].chain = chain;
    }
  }
  return { routing };
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
