// A scripted `UrlReachabilityProbe` (TEST FIXTURE — tests/ only): the DeployAdapter
// `verify` smoke step runs against this instead of a live network call, so the
// conformance suite proves the URL smoke check WITHOUT real HTTP. It returns a fixed
// status (default 200) and records every URL it probed so a test can assert verify
// smoke-checked the RESOLVED deploy URL — and an instant (0-ms) poll cadence so the
// unbounded verify poll loop runs with no real timers.

import type { UrlReachabilityProbe, VerifyPollPolicy } from "../../../src/engine/contracts/deployAdapter.js";

export interface ScriptedUrlProbe extends UrlReachabilityProbe {
  /** Every URL the probe was asked to reach (so a test can assert the resolved URL was smoked). */
  probed: string[];
}

/** Build a probe that always returns `status` (default 200 = reachable) and records URLs. */
export function scriptedUrlProbe(status = 200): ScriptedUrlProbe {
  const probed: string[] = [];
  return {
    probed,
    // eslint-disable-next-line @typescript-eslint/require-await
    async probe(url: string): Promise<number> {
      probed.push(url);
      return status;
    },
  };
}

/**
 * A probe that returns a SCRIPTED sequence of statuses on successive probes (the last entry
 * repeats once exhausted), so a test can drive the manual-external verify through a sequence
 * of UNREACHABLE statuses that finally resolves to reachable — proving the poll-until-reachable
 * loop is unbounded while the status advances.
 */
export function sequencedUrlProbe(statuses: number[]): ScriptedUrlProbe {
  const probed: string[] = [];
  let served = 0;
  return {
    probed,
    // eslint-disable-next-line @typescript-eslint/require-await
    async probe(url: string): Promise<number> {
      probed.push(url);
      const status = statuses[Math.min(served, statuses.length - 1)] ?? 200;
      served += 1;
      return status;
    },
  };
}

/**
 * A verify poll policy with an INSTANT (0-ms) cadence — the unbounded poll-until-terminal
 * loop runs with no real timers in tests. There is NO poll count: the loop succeeds on a
 * READY terminal, fails on a provider ERROR terminal, and escalates only on a PROVEN stuck
 * (non-advancing) state. The deployment script's terminal/advancing states drive it.
 */
export function instantVerifyPollPolicy(): VerifyPollPolicy {
  return { intervalMs: 0 };
}
