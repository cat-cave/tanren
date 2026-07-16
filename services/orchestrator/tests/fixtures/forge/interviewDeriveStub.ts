// TEST FIXTURE ONLY. The in-memory pg.Pool stub + deploy-prep fixture the
// greenfield-onboarding derive tests share (visionInterview.test.ts). It tracks
// the derive path's INSERTs (keyed by SQL substring, like the discovery engine-test
// stub) so a test can assert the created project/specs/personas without a real DB.
// No migration is involved — every row lands in an existing table.

/* eslint-disable unicorn/no-thenable */
// `then` is the BDD Given/When/Then field name carried on the mocked behavior row;
// the thenable-object lint does not apply to this plain data literal.

import type pg from "pg";

// What the stub observed across the derive's create calls.
export interface StubState {
  projects: Set<string>;
  specs: Map<string, { dependsOn: string[]; title: string; description: string; acceptanceCriteria: string[] }>;
  personas: number;
  // The metadata jsonb persisted per persona INSERT (where the derive persists the
  // persona `surface`, there being no `surface` column).
  personaMetadata: Array<Record<string, unknown>>;
  behaviors: number;
  milestones: number;
  specMilestones: number;
  specBehaviors: number;
  // The design-contract jsonb persisted per `design_contracts` INSERT (native
  // design subsystem, WS-D1) so a test can assert the captured contract is
  // persisted as a first-class versioned entity.
  designContracts: Array<Record<string, unknown>>;
}

// A `prepareDeploy` outcome fixture (a provisioned deploy + the project config it
// surfaces) so a derive test exercises the success path without a provisioner.
export function preparedDeploy(providerKind: "deploy.vercel" | "deploy.flyio" = "deploy.vercel") {
  return {
    outcome: {
      status: "provisioned" as const,
      capability: "deploy",
      providerKind,
      action: "provision" as const,
      mode: "greenfield" as const,
      authority: {
        connectionId: "connection_1",
        grantId: "grant_1",
        providerPrincipalId: "account_1",
        authGeneration: 1,
        grantGeneration: 1,
      },
      secretRefNames: [`secret://deploy/${providerKind}/app_1/token`],
      surfaces: { projectConfigKeys: ["deployProvider", "deployAppId"], deployRef: `${providerKind}:app_1` },
    },
    projectConfig: {
      deployProvider: providerKind,
      deployAppId: "app_1",
      deployAppName: "supply-chain-os",
      previewUrlPattern: "https://supply-chain-os.example.test",
    },
  };
}

export function stubPool(): {
  pool: pg.Pool;
  state: StubState;
  // The persisted project config blob, captured per projectId from the
  // `INSERT INTO projects` call (config is the 7th column → params[6], JSON text).
  configs: Map<string, Record<string, unknown>>;
} {
  const state: StubState = {
    projects: new Set(),
    specs: new Map(),
    personas: 0,
    personaMetadata: [],
    behaviors: 0,
    milestones: 0,
    specMilestones: 0,
    specBehaviors: 0,
    designContracts: [],
  };
  const configs = new Map<string, Record<string, unknown>>();
  const personaIds = new Set<string>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("INSERT INTO projects")) {
      state.projects.add(String(params[0]));
      const rawConfig = params[6];
      if (typeof rawConfig === "string") {
        configs.set(String(params[0]), JSON.parse(rawConfig) as Record<string, unknown>);
      }
      return { rows: [], rowCount: 1 };
    }
    // Post-deploy config merge (project shell created first, deploy fields applied after).
    if (sql.startsWith("UPDATE projects SET config")) {
      const rawConfig = params[0];
      const projectId = String(params[1]);
      if (typeof rawConfig === "string") {
        // Production updateConfig overwrites the config blob entirely with the
        // caller's merged object (base + vision + lifecycle + deploy).
        configs.set(projectId, JSON.parse(rawConfig) as Record<string, unknown>);
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO project_members")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT project_id FROM projects")) {
      return state.projects.has(String(params[0]))
        ? { rows: [{ project_id: params[0] }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // v68 fix: createSpec calls loadProjectOrgId for the spec's NOT NULL org_id.
    if (sql.startsWith("SELECT org_id FROM projects")) {
      return state.projects.has(String(params[0]))
        ? { rows: [{ org_id: "org_test" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // ensureProjectAccess membership lookup → always allow (platform admin).
    if (sql.includes("FROM project_members")) return { rows: [{ role: "admin" }], rowCount: 1 };
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) {
      // dependency existence check: params[1] is the id array.
      const ids = (params[1] as string[]) ?? [];
      const present = ids.filter((id) => state.specs.has(id)).map((id) => ({ spec_id: id }));
      return { rows: present, rowCount: present.length };
    }
    if (sql.startsWith("INSERT INTO specs")) {
      const specId = String(params[0]);
      // Column order (v68 fix): specId, projectId, org_id, title, description,
      // acceptance_criteria(json), depends_on, status, priority (see projectSpec.ts createSpec).
      const title = String(params[3]);
      const description = String(params[4]);
      const acceptanceCriteria = typeof params[5] === "string" ? (JSON.parse(params[5]) as string[]) : [];
      const dependsOn = (params[6] as string[]) ?? [];
      state.specs.set(specId, { dependsOn, title, description, acceptanceCriteria });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO design_contracts")) {
      // Column params (post-H2 unify — migration 0028): id, org_id, project_id,
      // domain, contract(json text). The `version` is computed in-statement
      // (COALESCE(MAX)+1) → stub it as 1.
      const rawContract = params[4];
      const contract = typeof rawContract === "string" ? (JSON.parse(rawContract) as Record<string, unknown>) : {};
      state.designContracts.push(contract);
      return {
        rows: [
          {
            id: params[0],
            org_id: params[1],
            project_id: params[2],
            version: 1,
            domain: params[3],
            contract,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO personas")) {
      state.personas += 1;
      personaIds.add(String(params[0]));
      // The metadata jsonb is the 7th column (params[6], JSON text) — capture it so
      // a test can assert the persona `surface` is persisted there (no `surface` column).
      const rawMeta = params[6];
      const metadata = typeof rawMeta === "string" ? (JSON.parse(rawMeta) as Record<string, unknown>) : {};
      state.personaMetadata.push(metadata);
      return {
        rows: [
          {
            id: params[0],
            scope: params[1],
            org_id: params[2],
            project_id: params[3],
            name: params[4],
            description: params[5],
            metadata,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    // PersonaStore.get (authz for behavior create) → return the persona row.
    if (sql.startsWith("SELECT id, scope, org_id, project_id, name, description")) {
      return {
        rows: [
          {
            id: params[0],
            scope: "project",
            org_id: "org_a",
            project_id: "p",
            name: "n",
            description: "d",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO behaviors")) {
      state.behaviors += 1;
      return {
        rows: [
          {
            id: params[0],
            persona_id: params[1],
            title: params[2],
            given: params[3],
            when: params[4],
            then: params[5],
            description: params[6],
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO milestones")) {
      state.milestones += 1;
      return {
        rows: [
          {
            id: params[0],
            project_id: params[1],
            label: params[2],
            name: params[3],
            description: params[4],
            order_index: params[5],
            eta: params[6],
            status: params[7],
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("DELETE FROM spec_milestones")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO spec_milestones")) {
      state.specMilestones += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO spec_behaviors")) {
      state.specBehaviors += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    state,
    configs,
  };
}
