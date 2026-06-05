// P3-0029 observability: single import surface for the boundary timing layer.
// Latency at the provider / SSH / GitHub adapter boundaries and at workflow
// stage transitions is captured as structured logs — no DB table, no event
// type, no migration. Queue-wait timing is owned by P3-0028 and is not here.
export {
  consoleTimingSink,
  emitStageTiming,
  timed,
  type TimedOptions,
  type TimingBoundary,
  type TimingOutcome,
  type TimingRecord,
  type TimingSink,
} from "./timing.js";

export { TimedCommandSubstrate } from "./timedSubstrate.js";
export { TimedGitHubHttpClient, templatizePath } from "./timedGitHubHttp.js";
export { timedWriterAdapter } from "./timedWriterAdapter.js";
export { timedAnswererAdapter } from "./timedAnswererAdapter.js";
