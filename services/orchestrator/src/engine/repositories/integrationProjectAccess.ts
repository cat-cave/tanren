import type { ActorContext } from "../../auth/schemas.js";
import {
  canonicalDesignContractJson,
  designContractDigest,
  normalizeDesignContract,
} from "../design/designContract.js";
import { AUDIT_BOOTSTRAP_REQUIRED_CATEGORIES } from "../forge/audits/seedCatalog.js";
import { PgIntegrationAuthority } from "../integrations/integrationAuthorityImpl.js";
import { DEFAULT_ROUTE_EVENTS, DEFAULT_ROUTE_MIN_SEVERITY } from "../notifications/seedDefaultRoute.js";
import { systemActor } from "../state/actor.js";
import {
  BootstrapSchema,
  DerivationReceiptValidationError,
  type CompleteProjectDerivation,
} from "./projectDerivationReceipts.js";
import type { IntegrationQueryClient } from "./integrationQuery.js";

export type IntegrationProjectAccess = "allowed" | "not_found" | "denied";

export interface DerivationActivationProject {
  name: string;
  repoUrl: string;
  defaultBranch: string;
}

function mismatch(message: string): never {
  throw new DerivationReceiptValidationError("binding_mismatch", message);
}

function canonicalRepoUrl(value: string): string {
  return value.replace(/\.git$/u, "");
}

function sameIds(receiptIds: readonly string[], storedIds: readonly string[]): boolean {
  if (receiptIds.length !== new Set(receiptIds).size || receiptIds.length !== storedIds.length) return false;
  return [...receiptIds].sort().every((id, index) => id === [...storedIds].sort()[index]);
}

async function assertBootstrap(client: IntegrationQueryClient, derivation: CompleteProjectDerivation): Promise<void> {
  const bootstrap = BootstrapSchema.parse(derivation.results.bootstrap);
  const receiptRoutes = bootstrap.notificationRoute.requiredEvents.map(
    (route) => `${route.eventName}:${route.minSeverity}`,
  );
  const requiredRoutes = DEFAULT_ROUTE_EVENTS.map((eventName) => `${eventName}:${DEFAULT_ROUTE_MIN_SEVERITY}`);
  if (
    !sameIds(bootstrap.auditCatalog.requiredCategories, AUDIT_BOOTSTRAP_REQUIRED_CATEGORIES) ||
    !sameIds(receiptRoutes, requiredRoutes)
  ) {
    mismatch("bootstrap receipt does not name the canonical autonomous surfaces");
  }

  const inbox = await client.query("SELECT id FROM inbox_sources WHERE org_id = $1 AND project_id = $2 AND id = $3", [
    derivation.ownership.orgId,
    derivation.ownership.projectId,
    bootstrap.inboxSource.id,
  ]);
  const audits = await client.query("SELECT kind, enabled FROM audit_jobs WHERE org_id = $1 AND project_id = $2", [
    derivation.ownership.orgId,
    derivation.ownership.projectId,
  ]);
  const routes = await client.query(
    `SELECT t.enabled AS target_enabled, r.event_name, r.enabled AS route_enabled, r.min_severity
       FROM notification_targets t
       LEFT JOIN notification_routes r ON r.target_id = t.id
      WHERE t.org_id = $1 AND t.id = $2`,
    [derivation.ownership.orgId, bootstrap.notificationRoute.targetId],
  );
  const enabledAuditKinds = new Set(
    (audits.rows as Array<{ kind: string; enabled: unknown }>)
      .filter((row) => row.enabled === true || row.enabled === "true")
      .map((row) => row.kind),
  );
  const routeRows = routes.rows as Array<{
    target_enabled: unknown;
    event_name: string | null;
    route_enabled: unknown;
    min_severity: string | null;
  }>;
  const targetEnabled = routeRows.some((row) => row.target_enabled === true || row.target_enabled === 1);
  const routesComplete = DEFAULT_ROUTE_EVENTS.every((eventName) =>
    routeRows.some(
      (row) =>
        row.event_name === eventName &&
        (row.route_enabled === true || row.route_enabled === 1) &&
        row.min_severity === DEFAULT_ROUTE_MIN_SEVERITY,
    ),
  );
  if (
    inbox.rows[0] === undefined ||
    !AUDIT_BOOTSTRAP_REQUIRED_CATEGORIES.every((kind) => enabledAuditKinds.has(kind)) ||
    !targetEnabled ||
    !routesComplete
  ) {
    mismatch("bootstrap receipt does not match the project bootstrap surfaces");
  }
}

async function assertDeployAuthority(
  client: IntegrationQueryClient,
  derivation: CompleteProjectDerivation,
): Promise<void> {
  const outcome = derivation.results.deploy.outcome;
  const locked = await client.query(
    `SELECT s.connection_id, s.grant_id, s.auth_generation, s.grant_generation,
            c.provider_principal_id
       FROM project_integration_grant_selections s
       JOIN org_integration_connections c
         ON c.org_id = s.org_id AND c.provider_kind = s.provider_kind AND c.id = s.connection_id
       JOIN org_integration_grants g
         ON g.org_id = s.org_id AND g.provider_kind = s.provider_kind
        AND g.connection_id = s.connection_id AND g.id = s.grant_id
      WHERE s.org_id = $1 AND s.project_id = $2 AND s.provider_kind = $3
      FOR UPDATE OF s, c, g`,
    [derivation.ownership.orgId, derivation.ownership.projectId, outcome.providerKind],
  );
  const selection = locked.rows[0] as
    | {
        connection_id: string;
        grant_id: string;
        auth_generation: number;
        grant_generation: number;
        provider_principal_id: string;
      }
    | undefined;
  const evidence = outcome.authority;
  if (
    selection === undefined ||
    selection.connection_id !== evidence.connectionId ||
    selection.grant_id !== evidence.grantId ||
    selection.auth_generation !== evidence.authGeneration ||
    selection.grant_generation !== evidence.grantGeneration ||
    selection.provider_principal_id !== evidence.providerPrincipalId
  ) {
    mismatch("deploy receipt does not match the locked project authority selection");
  }

  const resolution = await new PgIntegrationAuthority().authorizeOperation(client, {
    orgId: derivation.ownership.orgId,
    projectId: derivation.ownership.projectId,
    providerKind: outcome.providerKind,
    capability: outcome.capability,
    operation: outcome.action,
    actor: systemActor,
  });
  if (
    resolution.status !== "eligible" ||
    resolution.lease.connectionId !== evidence.connectionId ||
    resolution.lease.grantId !== evidence.grantId ||
    resolution.lease.providerPrincipalId !== evidence.providerPrincipalId ||
    resolution.lease.authGeneration !== evidence.authGeneration ||
    resolution.lease.grantGeneration !== evidence.grantGeneration
  ) {
    mismatch("deploy receipt is not current eligible-operation evidence");
  }
}

async function assertInterviewGraph(
  client: IntegrationQueryClient,
  derivation: Extract<CompleteProjectDerivation, { kind: "interview" }>,
  project: DerivationActivationProject,
): Promise<void> {
  const graph = derivation.results.graph;
  const designResult = derivation.results.design;
  const graphDesign = graph.designContract;
  const repository = graph.repository;
  if (
    graph.projectName !== project.name ||
    repository === undefined ||
    repository.fullName !== derivation.results.repository.fullName ||
    canonicalRepoUrl(repository.repoUrl) !== canonicalRepoUrl(project.repoUrl) ||
    repository.defaultBranch !== project.defaultBranch ||
    JSON.stringify(graph.templateSeed) !== JSON.stringify(derivation.template)
  ) {
    mismatch("graph receipt is not bound to the project repository/template identity");
  }
  const result = await client.query(
    `SELECT
       ARRAY(SELECT spec_id FROM specs WHERE org_id = $1 AND project_id = $2 ORDER BY spec_id) AS spec_ids,
       ARRAY(SELECT id FROM personas WHERE org_id = $1 AND project_id = $2 ORDER BY id) AS persona_ids,
       ARRAY(SELECT b.id FROM behaviors b JOIN personas p ON p.id = b.persona_id
              WHERE p.org_id = $1 AND p.project_id = $2 ORDER BY b.id) AS behavior_ids,
       ARRAY(SELECT id FROM milestones WHERE project_id = $2 ORDER BY id) AS milestone_ids,
       ARRAY(SELECT id FROM design_contracts WHERE org_id = $1 AND project_id = $2 ORDER BY id)
         AS design_contract_ids`,
    [derivation.ownership.orgId, derivation.ownership.projectId],
  );
  const stored = result.rows[0] as
    | {
        spec_ids: string[];
        persona_ids: string[];
        behavior_ids: string[];
        milestone_ids: string[];
        design_contract_ids: string[];
      }
    | undefined;
  if (
    stored === undefined ||
    !sameIds(graph.specIds, stored.spec_ids) ||
    !sameIds(graph.personaIds, stored.persona_ids) ||
    !sameIds(graph.behaviorIds, stored.behavior_ids) ||
    !sameIds(graph.milestoneIds, stored.milestone_ids) ||
    !sameIds([graphDesign.id], stored.design_contract_ids)
  ) {
    mismatch("graph receipt does not match the project's complete persisted graph lineage");
  }

  const designRows = await client.query(
    `SELECT id, org_id, project_id, version, domain, contract
       FROM design_contracts
      WHERE org_id = $1 AND project_id = $2 AND id = $3 AND version = $4`,
    [derivation.ownership.orgId, derivation.ownership.projectId, graphDesign.id, graphDesign.version],
  );
  const designRow = designRows.rows[0] as
    | { id: string; org_id: string; project_id: string; version: number | string; domain: string; contract: unknown }
    | undefined;
  if (designRow === undefined) mismatch("graph receipt does not resolve its exact design-contract row");
  const storedContract = normalizeDesignContract(designRow.contract);
  const storedDigest = designContractDigest(storedContract);
  if (
    designRow.org_id !== derivation.ownership.orgId ||
    designRow.project_id !== derivation.ownership.projectId ||
    designRow.id !== graphDesign.id ||
    Number(designRow.version) !== graphDesign.version ||
    designRow.domain !== graphDesign.domain ||
    storedContract.domain !== graphDesign.domain ||
    graphDesign.digest !== designResult.contractDigest ||
    storedDigest !== graphDesign.digest ||
    designContractDigest(designResult.contract) !== designResult.contractDigest ||
    canonicalDesignContractJson(storedContract) !== canonicalDesignContractJson(designResult.contract)
  ) {
    mismatch("persisted design contract does not match the immutable design result and graph receipt");
  }
}

/** Fail-closed activation readback; this consumes, and never recreates, IntegrationAuthority. */
export async function assertProjectDerivationActivationEvidence(
  client: IntegrationQueryClient,
  derivation: CompleteProjectDerivation,
  project: DerivationActivationProject,
): Promise<void> {
  const repository = derivation.results.repository;
  if (
    canonicalRepoUrl(project.repoUrl) !== canonicalRepoUrl(derivation.ownership.repoUrl) ||
    project.defaultBranch !== derivation.ownership.repository.requestedDefaultBranch ||
    repository.defaultBranch !== project.defaultBranch
  ) {
    mismatch("repository receipt does not match the project's requested and actual default branch");
  }
  await assertBootstrap(client, derivation);
  await assertDeployAuthority(client, derivation);
  if (derivation.kind === "interview") await assertInterviewGraph(client, derivation, project);
}

/** Project-scoped integration effects require project membership, not just org scope. */
export async function integrationProjectAccess(
  client: IntegrationQueryClient,
  orgId: string,
  projectId: string,
  actor: ActorContext,
): Promise<IntegrationProjectAccess> {
  const project = await client.query("SELECT project_id FROM projects WHERE org_id = $1 AND project_id = $2", [
    orgId,
    projectId,
  ]);
  if (project.rows[0] === undefined) return "not_found";
  if (actor.scopes.includes("platform:admin") || actor.scopes.includes("org:admin")) return "allowed";
  if (
    actor.projectId === projectId &&
    (actor.scopes.includes("project:member") || actor.scopes.includes("project:admin"))
  ) {
    return "allowed";
  }
  const membership = await client.query("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2", [
    projectId,
    actor.userId,
  ]);
  return membership.rows[0] === undefined ? "denied" : "allowed";
}
