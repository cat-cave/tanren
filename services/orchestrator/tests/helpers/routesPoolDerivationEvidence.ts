import { AUDIT_BOOTSTRAP_REQUIRED_CATEGORIES } from "../../src/engine/forge/audits/seedCatalog.js";
import { DEFAULT_ROUTE_EVENTS, DEFAULT_ROUTE_MIN_SEVERITY } from "../../src/engine/notifications/seedDefaultRoute.js";

interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

interface ProjectRow {
  project_id: string;
  org_id: string | null;
}

interface SpecRow {
  spec_id: string;
  project_id: string;
}

interface DerivationEvidenceTables {
  projects: Map<string, ProjectRow>;
  specs: Map<string, SpecRow>;
  inboxSources: Array<Record<string, unknown>>;
}

export class RoutesPoolDerivationEvidence {
  readonly notificationRoutes = new Map<
    string,
    Array<{ event_name: string; route_enabled: number; min_severity: string }>
  >();
  readonly auditJobs = new Map<string, Array<{ kind: string; enabled: string }>>();
  readonly personas = new Map<string, { id: string; orgId: string; projectId: string }>();
  readonly behaviors = new Map<string, { id: string; personaId: string }>();
  readonly milestones = new Map<string, { id: string; projectId: string }>();
  readonly designContracts = new Map<
    string,
    { id: string; orgId: string; projectId: string; version: number; domain: string; contract: unknown }
  >();

  seedBootstrap(orgId: string, projectId: string, inboxSources: Array<Record<string, unknown>>) {
    const existing = inboxSources.find((source) => source["org_id"] === orgId && source["project_id"] === projectId);
    const source =
      existing ??
      ({
        id: `src_${projectId}`,
        org_id: orgId,
        project_id: projectId,
        kind: "issues",
      } satisfies Record<string, unknown>);
    if (existing === undefined) inboxSources.push(source);
    const targetId = `notif_${orgId}`;
    this.notificationRoutes.set(
      targetId,
      DEFAULT_ROUTE_EVENTS.map((event_name) => ({
        event_name,
        route_enabled: 1,
        min_severity: DEFAULT_ROUTE_MIN_SEVERITY,
      })),
    );
    this.auditJobs.set(
      `${orgId}:${projectId}`,
      AUDIT_BOOTSTRAP_REQUIRED_CATEGORIES.map((kind) => ({ kind, enabled: "true" })),
    );
    return {
      inboxSource: { id: String(source["id"]), created: existing === undefined },
      notificationRoute: {
        targetId,
        created: existing === undefined,
        requiredEvents: DEFAULT_ROUTE_EVENTS.map((eventName) => ({
          eventName,
          minSeverity: DEFAULT_ROUTE_MIN_SEVERITY,
        })),
      },
      auditCatalog: {
        requiredCategories: [...AUDIT_BOOTSTRAP_REQUIRED_CATEGORIES],
        created: [...AUDIT_BOOTSTRAP_REQUIRED_CATEGORIES],
      },
      errors: [],
    };
  }

  handle(sql: string, params: unknown[], tables: DerivationEvidenceTables): QueryResult | undefined {
    if (sql.startsWith("SELECT id FROM inbox_sources")) {
      const [orgId, projectId, sourceId] = params.map(String);
      const inboxExists = tables.inboxSources.some(
        (source) => source["org_id"] === orgId && source["project_id"] === projectId && source["id"] === sourceId,
      );
      return { rows: inboxExists ? [{ id: sourceId }] : [], rowCount: inboxExists ? 1 : 0 };
    }
    if (sql.startsWith("SELECT kind, enabled FROM audit_jobs")) {
      const rows = this.auditJobs.get(`${String(params[0])}:${String(params[1])}`) ?? [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("SELECT t.enabled AS target_enabled")) {
      const rows = (this.notificationRoutes.get(String(params[1])) ?? []).map((row) => ({
        target_enabled: 1,
        ...row,
      }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("SELECT s.connection_id") && sql.includes("FOR UPDATE OF s, c, g")) {
      return {
        rows: [
          {
            connection_id: "connection_1",
            grant_id: "grant_1",
            auth_generation: 1,
            grant_generation: 1,
            provider_principal_id: "account_1",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("c.id AS connection_id") && sql.includes("project_integration_grant_selections")) {
      return { rows: [eligibleAuthority(String(params[2]))], rowCount: 1 };
    }
    if (sql.includes("AS spec_ids") && sql.includes("AS design_contract_ids")) {
      const [orgId, projectId] = params.map(String);
      const personaIds = [...this.personas.values()]
        .filter((row) => row.orgId === orgId && row.projectId === projectId)
        .map((row) => row.id);
      const personaSet = new Set(personaIds);
      return {
        rows: [
          {
            spec_ids: [...tables.specs.values()]
              .filter((row) => row.project_id === projectId)
              .map((row) => row.spec_id),
            persona_ids: personaIds,
            behavior_ids: [...this.behaviors.values()]
              .filter((row) => personaSet.has(row.personaId))
              .map((row) => row.id),
            milestone_ids: [...this.milestones.values()]
              .filter((row) => row.projectId === projectId)
              .map((row) => row.id),
            design_contract_ids: [...this.designContracts.values()]
              .filter((row) => row.orgId === orgId && row.projectId === projectId)
              .map((row) => row.id),
          },
        ],
        rowCount: 1,
      };
    }
    if (
      sql.startsWith("SELECT id, org_id, project_id, version, domain, contract") &&
      sql.includes("FROM design_contracts")
    ) {
      const row = this.designContracts.get(String(params[2]));
      if (
        row === undefined ||
        row.orgId !== String(params[0]) ||
        row.projectId !== String(params[1]) ||
        row.version !== Number(params[3])
      ) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [
          {
            id: row.id,
            org_id: row.orgId,
            project_id: row.projectId,
            version: row.version,
            domain: row.domain,
            contract: row.contract,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO design_contracts")) {
      const row = {
        id: String(params[0]),
        org_id: String(params[1]),
        project_id: String(params[2]),
        version: 1,
        domain: String(params[3]),
        contract: JSON.parse(String(params[4])) as unknown,
      };
      this.designContracts.set(row.id, {
        id: row.id,
        orgId: row.org_id,
        projectId: row.project_id,
        version: row.version,
        domain: row.domain,
        contract: row.contract,
      });
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO personas")) {
      const row = {
        id: String(params[0]),
        scope: String(params[1]),
        org_id: String(params[2]),
        project_id: String(params[3]),
        name: String(params[4]),
        description: String(params[5]),
        metadata: JSON.parse(String(params[6])) as unknown,
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.personas.set(row.id, { id: row.id, orgId: row.org_id, projectId: row.project_id });
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id, scope, org_id, project_id, name, description")) {
      const persona = this.personas.get(String(params[0]));
      return persona === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [
              {
                id: persona.id,
                scope: "project",
                org_id: persona.orgId,
                project_id: persona.projectId,
                name: "fixture persona",
                description: "fixture persona",
                metadata: {},
                created_at: new Date(),
                updated_at: new Date(),
              },
            ],
            rowCount: 1,
          };
    }
    if (sql.startsWith("INSERT INTO behaviors")) {
      /* eslint-disable unicorn/no-thenable -- mirrors the behavior table's Given/When/Then row. */
      const row = {
        id: String(params[0]),
        persona_id: String(params[1]),
        title: String(params[2]),
        given: String(params[3]),
        when: String(params[4]),
        then: String(params[5]),
        description: String(params[6]),
        metadata: {},
        created_at: new Date(),
        updated_at: new Date(),
      };
      /* eslint-enable unicorn/no-thenable */
      this.behaviors.set(row.id, { id: row.id, personaId: row.persona_id });
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO milestones")) {
      const row = {
        id: String(params[0]),
        project_id: String(params[1]),
        label: params[2],
        name: params[3],
        description: params[4],
        order_index: params[5],
        eta: params[6],
        status: params[7],
        created_at: new Date(),
        updated_at: new Date(),
      };
      this.milestones.set(row.id, { id: row.id, projectId: row.project_id });
      return { rows: [row], rowCount: 1 };
    }
    return undefined;
  }
}

function eligibleAuthority(providerKind: string): Record<string, unknown> {
  return {
    connection_id: "connection_1",
    provider_kind: providerKind,
    provider_principal_id: "account_1",
    display_name: "account_1",
    principal_metadata: {},
    connection_health: "healthy",
    connection_status: "active",
    current_auth_generation: 1,
    grant_id: "grant_1",
    grant_current_generation: 1,
    grant_status: "active",
    plane: "control",
    environment: "control",
    credential_ref: "secret://fixture/deploy-token/g/1",
    auth_expires_at: null,
    auth_status: "active",
    capabilities: ["deploy"],
    operations: ["discover", "provision", "bind", "teardown"],
    provider_scopes: [],
    resource_constraints: {},
    policy_revision: "integration-catalog.v1",
    consent_revision: "consent.test",
    grant_expires_at: null,
    grant_generation_status: "active",
    selected_auth_generation: 1,
    selected_grant_generation: 1,
    selected_connection_id: "connection_1",
    selected_grant_id: "grant_1",
  };
}
