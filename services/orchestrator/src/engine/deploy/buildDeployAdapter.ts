// The DeployAdapter registry + `buildDeployAdapter` factory — the single append
// point a new adapter CLASS registers at (mirrors `buildIntegrationProvisioner` /
// `buildAllocator` / `buildVcsProvider`). An adapter class lands as a NEW `case`
// arm (+ its impl + a conformance entry), not a refactor. The registered classes:
// `direct_api` (the Vercel/Fly providers, web_url), `pulumi` (an IaC stack up/refresh,
// web_url), `package_release` (publish to a registry, package), `mobile_release`
// (submit to an app channel, app_channel), and `manual_external` (operator-attested
// out-of-band delivery, web_url/download). An UNREGISTERED kind fails LOUD, never a
// silent default.
//
// EXTERNAL-DRIVER DEPS: the non-`direct_api` classes each run over an injectable
// external driver (a Pulumi stack runner, a package registry client, a mobile
// distribution client, a manual-attestation store). The factory requires the relevant
// driver to be WIRED for the kind being built; an absent driver fails LOUD with a typed
// {@link DeployAdapterConfigError} (the correct "unconfigured" behavior, NOT a stub
// default). The single exception is the manual-attestation store, which defaults to the
// real in-process {@link InMemoryManualAttestationStore} (a genuine store — manual_external
// attestations are non-secret and process-local within a check), never a stand-in.

import type { DeployAdapter, UrlReachabilityProbe, VerifyPollPolicy } from "../contracts/deployAdapter.js";
import type { DeployProvisionerDeps } from "../provisioners/deployProvisioner.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { DirectApiDeployAdapter, DIRECT_API_ADAPTER_KIND } from "./directApiDeployAdapter.js";
import { PulumiDeployAdapter, PULUMI_ADAPTER_KIND, type PulumiStackRunner } from "./pulumiDeployAdapter.js";
import {
  PackageReleaseDeployAdapter,
  PACKAGE_RELEASE_ADAPTER_KIND,
  type PackageRegistryClient,
} from "./packageReleaseDeployAdapter.js";
import {
  MobileReleaseDeployAdapter,
  MOBILE_RELEASE_ADAPTER_KIND,
  type MobileDistributionClient,
} from "./mobileReleaseDeployAdapter.js";
import {
  InMemoryManualAttestationStore,
  ManualExternalDeployAdapter,
  MANUAL_EXTERNAL_ADAPTER_KIND,
  type ManualAttestationStore,
} from "./manualExternalDeployAdapter.js";
import { DeployAdapterConfigError } from "./deployAdapterErrors.js";

/** The deps a built DeployAdapter draws (the provisioner wiring + the verify seams). */
export interface BuildDeployAdapterDeps {
  /** The deploy provisioner deps (transport + secrets) the wrapped providers run over. */
  provisioner: DeployProvisionerDeps;
  /** The URL smoke-check probe verify runs (defaults to the real fetch probe). */
  urlProbe?: UrlReachabilityProbe;
  /** The verify poll cadence (the spacing between polls; defaults to the production cadence). */
  poll?: VerifyPollPolicy;
  /**
   * The SecretStore the non-`direct_api` classes resolve their provider token from.
   * Defaults to the provisioner deps' secrets when omitted (they share one store).
   */
  secrets?: SecretStore;
  /** The Pulumi stack driver (required to build the `pulumi` class). */
  pulumiRunner?: PulumiStackRunner;
  /** The package registry client (required to build the `package_release` class). */
  packageRegistry?: PackageRegistryClient;
  /** The mobile distribution client (required to build the `mobile_release` class). */
  mobileDistribution?: MobileDistributionClient;
  /** The manual-attestation store (defaults to the in-process store for `manual_external`). */
  manualAttestations?: ManualAttestationStore;
}

/**
 * Select + construct the DeployAdapter for an adapter-class `kind`. Each registered
 * class wraps its provider surface; an UNREGISTERED kind fails LOUD (never a silent
 * default). The non-`direct_api` classes require their external driver to be wired —
 * an absent driver throws a typed {@link DeployAdapterConfigError}.
 */
export function buildDeployAdapter(kind: string, deps: BuildDeployAdapterDeps): DeployAdapter {
  const urlProbe = deps.urlProbe ?? fetchUrlReachabilityProbe();
  const poll = deps.poll ?? defaultVerifyPollPolicy();
  const secrets = deps.secrets ?? deps.provisioner.secrets;
  switch (kind) {
    case DIRECT_API_ADAPTER_KIND:
      return new DirectApiDeployAdapter({ provisioner: deps.provisioner, urlProbe, poll });
    case PULUMI_ADAPTER_KIND: {
      if (deps.pulumiRunner === undefined) {
        throw new DeployAdapterConfigError(
          PULUMI_ADAPTER_KIND,
          "pulumiRunner",
          "wire a PulumiStackRunner (a Pulumi Automation-API / CLI driver over the substrate) into buildDeployAdapter deps",
        );
      }
      return new PulumiDeployAdapter({ runner: deps.pulumiRunner, secrets, urlProbe, poll });
    }
    case PACKAGE_RELEASE_ADAPTER_KIND: {
      if (deps.packageRegistry === undefined) {
        throw new DeployAdapterConfigError(
          PACKAGE_RELEASE_ADAPTER_KIND,
          "packageRegistry",
          "wire a PackageRegistryClient (a registry publish/read driver) into buildDeployAdapter deps",
        );
      }
      return new PackageReleaseDeployAdapter({ registry: deps.packageRegistry, secrets, poll });
    }
    case MOBILE_RELEASE_ADAPTER_KIND: {
      if (deps.mobileDistribution === undefined) {
        throw new DeployAdapterConfigError(
          MOBILE_RELEASE_ADAPTER_KIND,
          "mobileDistribution",
          "wire a MobileDistributionClient (an App Store Connect / Play / Firebase driver) into buildDeployAdapter deps",
        );
      }
      return new MobileReleaseDeployAdapter({ distribution: deps.mobileDistribution, secrets, poll });
    }
    case MANUAL_EXTERNAL_ADAPTER_KIND:
      return new ManualExternalDeployAdapter({
        attestations: deps.manualAttestations ?? new InMemoryManualAttestationStore(),
        urlProbe,
        poll,
      });
    default:
      throw new Error(
        `buildDeployAdapter: adapter class '${kind}' is not a registered deploy adapter ` +
          `(registered: '${DIRECT_API_ADAPTER_KIND}', '${PULUMI_ADAPTER_KIND}', '${PACKAGE_RELEASE_ADAPTER_KIND}', ` +
          `'${MOBILE_RELEASE_ADAPTER_KIND}', '${MANUAL_EXTERNAL_ADAPTER_KIND}')`,
      );
  }
}

/**
 * The default per-request ABORT window (ms) for ONE smoke-probe HTTP GET — the blessed
 * connect/response-establishment bound (feedback_no_timeouts_progress_based: a single-request
 * fetch abort is NOT a poll/attempt budget). Bounds the smoke check so a deploy URL that hangs
 * (a half-up server that accepts the connection but never responds) aborts LOUD rather than
 * wedging the verify poll. It does NOT cap how many polls verify issues — that loop is
 * unbounded poll-until-terminal.
 */
export const DEFAULT_SMOKE_PROBE_ABORT_MS = 15_000;

/**
 * The production URL smoke probe: a real `fetch` GET that resolves to the observed
 * HTTP status (a transport-level failure — DNS/connection — propagates as a throw,
 * which verify treats as not-reachable). The request is bounded by
 * {@link DEFAULT_SMOKE_PROBE_ABORT_MS} via an AbortSignal so a hung URL aborts rather
 * than hanging. No secret material is involved; the URL is the resolved public
 * preview/deploy URL.
 */
export function fetchUrlReachabilityProbe(
  fetchImpl: typeof fetch = fetch,
  abortMs: number = DEFAULT_SMOKE_PROBE_ABORT_MS,
): UrlReachabilityProbe {
  return {
    async probe(url: string): Promise<number> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, abortMs);
      try {
        const response = await fetchImpl(url, { method: "GET", redirect: "manual", signal: controller.signal });
        return response.status;
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`deploy smoke probe: GET '${url}' aborted after ${String(abortMs)}ms`, { cause: error });
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * The production verify poll CADENCE: polls spaced at a fixed interval. There is NO poll
 * COUNT and NO deadline (feedback_no_timeouts_progress_based) — `verify` polls UNBOUNDED
 * while the provider state advances and fails LOUD only on a provider ERROR terminal or a
 * PROVEN stuck (non-advancing) state. The interval is the legitimate spacing between polls.
 */
export function defaultVerifyPollPolicy(): VerifyPollPolicy {
  return { intervalMs: 5000 };
}
