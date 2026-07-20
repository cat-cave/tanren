// TEST FIXTURE ONLY. The in-memory pg.Pool stub + deploy-prep fixture the
// greenfield-onboarding derive tests share (visionInterview.test.ts). It tracks
// the derive path's INSERTs (keyed by SQL substring, like the discovery engine-test
// stub) so a test can assert the created project/specs/personas without a real DB.
// No migration is involved — every row lands in an existing table.

/* eslint-disable unicorn/no-thenable */
// `then` is the BDD Given/When/Then field name carried on the mocked behavior row;
// the thenable-object lint does not apply to this plain data literal.

import type pg from "pg";
import type { DeriveInput } from "../../../src/engine/forge/interview/derive.js";
import { handleConfigCasSql } from "../../helpers/routesPoolConfigCas.js";
import { RoutesPoolDerivationEvidence } from "../../helpers/routesPoolDerivationEvidence.js";
import { createRevisionSpineStub } from "../../helpers/revisionSpineMemory.js";

// The `composeDesignSystem` seam is production-required (deriveProductGraph fails
// loud on an absent wire — a dropped seam is a bug, never a silent design-less skip),
// so a full-derive test must wire it. This no-op stands in for the real F2D composer
// (its own integration test exercises the producer); here we only need the seam present.
export const noopComposeDesignSystem: NonNullable<DeriveInput["composeDesignSystem"]> = async () => {};

export const successfulBootstrapProject: NonNullable<DeriveInput["bootstrapProject"]> = async (input) => {
  const fixture = input.pool as pg.Pool & {
    seedDerivationBootstrap?: (orgId: string, projectId: string) => Promise<unknown> | unknown;
  };
  if (fixture.seedDerivationBootstrap === undefined) {
    throw new Error("successfulBootstrapProject requires a derivation-evidence test pool");
  }
  return (await fixture.seedDerivationBootstrap(input.orgId, input.projectId)) as Awaited<
    ReturnType<NonNullable<DeriveInput["bootstrapProject"]>>
  >;
};

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

function restoreMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
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
  const evidence = new RoutesPoolDerivationEvidence();
  const inboxSources: Array<Record<string, unknown>> = [];
  const specRows = new Map<string, { spec_id: string; project_id: string }>();
  const projects = new Map<
    string,
    {
      project_id: string;
      org_id: string;
      name: string;
      repo_url: string;
      default_branch: string;
      runner_image: string;
      allocator: string;
      config: Record<string, unknown>;
      config_revision: number;
      lifecycle: string;
    }
  >();
  const derivations = new Map<string, Record<string, unknown>>();
  const personaIds = new Set<string>();
  const revisionSpine = createRevisionSpineStub();
  let graphSnapshot:
    | {
        specs: typeof state.specs;
        specRows: typeof specRows;
        personaIds: Set<string>;
        personas: typeof evidence.personas;
        behaviors: typeof evidence.behaviors;
        milestones: typeof evidence.milestones;
        designContracts: typeof evidence.designContracts;
        personaCount: number;
        personaMetadata: typeof state.personaMetadata;
        behaviorCount: number;
        milestoneCount: number;
        designContractValues: typeof state.designContracts;
        specMilestones: number;
        specBehaviors: number;
      }
    | undefined;
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql === "BEGIN") {
      graphSnapshot = {
        specs: new Map(state.specs),
        specRows: new Map(specRows),
        personaIds: new Set(personaIds),
        personas: new Map(evidence.personas),
        behaviors: new Map(evidence.behaviors),
        milestones: new Map(evidence.milestones),
        designContracts: new Map(evidence.designContracts),
        personaCount: state.personas,
        personaMetadata: [...state.personaMetadata],
        behaviorCount: state.behaviors,
        milestoneCount: state.milestones,
        designContractValues: [...state.designContracts],
        specMilestones: state.specMilestones,
        specBehaviors: state.specBehaviors,
      };
      return { rows: [], rowCount: 0 };
    }
    if (sql === "COMMIT") {
      graphSnapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "ROLLBACK") {
      if (graphSnapshot !== undefined) {
        restoreMap(state.specs, graphSnapshot.specs);
        restoreMap(specRows, graphSnapshot.specRows);
        personaIds.clear();
        for (const id of graphSnapshot.personaIds) personaIds.add(id);
        restoreMap(evidence.personas, graphSnapshot.personas);
        restoreMap(evidence.behaviors, graphSnapshot.behaviors);
        restoreMap(evidence.milestones, graphSnapshot.milestones);
        restoreMap(evidence.designContracts, graphSnapshot.designContracts);
        state.personas = graphSnapshot.personaCount;
        state.personaMetadata = graphSnapshot.personaMetadata;
        state.behaviors = graphSnapshot.behaviorCount;
        state.milestones = graphSnapshot.milestoneCount;
        state.designContracts = graphSnapshot.designContractValues;
        state.specMilestones = graphSnapshot.specMilestones;
        state.specBehaviors = graphSnapshot.specBehaviors;
      }
      graphSnapshot = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT pg_advisory_")) return { rows: [{}], rowCount: 1 };
    const cas = handleConfigCasSql(sql, params, new Map(), projects);
    if (cas !== undefined) {
      const projectId = String(sql.startsWith("UPDATE projects") ? params[1] : params[0]);
      const project = projects.get(projectId);
      if (project !== undefined) configs.set(projectId, project.config);
      return cas;
    }
    if (!sql.startsWith("INSERT INTO")) {
      const evidenceResult = evidence.handle(sql, params, { projects, specs: specRows, inboxSources });
      if (evidenceResult !== undefined) return evidenceResult;
    }
    if (sql.includes("FROM project_derivations")) {
      const row = sql.includes("AND id = $2")
        ? derivations.get(String(params[1]))
        : sql.includes("idempotency_fingerprint = $2")
          ? [...derivations.values()].find(
              (candidate) => candidate["org_id"] === params[0] && candidate["idempotency_fingerprint"] === params[1],
            )
          : [...derivations.values()].find(
              (candidate) => candidate["org_id"] === params[0] && candidate["project_id"] === params[1],
            );
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO project_derivations")) {
      const existing = [...derivations.values()].find(
        (candidate) => candidate["org_id"] === params[0] && candidate["idempotency_fingerprint"] === params[3],
      );
      if (existing !== undefined) return { rows: [existing], rowCount: 1 };
      const row: Record<string, unknown> = {
        org_id: params[0],
        id: params[1],
        project_id: params[2],
        idempotency_fingerprint: params[3],
        phase: "shell",
        status: "in_progress",
        sanitized_input: JSON.parse(String(params[4])) as unknown,
        sanitized_error: null,
        ownership_receipt: JSON.parse(String(params[5])) as unknown,
        template_receipt: params[6] === null ? null : (JSON.parse(String(params[6])) as unknown),
        result_receipt: {},
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
      };
      derivations.set(String(params[1]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE project_derivations")) {
      const row = derivations.get(String(params[1]));
      if (row === undefined || row["status"] !== "in_progress") return { rows: [], rowCount: 0 };
      if (sql.includes("template_receipt =")) {
        row["template_receipt"] = JSON.parse(String(params[2])) as unknown;
        row["phase"] = params[3];
      } else if (sql.includes("result_receipt = jsonb_set")) {
        (row["result_receipt"] as Record<string, unknown>)[String(params[2])] = JSON.parse(
          String(params[3]),
        ) as unknown;
        row["phase"] = params[4];
      } else if (sql.includes("sanitized_error = $3")) {
        row["sanitized_error"] = JSON.parse(String(params[2])) as unknown;
        return { rows: [], rowCount: 1 };
      } else if (sql.includes("status = 'succeeded'")) {
        row["phase"] = "activate";
        row["status"] = "succeeded";
        row["completed_at"] = new Date();
      }
      row["sanitized_error"] = null;
      row["updated_at"] = new Date();
      return { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("SELECT project_id, name, repo_url") && sql.includes("regexp_replace(repo_url")) {
      const canonical = String(params[0]).replace(/\.git$/u, "");
      const rows = [...projects.values()].filter(
        (item) => item.repo_url.replace(/\.git$/u, "") === canonical && item.org_id === String(params[1]),
      );
      return sql.includes("LIMIT 1")
        ? rows[0] === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [rows[0]], rowCount: 1 }
        : { rows, rowCount: rows.length };
    }
    if (sql.startsWith("INSERT INTO projects")) {
      state.projects.add(String(params[0]));
      const rawConfig = params[6];
      if (typeof rawConfig === "string") {
        configs.set(String(params[0]), JSON.parse(rawConfig) as Record<string, unknown>);
      }
      projects.set(String(params[0]), {
        project_id: String(params[0]),
        name: String(params[1]),
        repo_url: String(params[2]),
        default_branch: String(params[3]),
        runner_image: String(params[4]),
        allocator: String(params[5]),
        config: configs.get(String(params[0])) ?? {},
        config_revision: 1,
        lifecycle: String(params[7]),
        org_id: String(params[8]),
      });
      return { rows: [], rowCount: 1 };
    }
    // Compatibility read for non-CAS project-config consumers.
    if (sql.startsWith("SELECT config FROM projects")) {
      const projectId = String(params[0]);
      return configs.has(projectId)
        ? { rows: [{ config: configs.get(projectId) }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("UPDATE projects") && sql.includes("lifecycle = 'active'")) {
      const project = projects.get(String(params[1]));
      if (project === undefined || project.org_id !== String(params[0]) || project.lifecycle !== "deriving") {
        return { rows: [], rowCount: 0 };
      }
      project.lifecycle = "active";
      return { rows: [{ project_id: project.project_id }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT lifecycle") && sql.includes("FROM projects") && sql.includes("org_id = $1")) {
      const project = projects.get(String(params[1]));
      return project === undefined
        ? { rows: [], rowCount: 0 }
        : {
            rows: [
              {
                lifecycle: project.lifecycle,
                name: project.name,
                repo_url: project.repo_url,
                default_branch: project.default_branch,
              },
            ],
            rowCount: 1,
          };
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
      specRows.set(specId, { spec_id: specId, project_id: String(params[1]) });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO design_contracts")) {
      // Column params (post-H2 unify — migration 0028): id, org_id, project_id,
      // domain, contract(json text). The `version` is computed in-statement
      // (COALESCE(MAX)+1) → stub it as 1.
      const rawContract = params[4];
      const contract = typeof rawContract === "string" ? (JSON.parse(rawContract) as Record<string, unknown>) : {};
      state.designContracts.push(contract);
      evidence.designContracts.set(String(params[0]), {
        id: String(params[0]),
        orgId: String(params[1]),
        projectId: String(params[2]),
        version: 1,
        domain: String(params[3]),
        contract,
      });
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
      evidence.personas.set(String(params[0]), {
        id: String(params[0]),
        orgId: String(params[2]),
        projectId: String(params[3]),
      });
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
      evidence.behaviors.set(String(params[0]), { id: String(params[0]), personaId: String(params[1]) });
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
      evidence.milestones.set(String(params[0]), { id: String(params[0]), projectId: String(params[1]) });
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
    // rv-1 — immutable persona/behavior revision spine mint (deriveBehaviorSpec).
    return revisionSpine(sql, params) ?? { rows: [], rowCount: 0 };
  };
  const pool = {
    query,
    connect: async () => ({ query, release() {} }),
    seedDerivationBootstrap(orgId: string, projectId: string) {
      return evidence.seedBootstrap(orgId, projectId, inboxSources);
    },
  } as unknown as pg.Pool;
  return {
    pool,
    state,
    configs,
  };
}
