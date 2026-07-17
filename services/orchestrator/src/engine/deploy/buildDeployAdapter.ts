// The DeployAdapter registry + `buildDeployAdapter` factory — the single append
// point a new adapter CLASS registers at (mirrors `buildIntegrationProvisioner` /
// `buildAllocator` / `buildVcsProvider`). An adapter class lands as a NEW `case`
// arm (+ its impl + a conformance entry), not a refactor.
//
// PRODUCTION CATALOG (Codex H3 #22 closure): the registered PRODUCTION classes are
// exactly the two with a CONCRETE driver on `main`:
//   - `direct_api` — wraps the Vercel + Fly `DeployProvisioner` subclasses (web_url).
//   - `manual_external` — operator-attested out-of-band delivery over the durable
//     `PgManualAttestationStore` (web_url / download).
//
// FIXTURE-ONLY, NOT PRODUCTION: the `pulumi`, `package_release`, and `mobile_release`
// adapter CLASSES exist on disk (each with a scripted conformance suite) but their
// external drivers (`PulumiStackRunner`, `PackageRegistryClient`,
// `MobileDistributionClient`) have NO concrete production impl — only scripted test
// fakes. Registering them in the production catalog would produce the exact
// injectable-seam silent-error surface Codex H3 #22 flagged: `buildDeployAdapter`
// would succeed at project-create time, then throw `DeployAdapterConfigError` at
// deploy time when the driver hadn't been wired (because it CAN'T be wired — no
// impl exists). We refuse them LOUDLY at the factory instead, so a persisted
// `deploy.pulumi` / `deploy.package_release` / `deploy.mobile_release` provider is
// diagnosed at project-create rather than turning into a mystery deploy-time crash.
// Tests that exercise these classes construct them directly via `new
// PulumiDeployAdapter({...})` / `new PackageReleaseDeployAdapter({...})` / `new
// MobileReleaseDeployAdapter({...})` (no factory-shaped injection seam). To add one
// of these classes to production, land the concrete driver + register the case arm
// in ONE PR — that is the "fragment-only, nothing deferred" doctrine.
//
// EXTERNAL-DRIVER DEPS: the `manual_external` class runs over an injectable durable
// attestation store. The factory requires the relevant driver to be WIRED for the
// kind being built; an absent driver fails LOUD with a typed
// {@link DeployAdapterConfigError} (the correct "unconfigured" behavior, NOT a stub
// default).
//
// Codex H3 Surface 7 finding #20 CLOSURE: the `manual_external` class ALSO fails LOUD
// on an absent attestation store. There is NO in-memory default anymore — the pre-fix
// default silently sank every operator attestation into a process-local `Map` that
// lost the row on restart. Production wiring MUST supply a durable
// `PgManualAttestationStore` PLUS the tenant scope (`ownerScope`) each attestation is
// keyed under; the in-memory impl is TEST-ONLY.

import type { DeployAdapter, UrlReachabilityProbe, VerifyPollPolicy } from "../contracts/deployAdapter.js";
import type { DeployProvisionerDeps } from "../provisioners/deployProvisioner.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { DirectApiDeployAdapter, DIRECT_API_ADAPTER_KIND } from "./directApiDeployAdapter.js";
// The pulumi / package_release / mobile_release adapter CLASSES + KIND constants are
// exported by their modules; the factory intentionally does NOT register them (see
// the "FIXTURE-ONLY, NOT PRODUCTION" header note). The constants are imported here
// ONLY so the fixture-only diagnostic in `buildDeployAdapter` can name them precisely
// when a caller asks for one — a caller that got a stale `deploy.pulumi` from a DB
// row sees "adapter class 'pulumi' is fixture-only" rather than the generic "not
// registered", which is the correct operator-facing diagnosis.
import { PULUMI_ADAPTER_KIND } from "./pulumiDeployAdapter.js";
import { PACKAGE_RELEASE_ADAPTER_KIND } from "./packageReleaseDeployAdapter.js";
import { MOBILE_RELEASE_ADAPTER_KIND } from "./mobileReleaseDeployAdapter.js";
import {
  ManualExternalDeployAdapter,
  MANUAL_EXTERNAL_ADAPTER_KIND,
  MANUAL_EXTERNAL_PROVIDER_KIND,
  type ManualAttestationStore,
} from "./manualExternalDeployAdapter.js";
import type { EventStore } from "../eventStore.js";
import { DeployAdapterConfigError } from "./deployAdapterErrors.js";
import type pg from "pg";
import { PgReleaseInstancesRepository, type ReleaseInstancesRepository } from "../repositories/index.js";

export { DIRECT_API_ADAPTER_KIND } from "./directApiDeployAdapter.js";

/**
 * The adapter classes whose implementations exist on disk (with a scripted
 * conformance suite) but whose external drivers have no concrete production impl,
 * so they are NOT part of the production catalog. Selecting one via
 * `buildDeployAdapter` throws a clear "fixture-only" diagnostic. Tests exercise
 * them via direct `new PulumiDeployAdapter({...})` etc. — no factory-shaped
 * injection seam that would create the same silent-error surface Codex H3 #22
 * flagged. See the module header for the doctrine + the migration path.
 */
const FIXTURE_ONLY_ADAPTER_KINDS: ReadonlySet<string> = new Set<string>([
  PULUMI_ADAPTER_KIND,
  PACKAGE_RELEASE_ADAPTER_KIND,
  MOBILE_RELEASE_ADAPTER_KIND,
]);

/** The deps a built DeployAdapter draws (the provisioner wiring + the verify seams). */
export interface BuildDeployAdapterDeps {
  /** The deploy provisioner deps (transport + secrets) the `direct_api` class runs over. */
  provisioner: DeployProvisionerDeps;
  /** The URL smoke-check probe verify runs (defaults to the real fetch probe). */
  urlProbe?: UrlReachabilityProbe;
  /** The verify poll cadence (the spacing between polls; defaults to the production cadence). */
  poll?: VerifyPollPolicy;
  /** Runtime pool used to construct durable direct-api release persistence. */
  pool?: pg.Pool;
  /** Test seam for a durable direct-api release repository; production normally supplies `pool`. */
  releaseInstances?: ReleaseInstancesRepository;
  /** Scalar integration-node lineage used when building outside a preview input. */
  integrationNodeId?: string;
  /**
   * The SecretStore the `manual_external` class resolves refs against. Defaults to
   * the provisioner deps' secrets when omitted (they share one store). Retained as
   * an override for tests that pass a separate store to assert isolation.
   */
  secrets?: SecretStore;
  /**
   * The durable manual-attestation store (REQUIRED to build the `manual_external`
   * class — no in-memory default; Codex H3 #20). Production wires
   * `PgManualAttestationStore`.
   */
  manualAttestations?: ManualAttestationStore;
  /**
   * The tenant scope the `manual_external` adapter records attestations under
   * (REQUIRED to build that class). An unscoped adapter would silently write
   * cross-tenant rows / read the wrong rows.
   */
  manualOwnerScope?: { orgId: string; projectId: string };
  /**
   * The event store the `manual_external` adapter emits `deploy.pending_manual` /
   * `deploy.manual_confirmed` into. OPTIONAL — omitted only for pure-store /
   * pure-adapter unit tests that assert the persistence contract without the
   * event tail; production wiring supplies it so the operator-facing wake reaches
   * the notification route.
   */
  manualEvents?: EventStore;
  /** The optional per-run bindings the emitted manual_external events carry. */
  manualRunBindings?: { runId?: string };
}

/** The class kinds the production catalog registers — for the diagnostic below. */
const PRODUCTION_ADAPTER_KINDS: readonly string[] = [DIRECT_API_ADAPTER_KIND, MANUAL_EXTERNAL_ADAPTER_KIND];

/**
 * Select + construct the DeployAdapter for an adapter-class `kind`. Each registered
 * class wraps its provider surface. Codex H3 #22 closure: the catalog registers ONLY
 * the classes with concrete drivers on `main` — `direct_api` (Vercel + Fly) and
 * `manual_external` (over `PgManualAttestationStore`). Selecting a FIXTURE-ONLY class
 * (`pulumi` / `package_release` / `mobile_release`) throws a clear diagnostic; an
 * UNREGISTERED kind fails LOUD too (never a silent default). The `manual_external`
 * class requires its durable store + tenant scope to be wired — an absent driver
 * throws a typed {@link DeployAdapterConfigError}.
 */
export function buildDeployAdapter(kind: string, deps: BuildDeployAdapterDeps): DeployAdapter {
  const urlProbe = deps.urlProbe ?? fetchUrlReachabilityProbe();
  const poll = deps.poll ?? defaultVerifyPollPolicy();
  if (FIXTURE_ONLY_ADAPTER_KINDS.has(kind)) {
    throw new Error(
      `buildDeployAdapter: adapter class '${kind}' is fixture-only — its external driver ` +
        `(PulumiStackRunner / PackageRegistryClient / MobileDistributionClient) has no concrete ` +
        `production impl on 'main', so the class is NOT registered in the production catalog. ` +
        `Tests exercise it via 'new PulumiDeployAdapter({...})' / 'new PackageReleaseDeployAdapter({...})' / ` +
        `'new MobileReleaseDeployAdapter({...})' directly. To promote it, land the concrete driver + ` +
        `register the case arm in ONE PR. Registered production kinds: ` +
        PRODUCTION_ADAPTER_KINDS.map((k) => `'${k}'`).join(", "),
    );
  }
  switch (kind) {
    case DIRECT_API_ADAPTER_KIND:
      if (deps.releaseInstances === undefined && deps.pool === undefined) {
        throw new DeployAdapterConfigError(
          DIRECT_API_ADAPTER_KIND,
          "pool",
          "wire the runtime pool (or a durable releaseInstances repository) so direct_api lifecycle writes cannot be skipped",
        );
      }
      return new DirectApiDeployAdapter({
        provisioner: deps.provisioner,
        urlProbe,
        poll,
        releaseInstances: deps.releaseInstances ?? new PgReleaseInstancesRepository(deps.pool!),
        ...(deps.integrationNodeId === undefined ? {} : { integrationNodeId: deps.integrationNodeId }),
      });
    case MANUAL_EXTERNAL_ADAPTER_KIND: {
      if (deps.manualAttestations === undefined) {
        throw new DeployAdapterConfigError(
          MANUAL_EXTERNAL_ADAPTER_KIND,
          "manualAttestations",
          "wire a durable PgManualAttestationStore (see services/orchestrator/src/engine/deploy/pgManualAttestationStore.ts) — the in-memory impl is TEST-ONLY, Codex H3 #20 forbids a process-local default",
        );
      }
      if (deps.manualOwnerScope === undefined) {
        throw new DeployAdapterConfigError(
          MANUAL_EXTERNAL_ADAPTER_KIND,
          "manualOwnerScope",
          "wire the tenant scope (orgId + projectId) each manual_external attestation is recorded under — an unscoped adapter would silently write cross-tenant rows",
        );
      }
      return new ManualExternalDeployAdapter({
        attestations: deps.manualAttestations,
        urlProbe,
        poll,
        ownerScope: deps.manualOwnerScope,
        ...(deps.manualEvents === undefined ? {} : { events: deps.manualEvents }),
        ...(deps.manualRunBindings === undefined ? {} : { runBindings: deps.manualRunBindings }),
      });
    }
    default:
      throw new Error(
        `buildDeployAdapter: adapter class '${kind}' is not a registered deploy adapter ` +
          `(registered: ${PRODUCTION_ADAPTER_KINDS.map((k) => `'${k}'`).join(", ")})`,
      );
  }
}

/**
 * Map a `deploy.<provider>` provider kind (the value stamped onto a `DeployRef.provider`
 * and recorded on `deploy.triggered` / `deploy.verified`) to the DeployAdapter CLASS
 * that owns it — the seam that lets a caller (e.g. the demo-on-deploy watcher) DISPATCH
 * to the RIGHT adapter's `demoSurface` from a persisted provider kind, without hard-wiring
 * to `direct_api`.
 *
 * REGISTERED (production catalog):
 *   • `deploy.vercel` / `deploy.flyio` → `direct_api`
 *   • `deploy.manual_external`         → `manual_external`
 *
 * NOT REGISTERED (fixture-only, Codex H3 #22): `deploy.pulumi`,
 * `deploy.package_release`, `deploy.mobile_release`. Their adapter classes have no
 * concrete production driver on `main`, so mapping them here would produce a
 * "you can select the class, but you can't build it" split — the exact latent-error
 * shape the #22 fix targets. Any persisted `deploy.pulumi` / `deploy.package_release`
 * / `deploy.mobile_release` throws LOUD from this seam (the demo-on-deploy watcher
 * catches the throw + emits `demo.failed` with reason `resolve_surface_failed`).
 *
 * An UNKNOWN provider kind throws LOUD — never a silent default to `direct_api`.
 */
export function adapterKindForProviderKind(providerKind: string): string {
  switch (providerKind) {
    case "deploy.vercel":
    case "deploy.flyio":
      return DIRECT_API_ADAPTER_KIND;
    case MANUAL_EXTERNAL_PROVIDER_KIND:
      return MANUAL_EXTERNAL_ADAPTER_KIND;
    default:
      throw new Error(
        `adapterKindForProviderKind: provider kind '${providerKind}' has no registered DeployAdapter class ` +
          `(registered: 'deploy.vercel', 'deploy.flyio', '${MANUAL_EXTERNAL_PROVIDER_KIND}'). ` +
          `The pulumi / package_release / mobile_release provider kinds are fixture-only — their adapter ` +
          `classes have no concrete production driver on 'main' (Codex H3 #22).`,
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
      // Blessed connect/response-establishment bound on ONE smoke-probe HTTP GET (per the
      // DEFAULT_SMOKE_PROBE_ABORT_MS docstring above): not a poll/attempt budget over
      // converging work — a discrete one-shot probe whose only outcomes are (response |
      // abort), so the abort cannot truncate legitimate work.
      const timer = setTimeout(() => {
        // arch-allow: timeout-class — see comment above
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
