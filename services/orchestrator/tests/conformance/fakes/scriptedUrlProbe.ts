// A scripted `UrlReachabilityProbe` (TEST FIXTURE — tests/ only): the DeployAdapter
// `verify` smoke step runs against this instead of a live network call, so the
// conformance suite proves the URL smoke check WITHOUT real HTTP. It returns a fixed
// status (default 200) and records every URL it probed so a test can assert verify
// smoke-checked the RESOLVED deploy URL — and an instant no-op `sleep` so the verify
// poll loop runs with no real timers.

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

/** A bounded verify poll policy with an INSTANT (no-real-timer) sleep, for tests. */
export function instantVerifyPollPolicy(maxPolls = 10): VerifyPollPolicy {
  return {
    maxPolls,
    intervalMs: 0,
    // eslint-disable-next-line @typescript-eslint/require-await
    sleep: async () => {
      /* no-op: tests advance instantly */
    },
  };
}
