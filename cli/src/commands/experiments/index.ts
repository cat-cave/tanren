// `tanren experiments ...` + `tanren cells ...` commands — the benchmark
// report/CRUD surface (docs/roadmap/tanren-method-benchmark.md §4.2.4). Authors
// experiments + cells, triggers a run (the orchestrator's scheduler), and reads
// cell scorecards (`report`) + cell-vs-cell comparisons (`compare`). CRUD verbs
// print the raw JSON (the default); `report` / `compare` render a table for an
// operator and honor `--json` to print the raw response instead.

import { parseJsonObject, requireNonEmptyString } from "../../json.js";
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

/** Minimum trials per cell (mirrors DB check + CreateCellBody z.number().int().min(1)). */
export const MIN_TRIALS_TARGET = 1;

/** Soft upper bound so typos like 1000000 fail fast at the CLI. */
export const MAX_TRIALS_TARGET = 10_000;

function orgPath(args: ParsedArgs): string {
  return `/orgs/${encodeURIComponent(required(args, "org-id"))}`;
}

/**
 * Parse `--seed-task-ref` JSON into the SeedTaskRef shape the orchestrator expects.
 * Rejects non-objects, missing fields, and corpusTier outside {0,1,2}.
 */
export function parseSeedTaskRef(raw: string): SeedTaskRefInput {
  const value = parseJsonObject(raw, "seed-task-ref");
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
 * Parse `--frozen-config` as a plain JSON object. Full FrozenConfig shape is
 * enforced server-side; the CLI only rejects non-objects / invalid JSON.
 */
export function parseFrozenConfig(raw: string): Record<string, unknown> {
  return parseJsonObject(raw, "frozen-config");
}

/**
 * Parse `--trials-target` as an integer in [MIN_TRIALS_TARGET, MAX_TRIALS_TARGET].
 */
export function parseTrialsTarget(raw: string): number {
  if (!/^-?\d+$/u.test(raw.trim())) {
    throw new Error(`--trials-target must be an integer (got ${JSON.stringify(raw)})`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < MIN_TRIALS_TARGET || n > MAX_TRIALS_TARGET) {
    throw new Error(
      `--trials-target must be an integer between ${MIN_TRIALS_TARGET} and ${MAX_TRIALS_TARGET} (got ${raw})`,
    );
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
