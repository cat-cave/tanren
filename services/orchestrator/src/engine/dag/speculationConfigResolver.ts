// The per-project SPECULATION-CONFIG resolver (autonomy-engine.md §2c), split out of `walker.ts`
// for the 500-line cap. Resolves a project's speculation threshold + integration-depth cap from
// its versioned config — the §2c knobs, never an env var.

import { runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { DEFAULT_SPECULATION_THRESHOLD, DEFAULT_SPECULATIVE_INTEGRATION_DEPTH } from "../config/index.js";
import { isAbsentProjectConfig, migrateProjectConfig } from "../config/projectConfig.js";
import type { DagEventEmitter } from "./walkerPg.js";
import type { SpeculationConfig, SpeculationConfigResolver } from "./walker.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("dag-walker");

/**
 * Resolve a project's speculation config (threshold + depth cap) from its versioned project
 * config — the §2c knobs, never an env var. An ABSENT config (`{}` / no `version` — the default
 * a fresh project carries) legitimately uses the schema defaults (moderate / depth 2).
 *
 * no_silent_fallbacks (LOUD-DEFAULT): these knobs gate WORK (speculation eagerness), NOT MERGE —
 * so a corrupt PRESENT config still falls back to the safe schema default rather than failing
 * closed. But the corruption is NEVER silently swallowed: it is logged LOUD and surfaced as a
 * `dag.config.corrupt` observability event, then the default is applied. (Contrast the
 * github-identity / batch-cap resolvers, where a corrupt config yields WRONG behavior and
 * therefore PROPAGATES.)
 */
export function buildSpeculationConfigResolver(pool: pg.Pool, events?: DagEventEmitter): SpeculationConfigResolver {
  return async (projectId: string): Promise<SpeculationConfig> => {
    const config = await runWithSystemScope(pool, async (client) => {
      const result = await client.query<{ config: unknown }>("SELECT config FROM projects WHERE project_id = $1", [
        projectId,
      ]);
      return result.rows[0]?.config;
    });
    // An absent config is not corruption — it simply carries no §2c overrides.
    if (isAbsentProjectConfig(config)) {
      return { threshold: DEFAULT_SPECULATION_THRESHOLD, depthCap: DEFAULT_SPECULATIVE_INTEGRATION_DEPTH };
    }
    try {
      const parsed = migrateProjectConfig(config);
      return { threshold: parsed.speculationThreshold, depthCap: parsed.speculativeIntegrationDepth };
    } catch (error) {
      const appliedDefault = {
        threshold: DEFAULT_SPECULATION_THRESHOLD,
        depthCap: DEFAULT_SPECULATIVE_INTEGRATION_DEPTH,
      };
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("corrupt project config resolving speculation knobs; applying safe default", {
        projectId,
        default: appliedDefault,
        reason,
      });
      await events?.emitConfigCorrupt({ projectId, knob: "speculation_config", appliedDefault, reason });
      return appliedDefault;
    }
  };
}
