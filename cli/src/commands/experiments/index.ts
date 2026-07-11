// `tanren experiments ...` + `tanren cells ...` commands — the benchmark
// report/CRUD surface (docs/roadmap/tanren-method-benchmark.md §4.2.4). Authors
// experiments + cells, triggers a run (the orchestrator's scheduler), and reads
// cell scorecards (`report`) + cell-vs-cell comparisons (`compare`). CRUD verbs
// print the raw JSON (the default); `report` / `compare` render a table for an
// operator and honor `--json` to print the raw response instead.

import { isPlainObject, parseJsonObject, rejectUnknownKeys, requireNonEmptyString } from "../../json.js";
import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required, type ParsedArgs } from "../args.js";
import { renderCellComparison, renderCellScorecard, type CellComparison, type CellScorecard } from "./render.js";

/** Matches server `SeedTaskRef` shape (engine/benchmark/entities.ts). */
export interface SeedTaskRefInput {
  repo: string;
  sha: string;
  acceptTierHash: string;
  corpusTier: 0 | 1 | 2;
}

/** Matches server `FrozenConfig` top-level shape (engine/benchmark/entities.ts). */
export interface FrozenConfigInput {
  routing: Record<string, unknown>;
  ciTiers: {
    tiers: Record<string, unknown>;
    when: Record<string, unknown>;
  };
  governance: GovernancePosture;
  mergeIntegration: MergeIntegration;
}

/** Server `GovernancePosture` enum. */
export const GOVERNANCE_POSTURES = ["strict", "open", "audit_only", "lenient"] as const;
export type GovernancePosture = (typeof GOVERNANCE_POSTURES)[number];

/** Server `MergeIntegration` enum. */
export const MERGE_INTEGRATIONS = ["native_queue", "direct_merge", "external_reviewer", "not_configured"] as const;
export type MergeIntegration = (typeof MERGE_INTEGRATIONS)[number];

/** Server `CiWhen` enum values allowed inside a when-policy array. */
const CI_WHEN = new Set(["per_iteration", "pre_audit", "pre_merge"]);

const SEED_TASK_REF_KEYS = new Set(["repo", "sha", "acceptTierHash", "corpusTier"]);
const FROZEN_CONFIG_KEYS = new Set(["routing", "ciTiers", "governance", "mergeIntegration"]);
const CI_TIER_SNAPSHOT_KEYS = new Set(["tiers", "when"]);
const ROUTING_ROLE_KEYS = new Set(["plan", "write", "check", "audit", "demo", "forge"]);

/** Minimum trials per cell (mirrors CreateCellBody z.number().int().min(1)). */
export const MIN_TRIALS_TARGET = 1;

function orgPath(args: ParsedArgs): string {
  return `/orgs/${encodeURIComponent(required(args, "org-id"))}`;
}

/**
 * Parse `--seed-task-ref` JSON into the SeedTaskRef shape the orchestrator expects.
 * Strict: rejects unknown fields (server SeedTaskRef is `.strict()`).
 */
export function parseSeedTaskRef(raw: string): SeedTaskRefInput {
  const value = parseJsonObject(raw, "seed-task-ref");
  rejectUnknownKeys(value, SEED_TASK_REF_KEYS, "--seed-task-ref");
  const repo = requireNonEmptyString(value, "repo", "--seed-task-ref");
  const sha = requireNonEmptyString(value, "sha", "--seed-task-ref");
  const acceptTierHash = requireNonEmptyString(value, "acceptTierHash", "--seed-task-ref");
  const corpusTier = value["corpusTier"];
  if (corpusTier !== 0 && corpusTier !== 1 && corpusTier !== 2) {
    throw new Error("--seed-task-ref.corpusTier must be 0, 1, or 2");
  }
  return { repo, sha, acceptTierHash, corpusTier };
}

/**
 * Parse `--frozen-config` aligned with server `FrozenConfig` (strict top-level
 * keys + required nested structure). Full nested RoutingTable / CiStep detail
 * is still enforced server-side; the CLI fails closed on shape mismatches and
 * unknown fields so typos never silently strip.
 */
export function parseFrozenConfig(raw: string): FrozenConfigInput {
  const value = parseJsonObject(raw, "frozen-config");
  rejectUnknownKeys(value, FROZEN_CONFIG_KEYS, "--frozen-config");

  for (const key of FROZEN_CONFIG_KEYS) {
    if (!(key in value)) {
      throw new Error(`--frozen-config must include field "${key}"`);
    }
  }

  const governance = value["governance"];
  if (typeof governance !== "string" || !GOVERNANCE_POSTURES.includes(governance as GovernancePosture)) {
    throw new Error(`--frozen-config.governance must be one of ${GOVERNANCE_POSTURES.join(", ")}`);
  }

  const mergeIntegration = value["mergeIntegration"];
  if (typeof mergeIntegration !== "string" || !MERGE_INTEGRATIONS.includes(mergeIntegration as MergeIntegration)) {
    throw new Error(`--frozen-config.mergeIntegration must be one of ${MERGE_INTEGRATIONS.join(", ")}`);
  }

  const routing = value["routing"];
  if (!isPlainObject(routing)) {
    throw new Error("--frozen-config.routing must be a JSON object");
  }
  rejectUnknownKeys(routing, ROUTING_ROLE_KEYS, "--frozen-config.routing");
  for (const [role, chainObj] of Object.entries(routing)) {
    if (!isPlainObject(chainObj)) {
      throw new Error(`--frozen-config.routing.${role} must be a JSON object`);
    }
    rejectUnknownKeys(chainObj, new Set(["chain"]), `--frozen-config.routing.${role}`);
    const chain = chainObj["chain"];
    if (chain !== undefined && !Array.isArray(chain)) {
      throw new Error(`--frozen-config.routing.${role}.chain must be an array when present`);
    }
    if (Array.isArray(chain)) {
      for (let i = 0; i < chain.length; i++) {
        const entry = chain[i];
        if (!isPlainObject(entry)) {
          throw new Error(`--frozen-config.routing.${role}.chain[${i}] must be an object`);
        }
        for (const field of ["cli", "model", "authRef"] as const) {
          const v = entry[field];
          if (typeof v !== "string" || v.trim() === "") {
            throw new Error(`--frozen-config.routing.${role}.chain[${i}].${field} must be a non-empty string`);
          }
        }
      }
    }
  }

  const ciTiers = value["ciTiers"];
  if (!isPlainObject(ciTiers)) {
    throw new Error("--frozen-config.ciTiers must be a JSON object");
  }
  rejectUnknownKeys(ciTiers, CI_TIER_SNAPSHOT_KEYS, "--frozen-config.ciTiers");
  if (!("tiers" in ciTiers) || !("when" in ciTiers)) {
    throw new Error('--frozen-config.ciTiers must include "tiers" and "when"');
  }

  const tiers = ciTiers["tiers"];
  if (!isPlainObject(tiers)) {
    throw new Error("--frozen-config.ciTiers.tiers must be a JSON object");
  }
  for (const requiredTier of ["fast", "slow"] as const) {
    const steps = tiers[requiredTier];
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`--frozen-config.ciTiers.tiers.${requiredTier} must be a non-empty array`);
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!isPlainObject(step)) {
        throw new Error(`--frozen-config.ciTiers.tiers.${requiredTier}[${i}] must be an object`);
      }
      if (typeof step["name"] !== "string" || step["name"].trim() === "") {
        throw new Error(`--frozen-config.ciTiers.tiers.${requiredTier}[${i}].name must be a non-empty string`);
      }
      if (typeof step["run"] !== "string" || step["run"].trim() === "") {
        throw new Error(`--frozen-config.ciTiers.tiers.${requiredTier}[${i}].run must be a non-empty string`);
      }
    }
  }
  for (const [tierName, steps] of Object.entries(tiers)) {
    if (tierName === "fast" || tierName === "slow") continue;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error(`--frozen-config.ciTiers.tiers.${tierName} must be a non-empty array`);
    }
  }

  const when = ciTiers["when"];
  if (!isPlainObject(when)) {
    throw new Error("--frozen-config.ciTiers.when must be a JSON object");
  }
  for (const [tierName, points] of Object.entries(when)) {
    if (!Array.isArray(points) || points.length === 0) {
      throw new Error(`--frozen-config.ciTiers.when.${tierName} must be a non-empty array`);
    }
    for (const point of points) {
      if (typeof point !== "string" || !CI_WHEN.has(point)) {
        throw new Error(
          `--frozen-config.ciTiers.when.${tierName} entries must be one of per_iteration, pre_audit, pre_merge`,
        );
      }
    }
  }

  return {
    routing,
    ciTiers: { tiers, when },
    governance: governance as GovernancePosture,
    mergeIntegration: mergeIntegration as MergeIntegration,
  };
}

/**
 * Parse `--trials-target` as an integer >= MIN_TRIALS_TARGET.
 * Matches server CreateCellBody: `z.number().int().min(1)` (no upper bound).
 */
export function parseTrialsTarget(raw: string): number {
  if (!/^-?\d+$/u.test(raw.trim())) {
    throw new Error(`--trials-target must be an integer (got ${JSON.stringify(raw)})`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < MIN_TRIALS_TARGET) {
    throw new Error(`--trials-target must be an integer >= ${MIN_TRIALS_TARGET} (got ${raw})`);
  }
  return n;
}

// ---- Experiments ----

export async function experimentsCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const result = await jsonRequest(`${orgPath(args)}/experiments`, {
    title: required(args, "title"),
    knob: required(args, "knob"),
    hypothesis: required(args, "hypothesis"),
    seedTaskRef: parseSeedTaskRef(required(args, "seed-task-ref")),
  });
  jsonOutput(args, result);
}

export async function experimentsList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  jsonOutput(args, await request(`${orgPath(args)}/experiments`));
}

export async function experimentsGet(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const experimentId = optional(args, "experiment-id") ?? args._[0];
  if (experimentId === undefined) throw new Error("usage: tanren experiments get --experiment-id <id>");
  jsonOutput(args, await request(`${orgPath(args)}/experiments/${encodeURIComponent(experimentId)}`));
}

export async function experimentsRun(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const experimentId = optional(args, "experiment-id");
  const cellId = optional(args, "cell-id");
  if (experimentId === undefined && cellId === undefined) {
    throw new Error("usage: tanren experiments run --experiment-id <id> | --cell-id <id>");
  }
  const path =
    cellId === undefined
      ? `${orgPath(args)}/experiments/${encodeURIComponent(experimentId as string)}/run`
      : `${orgPath(args)}/cells/${encodeURIComponent(cellId)}/run`;
  jsonOutput(args, await jsonRequest(path, {}));
}

export async function experimentsReport(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const cellId = optional(args, "cell-id") ?? args._[0];
  if (cellId === undefined) throw new Error("usage: tanren experiments report --cell-id <id>");
  const result = (await request(`${orgPath(args)}/cells/${encodeURIComponent(cellId)}/scorecard`)) as {
    scorecard: CellScorecard;
  };
  if (isJson(args)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderCellScorecard(result.scorecard));
}

export async function experimentsCompare(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const experimentId = required(args, "experiment-id");
  const cellA = required(args, "cell-a");
  const cellB = required(args, "cell-b");
  const query = `?cellA=${encodeURIComponent(cellA)}&cellB=${encodeURIComponent(cellB)}`;
  const result = (await request(
    `${orgPath(args)}/experiments/${encodeURIComponent(experimentId)}/compare${query}`,
  )) as { cellA: string; cellB: string; comparison: CellComparison };
  if (isJson(args)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderCellComparison(result.comparison, result.cellA, result.cellB));
}

// ---- Cells ----

export async function cellsCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const experimentId = required(args, "experiment-id");
  const result = await jsonRequest(`${orgPath(args)}/experiments/${encodeURIComponent(experimentId)}/cells`, {
    label: required(args, "label"),
    frozenConfig: parseFrozenConfig(required(args, "frozen-config")),
    trialsTarget: parseTrialsTarget(required(args, "trials-target")),
  });
  jsonOutput(args, result);
}

export async function cellsList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const experimentId = required(args, "experiment-id");
  jsonOutput(args, await request(`${orgPath(args)}/experiments/${encodeURIComponent(experimentId)}/cells`));
}

function isJson(args: ParsedArgs): boolean {
  return optional(args, "json") === "true";
}
