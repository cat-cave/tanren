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
  readonly notificationEventCounts = new Map<string, number>();
  readonly auditJobCounts = new Map<string, number>();
  readonly personas = new Map<string, { id: string; orgId: string; projectId: string }>();
  readonly behaviors = new Map<string, { id: string; personaId: string }>();
  readonly milestones = new Map<string, { id: string; projectId: string }>();
  readonly designContracts = new Map<string, { id: string; orgId: string; projectId: string }>();

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
    this.notificationEventCounts.set(targetId, 8);
    this.auditJobCounts.set(`${orgId}:${projectId}`, 4);
    return {
      inboxSource: { id: String(source["id"]), created: existing === undefined },
      notificationRoute: { targetId, created: existing === undefined, events: 8 },
      auditCatalog: {
        jobs: 4,
        created: ["security", "deps", "mutation", "stale_specs"] as const,
      },
      errors: [],
    };
  }

  handle(sql: string, params: unknown[], tables: DerivationEvidenceTables): QueryResult | undefined {
    if (sql.includes("AS inbox_exists") && sql.includes("FROM notification_routes")) {
      const [orgId, projectId, sourceId, targetId] = params.map(String);
      const inboxExists = tables.inboxSources.some(
        (source) => source["org_id"] === orgId && source["project_id"] === projectId && source["id"] === sourceId,
      );
      return {
        rows: [
          {
            inbox_exists: inboxExists,
            notification_events: this.notificationEventCounts.get(targetId) ?? 0,
            audit_jobs: this.auditJobCounts.get(`${orgId}:${projectId}`) ?? 0,
          },
        ],
        rowCount: 1,
      };
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
    if (sql.startsWith("INSERT INTO design_contracts")) {
      const row = {
        id: String(params[0]),
        org_id: String(params[1]),
        project_id: String(params[2]),
        version: 1,
        domain: String(params[3]),
        contract: JSON.parse(String(params[4])) as unknown,
      };
      this.designContracts.set(row.id, { id: row.id, orgId: row.org_id, projectId: row.project_id });
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
