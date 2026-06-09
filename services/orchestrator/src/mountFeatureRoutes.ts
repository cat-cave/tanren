// The orchestrator's feature-route mount table, extracted from `buildApp` in
// main.ts. `buildApp` owns app construction, auth, the inline run/spec/CI
// handlers, and lifecycle; this module owns the long, declarative list of
// `app.route(...)` registrations for the create*Routes factories. Splitting it
// out keeps main.ts's import count and `buildApp`'s length focused without
// changing any wiring — every registration here is byte-for-byte the prior
// inline call, in the same order.

import type { Hono } from "hono";
import type pg from "pg";
import { orgScopingPool } from "./engine/data/orgScopedDb.js";
import type { Allocator, SecretStore, CommandSubstrate } from "./engine/contracts/index.js";
import { buildForgeRouteAnswererFactories } from "./engine/forge/routeFactories.js";
import type { GitHubHttpClient } from "./engine/providers/github.js";
import type { VcsProvider } from "./engine/contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "./engine/providers/githubAppTokenMinter.js";
import { mountGithubAppInstallFromEnv } from "./routes/auth/githubAppInstall.js";
import { createBehaviorRoutes } from "./routes/behaviors/index.js";
import { mountBrownfieldRoutes } from "./routes/brownfield/mount.js";
import { createCredentialRoutes, type CredentialRegistry } from "./routes/credentials/index.js";
import { createDiscoveryRoutes } from "./routes/discovery/index.js";
import { createDoctorRoutes } from "./routes/doctor/index.js";
import { mountReportRoutes, type MountReportRoutesDeps } from "./routes/experiments/mount.js";
import { createForgeAskRoutes, createForgeProposalRoutes, createForgeRoutes } from "./routes/forge/mount.js";
import { createInboxRoutes } from "./routes/inbox/index.js";
import {
  buildCreateForNoMatch,
  buildCreateTemplateFlow,
  createAuditRoutes,
  createTemplateRoutes,
} from "./routes/audits/index.js";
import { createIssueWebhookRoutes } from "./routes/githubWebhooks/index.js";
import { createInsightRoutes } from "./routes/insights/index.js";
import { createIntegrationRoutes } from "./routes/integrations/index.js";
import { createMilestoneRoutes } from "./routes/milestones/index.js";
import { createNotificationRoutes } from "./routes/notifications/index.js";
import { createOnboardingRoutes } from "./routes/onboarding/index.js";
import {
  createAiProviderRoutes,
  type ConfigGateGithubFactory,
  createGithubConnectRoutes,
  createOrgRoutes,
} from "./routes/orgs/index.js";
import { createPersonaRoutes } from "./routes/personas/index.js";
import { createProjectRoutes } from "./routes/projects/index.js";
import { createRecoveryRoutes } from "./routes/recovery/index.js";
import { createRunRoutes } from "./routes/runs/index.js";
import { createSpecRoutes } from "./routes/specs/index.js";
import type { ActorContextEnv } from "./middleware/auth.js";

/** The benchmark scheduler's live infra (the route supplies the pool itself). */
export type BenchmarkRouteInfra = NonNullable<MountReportRoutesDeps["benchmark"]>;

export interface FeatureRouteDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // The VcsProvider seam, used by the run/merge-lifecycle routes (the CI
  // webhook fallback). The forge-recon / inbox / config-gate routes keep using
  // `githubHttp` directly — only the run+merge path goes through the provider.
  vcsProvider: VcsProvider;
  githubAppMinter: GithubAppTokenMinter;
  credentialRegistry: CredentialRegistry;
  configGateGithub: ConfigGateGithubFactory;
  vaultHealthCheck: () => Promise<{ ok: boolean; status: number }>;
  // The runner allocator + SSH substrate + identity ref the run worker uses —
  // the Forge answerer factories allocate a short-lived runner per model call to
  // run the REAL provider answerer (engine/forge/providerFactory.ts). Same
  // values `buildApp` assembles for the benchmark infra.
  allocator: Allocator;
  ssh: CommandSubstrate;
  identitySecretRef: string;
  // B1 (webhook provisioning): the public base URL Tanren is reachable at, so the
  // inbox webhook-provision endpoint can construct the GitHub `issues` callback URL.
  // Omitted → the provisioning endpoint is not mounted.
  publicBaseUrl?: string;
  // Live benchmark infra (allocator + SSH + runner identity + the shared LISTEN
  // connection) so the benchmark scheduler runs REAL trials — the post-merge
  // accept tier and the LISTEN/NOTIFY terminal await. Omitted (the default) →
  // the runner's own defaults apply (no-op accept, poll await): the route still
  // schedules + persists trials, but the live verdict/await are not wired.
  benchmark?: BenchmarkRouteInfra;
}

/**
 * Mount every feature route on `app`. Registration order is preserved from the
 * prior inline block in `buildApp`; behavior is identical.
 */
export function mountFeatureRoutes(app: Hono<ActorContextEnv>, deps: FeatureRouteDeps): void {
  const { pool, secrets, githubHttp, githubAppMinter, credentialRegistry, configGateGithub, vaultHealthCheck } = deps;
  const benchmarkInfra = deps.benchmark;
  // RLS R3b: every `/orgs/:orgId/*` (+ `/orgs/:orgId/credentials`) operator route
  // handler runs its tenant-table reads/writes on this org-scoping pool. Combined
  // with the per-request `runWithJobOrgId` org scope the auth middleware
  // establishes, each handler `.query` opens a SHORT `runWithOrgScope` per
  // statement stamped with the request's org — so under the runtime `tanren_app`
  // role the deny-by-default RLS policies admit the handler's rows. With no org
  // scope set (a bootstrap/unscoped request) the proxy is behavior-identical to
  // the bare pool. The seam is a drop-in `pg.Pool`; factories need no edits, and
  // self-scoping helpers (`createProject`/`createSpec` `runWithOrgScope`,
  // `resolveWritableClient`) still resolve correctly through it.
  const scopedPool = orgScopingPool(pool);
  // The per-surface Forge answerer factories: each Forge ideation surface
  // resolves a REAL provider answerer (no deterministic fallback — §8a) by
  // allocating a runner per model call against the shared infra (the same
  // allocator / SSH / identity ref the run worker uses). Each route calls its
  // factory with the request's org/project target.
  //
  // The factories get the `scopedPool` (NOT the bare `pool`): a Forge answerer's
  // org/project config reads (interview/discovery/triage/recon/conversation) must
  // carry the request's org GUC, or under the `tanren_app` RLS role they read
  // ZERO rows and the resolution wrongly degrades. The proxy opens a short
  // org-scoped txn per `.query` from the request's ambient org id.
  const forgeInfra = {
    pool: scopedPool,
    secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
  };
  const forgeAnswerers = buildForgeRouteAnswererFactories(forgeInfra);
  // Tanren-native templating (wave 4): the LIVE creation-flow deps, assembled ONCE
  // and shared by BOTH the template-create route (operator trigger) AND the
  // onboarding selection no-match → creation wiring — so creation behaves
  // identically on either trigger. Reuses the run infra (allocator/ssh), the
  // greenfield repo+deploy plumbing, the audit pass runner, and the Forge infra.
  const createTemplateFlowDeps = {
    pool: scopedPool,
    secrets,
    allocator: deps.allocator,
    ssh: deps.ssh,
    identitySecretRef: deps.identitySecretRef,
    vcsProvider: deps.vcsProvider,
    githubAppMinter,
    forgeInfra,
    auditPassRunner: forgeAnswerers.auditPassRunnerFor({ githubHttp, githubAppMinter }),
  };
  app.route("/orgs", createOrgRoutes({ pool: scopedPool, configGateGithub }));
  // Wave-2 operator API: the "Connect AI provider" + billing-mode settings surface.
  // Mounted on the org-scoping pool (reads/writes `organizations.config` under RLS)
  // and sharing the durable credential registry so a connected provider appears in
  // the credential list. Stores BYOK keys under a COST-CLASSIFIABLE ref so the
  // budget gate meters them (routes/aiProvider/index.ts).
  app.route("/orgs", createAiProviderRoutes({ pool: scopedPool, secrets, registry: credentialRegistry }));
  // Wave-2 operator API: human-drivable "Connect GitHub" (App install OR token,
  // server-stamped `installedAt`, no raw config PATCH) + the connected identity's
  // REAL capability check (`canCreateRepos`) + the single onboarding readiness
  // checklist. Org-scoped on the scoped pool; the shared minter caches App tokens.
  // The managed App credential ref (when configured via env) backs an install
  // connect that omits a `credentialRef`.
  app.route(
    "/orgs",
    createGithubConnectRoutes({
      pool: scopedPool,
      secrets,
      minter: githubAppMinter,
      ...(process.env["TANREN_GITHUB_APP_CREDENTIAL_REF"] === undefined ||
      process.env["TANREN_GITHUB_APP_CREDENTIAL_REF"] === ""
        ? {}
        : { appCredentialRef: process.env["TANREN_GITHUB_APP_CREDENTIAL_REF"] }),
    }),
  );
  app.route(
    "/orgs",
    // GREENFIELD: the `/projects/greenfield` create path mints the org's GitHub App
    // token + creates a brand-new repo through the VcsProvider seam, so the project
    // routes carry the secrets/provider/minter deps (the brownfield-link route uses
    // the same App resolution).
    createProjectRoutes({ pool: scopedPool, secrets, vcsProvider: deps.vcsProvider, githubAppMinter }),
  );
  // The app-env-to-Actions-secrets + CI-ingest-secrets routes are GONE: the native gate
  // runs the project's tests over SSH with the app env materialized in-process, and the
  // per-test JUnit grain is ingested in-process from the runner — no Actions secrets,
  // no JUnit-upload webhook (the no-Actions delivery model).
  app.route("/orgs", createSpecRoutes({ pool: scopedPool }));
  app.route("/orgs", createPersonaRoutes({ pool: scopedPool }));
  app.route("/orgs", createBehaviorRoutes({ pool: scopedPool }));
  app.route("/orgs", createMilestoneRoutes({ pool: scopedPool }));
  mountBrownfieldRoutes(app, {
    pool: scopedPool,
    secrets,
    githubHttp,
    githubAppMinter,
    reconAnswererFactory: forgeAnswerers.recon,
  });
  // GitHub App install flow; mounts only when configured via env.
  // SECURITY (H1): the install/callback handlers write the org's
  // `config.github_app` and self-authorize the request actor against the TARGET
  // org (org-admin), so they run on the org-scoping pool — never the raw pool.
  mountGithubAppInstallFromEnv(app, { pool: scopedPool, secrets, minter: githubAppMinter });
  app.route("/orgs", createForgeRoutes({ pool: scopedPool, secrets, githubHttp }));
  // thick-Forge LLM conversation endpoint (⌘K chat morph); the answerer
  // is the real provider conversation answerer, resolved per-request.
  app.route(
    "/orgs",
    createForgeAskRoutes({
      pool: scopedPool,
      secrets,
      githubHttp,
      answererFactory: forgeAnswerers.conversation,
    }),
  );
  // write-action approval: approve/reject proposed write actions.
  app.route("/orgs", createForgeProposalRoutes({ pool: scopedPool }));
  // The forge-CI webhook (`/github/webhooks/ci`) is GONE: the native gate is the
  // merge authority (no-Actions delivery model), so there is no forge check-run
  // state for a webhook to advance.
  // P1d autonomous intake — the GitHub issues WEBHOOK RECEIVER (autonomy-engine.md
  // §1d). GitHub posts to `/github/webhooks/issues/:sourceId`; the receiver
  // verifies the source's signature (mandatory), triages with the real provider
  // answerer, and inserts an auto-routable issue into the DAG (else inbox). Like
  // the CI receiver it resolves its tenant server-side, so it keeps the bare pool;
  // the auto-route DAG insert runs under the resolved org's RLS scope internally.
  // §3.6: the receiver now persists-then-202s and a background processor (kicked
  // best-effort here, GUARANTEED by the poller's sweeper) triages/routes. The
  // processor's autonomous DAG-insert deps default to the system actor internally.
  app.route("/", createIssueWebhookRoutes({ pool, secrets, answererFactory: forgeAnswerers.triage }));
  // The JUnit-upload webhook (`/webhooks/ci/junit`) is GONE: the native gate ingests the
  // runner's JUnit report IN-PROCESS after it runs (no Actions upload step, no HMAC).
  app.route("/orgs", createInsightRoutes({ pool: scopedPool }));
  // spec discovery — the model DERIVES proposed specs + DAG placement
  // from the insight; accept → create specs with provenance.
  app.route("/orgs", createDiscoveryRoutes({ pool: scopedPool, answererFactory: forgeAnswerers.discovery }));
  // greenfield onboarding — Forge vision interview → derived product
  // graph via the existing creation paths; the real provider interview answerer.
  app.route(
    "/orgs",
    createOnboardingRoutes({
      pool: scopedPool,
      secrets,
      answererFactory: forgeAnswerers.interview,
      vcsProvider: deps.vcsProvider,
      githubAppMinter,
      // Wave 4: selection no-match → CREATION. Onboarding's template selection
      // creates + seeds a template when none matches (else from-scratch).
      createTemplateForNoMatch: (ctx) => buildCreateForNoMatch(createTemplateFlowDeps, ctx),
    }),
  );
  // candidate inbox — issue sources → Forge triage → discovery accept;
  // connector reads via the App resolver, the real provider triage answerer.
  app.route(
    "/orgs",
    createInboxRoutes({
      pool: scopedPool,
      secrets,
      githubHttp,
      answererFactory: forgeAnswerers.triage,
      // B1: enable the webhook-provision endpoint (needs the App minter + a public
      // callback URL). Absent publicBaseUrl ⇒ the endpoint stays unmounted.
      githubAppMinter,
      ...(deps.publicBaseUrl === undefined ? {} : { publicBaseUrl: deps.publicBaseUrl }),
    }),
  );
  // scheduled audits — recurring read-only Answerer passes (the audit
  // job library). A run executes the REAL read-only pass (the audit answerer
  // indexes the project's repo READ-ONLY and surfaces findings); each finding is
  // triaged by the real provider answerer and, when auto-routable, COMMITTED INTO
  // THE DAG as a spec (no operator) — the same hand-off the autonomous loop runs.
  app.route(
    "/orgs",
    createAuditRoutes({
      pool: scopedPool,
      passRunner: forgeAnswerers.auditPassRunnerFor({ githubHttp, githubAppMinter }),
      answererFactory: forgeAnswerers.triage,
    }),
  );
  // Tanren-native templating (wave 1): the template REGISTRY — register/list/get
  // templates + transition lifecycle status, org-scoped on the scoped pool (RLS
  // bounds each query to the org's own templates plus the cross-org official tier).
  //
  // Tanren-native templating (wave 4): the LIVE creation meta-flow is WIRED in here
  // (POST .../templates/create), so the create endpoint is mounted as a real
  // capability — research (live model + web) → author → build (the real walker +
  // run worker drive the derived template-build project to convergence) → validate
  // (positive + NEGATIVE controls + auditor) → publish (fail-closed: only a proof
  // that validates registers). Reuses the SAME run infra (allocator/ssh/walker),
  // greenfield repo-creation + deploy provisioning, audit pass runner, and Forge
  // answerer infra assembled above — no duplication.
  app.route(
    "/orgs",
    createTemplateRoutes({
      pool: scopedPool,
      createTemplateFlow: buildCreateTemplateFlow(createTemplateFlowDeps),
    }),
  );
  // DORA delivery metrics + the benchmark experiment/cell report+CRUD surface.
  // The benchmark scheduler runs on the scoped pool; its live accept/await seams
  // carry their own infra (allocator/ssh/identity/notify) when the boot wired it.
  mountReportRoutes(app, { pool: scopedPool, ...(benchmarkInfra === undefined ? {} : { benchmark: benchmarkInfra }) });
  app.route("/orgs", createNotificationRoutes({ pool: scopedPool }));
  // capability-driven onboarding — "enable error tracking / notify /
  // deploy" resolves the org grant, builds the provisioner with PRODUCTION deps,
  // applies confirm-with-smart-default, persists the artifact (inbox source /
  // notification target / projects.config / secret refs), and emits
  // `integration.provisioned` (refs only). Org-scoped on the scoped pool; the
  // configured SecretStore backs the provisioner's transports.
  app.route("/orgs", createIntegrationRoutes({ pool: scopedPool, secrets }));
  app.route("/orgs", createRunRoutes({ pool: scopedPool }));
  app.route("/orgs", createRecoveryRoutes({ pool: scopedPool }));
  // Credentials mount at root but every endpoint is `/orgs/:orgId/credentials/*`
  // and reads/writes the org's `config` (RLS-enabled `organizations`), so it gets
  // the org-scoping pool too.
  app.route("/", createCredentialRoutes({ pool: scopedPool, secrets, registry: credentialRegistry }));
  app.route(
    "/",
    createDoctorRoutes({
      pool,
      secrets,
      vaultHealthCheck,
    }),
  );
}
