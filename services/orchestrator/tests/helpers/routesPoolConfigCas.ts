// Config-revision CAS SQL handlers for RoutesPool (keeps routesPool under 500 lines).
// Mirrors store semantics: revision-predicated UPDATE with JSONB IS DISTINCT FROM;
// probe SELECT with config_equal for authoritative no-op / conflict resolution.

import { CONFIG_REVISION_MAX } from "../../src/engine/config/configRevision.js";

export interface ConfigRevisionRow {
  config: unknown;
  config_revision: number;
}

export interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

function single(row: unknown | undefined): QueryResult {
  return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
}

/** Stable JSONB-like equality (key-order invariant) for memory-pool CAS. */
export function jsonbSemanticEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function parseNext(params: unknown[]): unknown {
  return JSON.parse(String(params[0])) as unknown;
}

/** Handle org/project config snapshot + CAS SQL; undefined when the SQL is unrelated. */
export function handleConfigCasSql(
  trimmed: string,
  params: unknown[],
  orgs: Map<string, ConfigRevisionRow & { id: string }>,
  projects: Map<string, ConfigRevisionRow & { project_id: string }>,
): QueryResult | undefined {
  // Authoritative miss probe (includes JSONB equality for no-op detection).
  if (
    trimmed.startsWith("SELECT config, config_revision::text AS revision,") &&
    trimmed.includes("config IS NOT DISTINCT FROM") &&
    trimmed.includes("FROM organizations WHERE id = $1")
  ) {
    const org = orgs.get(String(params[0]));
    if (org === undefined) return { rows: [], rowCount: 0 };
    const next = JSON.parse(String(params[1])) as unknown;
    return {
      rows: [
        {
          config: org.config,
          revision: String(org.config_revision),
          config_equal: jsonbSemanticEqual(org.config, next),
        },
      ],
      rowCount: 1,
    };
  }
  if (
    trimmed.startsWith("SELECT config, config_revision::text AS revision,") &&
    trimmed.includes("config IS NOT DISTINCT FROM") &&
    trimmed.includes("FROM projects WHERE project_id = $1")
  ) {
    const project = projects.get(String(params[0]));
    if (project === undefined) return { rows: [], rowCount: 0 };
    const next = JSON.parse(String(params[1])) as unknown;
    return {
      rows: [
        {
          config: project.config,
          revision: String(project.config_revision),
          config_equal: jsonbSemanticEqual(project.config, next),
        },
      ],
      rowCount: 1,
    };
  }
  if (trimmed.startsWith("SELECT config, config_revision::text AS revision FROM organizations WHERE id = $1")) {
    const org = orgs.get(String(params[0]));
    return single(org === undefined ? undefined : { config: org.config, revision: String(org.config_revision) });
  }
  if (trimmed.startsWith("UPDATE organizations") && trimmed.includes("config_revision = config_revision + 1")) {
    const org = orgs.get(String(params[1]));
    if (org === undefined || org.config_revision !== Number(params[2])) return { rows: [], rowCount: 0 };
    const next = parseNext(params);
    if (jsonbSemanticEqual(org.config, next)) return { rows: [], rowCount: 0 };
    if (org.config_revision >= CONFIG_REVISION_MAX) {
      throw new Error(
        `config_revision overflow: organization=${org.id} current=${org.config_revision} cannot increment past ${CONFIG_REVISION_MAX}`,
      );
    }
    org.config = next;
    org.config_revision += 1;
    return { rows: [{ config: org.config, revision: String(org.config_revision) }], rowCount: 1 };
  }
  if (trimmed.startsWith("UPDATE organizations SET config")) {
    throw new Error("RoutesPool: LWW UPDATE organizations SET config is deleted — use revision CAS");
  }
  if (trimmed.startsWith("SELECT config, config_revision::text AS revision FROM projects WHERE project_id = $1")) {
    const project = projects.get(String(params[0]));
    return single(
      project === undefined ? undefined : { config: project.config, revision: String(project.config_revision) },
    );
  }
  if (trimmed.startsWith("UPDATE projects") && trimmed.includes("config_revision = config_revision + 1")) {
    const project = projects.get(String(params[1]));
    if (project === undefined || project.config_revision !== Number(params[2])) return { rows: [], rowCount: 0 };
    const next = parseNext(params);
    if (jsonbSemanticEqual(project.config, next)) return { rows: [], rowCount: 0 };
    if (project.config_revision >= CONFIG_REVISION_MAX) {
      throw new Error(
        `config_revision overflow: project=${project.project_id} current=${project.config_revision} cannot increment past ${CONFIG_REVISION_MAX}`,
      );
    }
    project.config = next;
    project.config_revision += 1;
    return { rows: [{ config: project.config, revision: String(project.config_revision) }], rowCount: 1 };
  }
  if (trimmed.startsWith("UPDATE projects SET config")) {
    throw new Error("RoutesPool: LWW UPDATE projects SET config is deleted — use revision CAS");
  }
  return undefined;
}
