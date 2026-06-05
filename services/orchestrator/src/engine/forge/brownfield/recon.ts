// the read-only recon engine. Composes the injectable `RepoReader`
// (indexes the linked repo READ-ONLY) with the `ReconAnswerer` (reconstructs the
// chapters + gaps from the indexed evidence).
//
// NOTHING is persisted here — the recon report is transient (carried on the
// request, like the greenfield capture). The downstream steps (config-injection
// PR, DAG seed) consume the report the operator confirmed.

import { ReconReport, type ReconAnswerer, type ReconIndex, type RepoReader } from "./types.js";

export interface ReconEngineDeps {
  // Indexes the repo. Required — production wires the GitHub reader, tests a fake.
  reader: RepoReader;
  // The recon Answerer — REQUIRED. Production resolves a real provider answerer
  // from the project's `forge` routing (the model RECONSTRUCTS the chapters from
  // the indexed evidence); tests inject a fake. There is NO production fallback
  // to a deterministic report (§8a).
  answerer: ReconAnswerer;
}

export interface RunReconResult {
  index: ReconIndex;
  report: ReconReport;
}

/**
 * Run a read-only recon pass: index the repo, then have the Answerer pre-fill
 * the chapters + gaps. The report is validated at the engine boundary (defence
 * in depth; a provider that drifts from the schema is normalized/rejected).
 */
export async function runRecon(deps: ReconEngineDeps, repoUrl: string): Promise<RunReconResult> {
  const index = await deps.reader.index(repoUrl);
  const report = ReconReport.parse(await deps.answerer.read(index));
  return { index, report };
}
