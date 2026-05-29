// P3-0016: the read-only recon engine. Composes the injectable `RepoReader`
// (indexes the linked repo READ-ONLY) with the injectable `ReconAnswerer`
// (infers the chapters + gaps). Both seams default so the step is live without
// provider infra and trivially mockable in tests.
//
// NOTHING is persisted here — the recon report is transient (carried on the
// request, like the greenfield capture). The downstream steps (config-injection
// PR, DAG seed) consume the report the operator confirmed.

import { createDeterministicReconAnswerer } from "./defaultReconAnswerer.js";
import { ReconReport, type ReconAnswerer, type ReconIndex, type RepoReader } from "./types.js";

export interface ReconEngineDeps {
  // Indexes the repo. Required — production wires the GitHub reader, tests a fake.
  reader: RepoReader;
  // Injectable/mockable recon Answerer. Defaults to the deterministic fallback.
  answerer?: ReconAnswerer;
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
  const answerer = deps.answerer ?? createDeterministicReconAnswerer();
  const index = await deps.reader.index(repoUrl);
  const report = ReconReport.parse(await answerer.read(index));
  return { index, report };
}
