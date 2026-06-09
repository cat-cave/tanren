// The DeployAdapter registry + `buildDeployAdapter` factory — the single append
// point a new adapter CLASS registers at (mirrors `buildIntegrationProvisioner` /
// `buildAllocator` / `buildVcsProvider`). An adapter class lands as a NEW `case`
// arm (+ its impl + a conformance entry), not a refactor. Today only `direct_api`
// (the Vercel/Fly providers) is registered; `pulumi` / `mobile_release` /
// `package_release` / `manual_external` are DEFERRED (this is the foundational
// slice) — an unregistered kind fails LOUD, never a silent default.

import type { DeployAdapter, UrlReachabilityProbe, VerifyPollPolicy } from "../contracts/deployAdapter.js";
import type { DeployProvisionerDeps } from "../provisioners/deployProvisioner.js";
import { DirectApiDeployAdapter, DIRECT_API_ADAPTER_KIND } from "./directApiDeployAdapter.js";

/** The deps a built DeployAdapter draws (the provisioner wiring + the verify seams). */
export interface BuildDeployAdapterDeps {
  /** The deploy provisioner deps (transport + secrets) the wrapped providers run over. */
  provisioner: DeployProvisionerDeps;
  /** The URL smoke-check probe verify runs (defaults to the real fetch probe). */
  urlProbe?: UrlReachabilityProbe;
  /** The verify poll cadence + bound (defaults to the production cadence). */
  poll?: VerifyPollPolicy;
}

/**
 * Select + construct the DeployAdapter for an adapter-class `kind`. `direct_api`
 * wraps the Vercel/Fly provisioners; any other kind is DEFERRED and throws LOUD
 * (the foundational slice ships only `direct_api`). A new class slots in as a new
 * case here.
 */
export function buildDeployAdapter(kind: string, deps: BuildDeployAdapterDeps): DeployAdapter {
  switch (kind) {
    case DIRECT_API_ADAPTER_KIND:
      return new DirectApiDeployAdapter({
        provisioner: deps.provisioner,
        urlProbe: deps.urlProbe ?? fetchUrlReachabilityProbe(),
        poll: deps.poll ?? defaultVerifyPollPolicy(),
      });
    default:
      throw new Error(
        `buildDeployAdapter: adapter class '${kind}' is not implemented yet ` +
          `(the foundational slice ships only '${DIRECT_API_ADAPTER_KIND}'; pulumi / mobile_release / package_release / manual_external are deferred)`,
      );
  }
}

/**
 * The default URL smoke-probe timeout (ms). Bounds the verify smoke check so a deploy
 * URL that hangs (a half-up server that accepts the connection but never responds)
 * aborts LOUD rather than wedging the verify poll indefinitely.
 */
export const DEFAULT_SMOKE_PROBE_TIMEOUT_MS = 15_000;

/**
 * The production URL smoke probe: a real `fetch` GET that resolves to the observed
 * HTTP status (a transport-level failure — DNS/connection — propagates as a throw,
 * which verify treats as not-reachable). The request is bounded by
 * {@link DEFAULT_SMOKE_PROBE_TIMEOUT_MS} via an AbortSignal so a hung URL aborts rather
 * than hanging. No secret material is involved; the URL is the resolved public
 * preview/deploy URL.
 */
export function fetchUrlReachabilityProbe(
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_SMOKE_PROBE_TIMEOUT_MS,
): UrlReachabilityProbe {
  return {
    async probe(url: string): Promise<number> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal });
        return response.status;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`deploy smoke probe: GET '${url}' timed out after ${String(timeoutMs)}ms`, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The production verify poll cadence: bounded polls at a fixed interval with a real
 * `setTimeout` sleep. The bound is the never-ready guard — a deployment that never
 * goes READY fails LOUD after `maxPolls` rather than hanging.
 */
export function defaultVerifyPollPolicy(): VerifyPollPolicy {
  return {
    maxPolls: 60,
    intervalMs: 5000,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}
