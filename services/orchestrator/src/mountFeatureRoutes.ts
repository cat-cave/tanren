// The orchestrator's feature-route mount table, extracted from `buildApp` in
// main.ts. `buildApp` owns app construction, auth, the inline run/spec/CI
// handlers, and lifecycle; this module owns the long, declarative list of
// `app.route(...)` registrations for the create*Routes factories. Splitting it
// out keeps main.ts's import count and `buildApp`'s length focused without
// changing any wiring — every registration here is byte-for-byte the prior
// inline call, in the same order.

import type { Hono } from "hono";
import type pg from "pg";
import type { SecretStore } from "./engine/contracts/index.js";
import type { GitHubHttpClient } from "./engine/providers/github.js";
import type { GithubAppTokenMinter } from "./engine/providers/githubAppTokenMinter.js";
import { mountGithubAppInstallFromEnv } from "./routes/auth/githubAppInstall.js";
import { createBehaviorRoutes } from "./routes/behaviors/index.js";
import { mountBrownfieldRoutes } from "./routes/brownfield/mount.js";
import { createCredentialRoutes, type CredentialRegistry } from "./routes/credentials/index.js";
import { createDiscoveryRoutes } from "./routes/discovery/index.js";
import { createDoctorRoutes } from "./routes/doctor/index.js";
import { createDoraRoutes } from "./routes/dora/index.js";
import { createForgeAskRoutes } from "./routes/forge/ask.js";
import { createForgeProposalRoutes } from "./routes/forge/proposals.js";
import { createInboxRoutes } from "./routes/inbox/index.js";
import { createAuditRoutes } from "./routes/audits/index.js";
import { createForgeRoutes } from "./routes/forge/index.js";
import { createGithubWebhookRoutes } from "./routes/githubWebhooks/index.js";
import { createInsightRoutes } from "./routes/insights/index.js";
import { createMilestoneRoutes } from "./routes/milestones/index.js";
import { createNotificationRoutes } from "./routes/notifications/index.js";
import { createOnboardingRoutes } from "./routes/onboarding/index.js";
import { type ConfigGateGithubFactory, createOrgRoutes } from "./routes/orgs/index.js";
import { createPersonaRoutes } from "./routes/personas/index.js";
import { createProjectRoutes } from "./routes/projects/index.js";
import { createRecoveryRoutes } from "./routes/recovery/index.js";
import { createRunRoutes } from "./routes/runs/index.js";
import { createSpecRoutes } from "./routes/specs/index.js";
import type { ActorContextEnv } from "./middleware/auth.js";

export interface FeatureRouteDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  githubAppMinter: GithubAppTokenMinter;
  credentialRegistry: CredentialRegistry;
  configGateGithub: ConfigGateGithubFactory;
  vaultHealthCheck: () => Promise<{ ok: boolean; status: number }>;
}

/**
 * Mount every feature route on `app`. Registration order is preserved from the
 * prior inline block in `buildApp`; behavior is identical.
 */
export function mountFeatureRoutes(app: Hono<ActorContextEnv>, deps: FeatureRouteDeps): void {
  const { pool, secrets, githubHttp, githubAppMinter, credentialRegistry, configGateGithub, vaultHealthCheck } = deps;
  app.route("/orgs", createOrgRoutes({ pool, configGateGithub }));
  app.route("/orgs", createProjectRoutes({ pool }));
  app.route("/orgs", createSpecRoutes({ pool }));
  app.route("/orgs", createPersonaRoutes({ pool }));
  app.route("/orgs", createBehaviorRoutes({ pool }));
  app.route("/orgs", createMilestoneRoutes({ pool }));
  mountBrownfieldRoutes(app, { pool, secrets, githubHttp, githubAppMinter });
  // P3-0003: GitHub App install flow; mounts only when configured via env.
  mountGithubAppInstallFromEnv(app, { pool, secrets, minter: githubAppMinter });
  app.route("/orgs", createForgeRoutes({ pool, secrets, githubHttp }));
  // P3-0010: thick-Forge LLM conversation endpoint (⌘K chat morph); answerer injectable.
  app.route("/orgs", createForgeAskRoutes({ pool, secrets, githubHttp }));
  // P3-0010 (write-action approval): approve/reject proposed write actions.
  app.route("/orgs", createForgeProposalRoutes({ pool }));
  // P3-0028 webhook-driven CI (option). Mounted at root so GitHub posts to
  // `/github/webhooks/ci`. Polling remains the default fallback.
  app.route("/", createGithubWebhookRoutes({ pool, secrets, githubHttp, githubAppMinter }));
  app.route("/orgs", createInsightRoutes({ pool }));
  // P3-0014: spec discovery — classify an insight into proposed specs +
  // DAG-placement options, accept → create specs with provenance.
  app.route("/orgs", createDiscoveryRoutes({ pool }));
  // P3-0015: greenfield onboarding — Forge vision interview → derived product
  // graph via the existing creation paths; interview answerer injectable.
  app.route("/orgs", createOnboardingRoutes({ pool }));
  // P3-0022: candidate inbox — issue sources → Forge triage → discovery accept;
  // connector reads via the App resolver, triage answerer injectable.
  app.route("/orgs", createInboxRoutes({ pool, secrets, githubHttp }));
  // P3-0021: scheduled audits — recurring read-only Answerer passes (the audit
  // job library). A run executes a read-only pass and emits findings into the
  // candidate inbox as a system (auto-routing) source; the pass runner is
  // injectable (defaults to a safe no-op until an SSH-backed runner is wired).
  app.route("/orgs", createAuditRoutes({ pool }));
  app.route("/orgs", createDoraRoutes({ pool }));
  app.route("/orgs", createNotificationRoutes({ pool }));
  app.route("/orgs", createRunRoutes({ pool }));
  app.route("/orgs", createRecoveryRoutes({ pool }));
  app.route("/", createCredentialRoutes({ pool, secrets, registry: credentialRegistry }));
  app.route(
    "/",
    createDoctorRoutes({
      pool,
      secrets,
      vaultHealthCheck,
    }),
  );
}
