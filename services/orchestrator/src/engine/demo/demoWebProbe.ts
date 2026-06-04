// The production `DemoWebProbe`: a real `fetch` GET that resolves to the observed
// HTTP status, used by the demo engine to exercise a `web_url` behavior's route. A
// transport-level failure (DNS/connection) propagates as a throw, which the demo
// engine records as a FAILED behavior (the route did not answer). No secret material
// is involved — the URL is the resolved public deploy URL + the behavior's route.
//
// Kept as a tiny standalone factory (mirrors `fetchUrlReachabilityProbe`) so the
// watcher's boot imports ONE symbol and stays under the dependency cap.

import type { DemoWebProbe } from "./demoEvidence.js";

/** Build the production demo web probe — a real `fetch` GET returning the HTTP status. */
export function fetchDemoWebProbe(fetchImpl: typeof fetch = fetch): DemoWebProbe {
  return {
    async reach(url: string): Promise<number> {
      const response = await fetchImpl(url, { method: "GET", redirect: "manual" });
      return response.status;
    },
  };
}
