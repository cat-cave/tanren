// `tanren experiments ...` + `tanren cells ...` commands — the benchmark
// report/CRUD surface (docs/roadmap/tanren-method-benchmark.md §4.2.4). Authors
// experiments + cells, triggers a run (the orchestrator's scheduler), and reads
// cell scorecards (`report`) + cell-vs-cell comparisons (`compare`). CRUD verbs
// print the raw JSON (the default); `report` / `compare` render a table for an
// operator and honor `--json` to print the raw response instead.

import { jsonRequest, request } from "../../httpClient.js";
import { jsonOutput, optional, parseArgs, required, type ParsedArgs } from "../args.js";
import { renderCellComparison, renderCellScorecard, type CellComparison, type CellScorecard } from "./render.js";

function orgPath(args: ParsedArgs): string {
  return `/orgs/${encodeURIComponent(required(args, "org-id"))}`;
}

// ---- Experiments ----

export async function experimentsCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const result = await jsonRequest(`${orgPath(args)}/experiments`, {
    title: required(args, "title"),
    knob: required(args, "knob"),
    hypothesis: required(args, "hypothesis"),
    seedTaskRef: JSON.parse(required(args, "seed-task-ref")) as unknown,
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
    frozenConfig: JSON.parse(required(args, "frozen-config")) as unknown,
    trialsTarget: Number.parseInt(required(args, "trials-target"), 10),
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
