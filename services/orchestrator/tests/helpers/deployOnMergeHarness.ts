import { getJobOrgId } from "@tanren/db";
import type pg from "pg";
import { defaultIntegrationResourceConstraints } from "../../src/engine/contracts/integrationAuthority.js";
import { InMemorySecretStore } from "../../src/engine/contracts/secretStore.js";
import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import type { EventName } from "../../src/engine/events/index.js";
import { DeployOnMergeWatcher } from "../../src/engine/postMerge/deployOnMerge.js";
import type { ScriptedDeployTransport } from "../conformance/fakes/scriptedDeployTransport.js";
import { instantVerifyPollPolicy, scriptedUrlProbe } from "../conformance/fakes/scriptedUrlProbe.js";

export const RUN_ID = "run_dep";
export const PROJECT_ID = "project_dep";
export const ORG_ID = "org_dep";
export const MERGE_SHA = "abc1234def5678901234567890abcdef12345678";
export const PRIOR_DEPLOYMENT_ID = "vercel_dep_prior";
const PR_URL = "https://github.com/acme/widget/pull/7";

export interface DeployOnMergePoolState {
  merged: boolean;
  config: Record<string, unknown>;
  grant?: { provider_kind: string; credential_ref: string; metadata: Record<string, unknown>; status?: string };
  linkedGrants?: Array<{ provider_kind: string; capabilities?: string[]; credential_ref?: string }>;
  alreadyDeployed?: boolean;
  alreadyVerified?: boolean;
  alreadyFailed?: boolean;
  alreadySkipped?: boolean;
  noMergeSha?: boolean;
  appEnv?: Record<string, unknown>[];
}

export function deployOnMergePool(state: DeployOnMergePoolState): pg.Pool {
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM events e/u.test(sql) && params[1] === "merge.completed") {
      if (!state.merged) return { rows: [], rowCount: 0 };
      const payload = state.noMergeSha === true ? { prNumber: 7 } : { prNumber: 7, mergeSha: MERGE_SHA };
      return {
        rows: [
          {
            event_run_id: RUN_ID,
            event_spec_id: "spec_dep",
            event_project_id: PROJECT_ID,
            event_org_id: ORG_ID,
            payload,
            run_id: RUN_ID,
            run_spec_id: "spec_dep",
            run_project_id: PROJECT_ID,
            run_org_id: ORG_ID,
            pr_url: PR_URL,
            project_org_id: ORG_ID,
            spec_org_id: ORG_ID,
            spec_project_id: PROJECT_ID,
          },
        ],
        rowCount: 1,
      };
    }
    if (/event_type IN \('deploy\.verified', 'deploy\.failed', 'deploy\.skipped'\)/u.test(sql)) {
      return state.alreadyVerified === true || state.alreadyFailed === true || state.alreadySkipped === true
        ? { rows: [{ id: "t1" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/event_type = 'deploy\.triggered'/u.test(sql)) {
      return state.alreadyDeployed === true
        ? { rows: [{ payload: { deploymentId: PRIOR_DEPLOYMENT_ID } }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/SELECT config, org_id FROM projects/u.test(sql)) {
      return { rows: [{ config: state.config, org_id: ORG_ID }], rowCount: 1 };
    }
    if (/SELECT connection_id, grant_id FROM project_integration_grant_selections/u.test(sql)) {
      const selected = state.grant !== undefined && state.grant.provider_kind === params[2];
      return selected
        ? { rows: [{ connection_id: "connection_0", grant_id: "grant_0" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM org_integration_connections c/u.test(sql) && /JOIN org_integration_grants g/u.test(sql)) {
      const grants =
        state.grant === undefined
          ? (state.linkedGrants ?? []).map((grant) => ({
              ...grant,
              metadata: {},
              credential_ref: grant.credential_ref ?? "secret://org/x",
            }))
          : [state.grant];
      if (params.length > 2) {
        const rows = grants.map((grant, index) => ({
          connection_id: `connection_${index}`,
          provider_kind: grant.provider_kind,
          provider_principal_id: `account_${index}`,
          display_name: `account_${index}`,
          principal_metadata: "metadata" in grant ? grant.metadata : {},
          connection_health: "healthy",
          connection_status: "active",
          current_auth_generation: 1,
          grant_id: `grant_${index}`,
          grant_current_generation: 1,
          grant_status: "status" in grant && grant.status === "revoked" ? "revoked" : "active",
          plane: "control",
          environment: "control",
          credential_ref: (grant.credential_ref ?? "secret://org/x").includes("/g/")
            ? (grant.credential_ref ?? "secret://org/x")
            : `${grant.credential_ref ?? "secret://org/x"}/g/1`,
          auth_expires_at: null,
          auth_status: "active",
          capabilities: "capabilities" in grant ? (grant.capabilities ?? []) : ["deploy"],
          operations: ["attach_runtime_env", "deploy", "verify"],
          provider_scopes: [],
          resource_constraints: defaultIntegrationResourceConstraints(),
          policy_revision: "integration-catalog.v2",
          consent_revision: "consent.test",
          grant_expires_at: null,
          grant_generation_status: "active",
          selected_auth_generation: 1,
          selected_grant_generation: 1,
          selected_connection_id: `connection_${index}`,
          selected_grant_id: `grant_${index}`,
        }));
        return { rows, rowCount: rows.length };
      }
      const rows = grants.map((grant, index) => ({
        connection_id: `connection_${index}`,
        grant_id: `grant_${index}`,
        org_id: ORG_ID,
        provider_kind: grant.provider_kind,
        provider_principal_id: `account_${index}`,
        principal_kind: "team",
        display_name: `account_${index}`,
        health: "healthy",
        connection_status: "active",
        current_auth_generation: 1,
        grant_generation: 1,
        grant_status: "active",
        auth_expires_at: null,
        provider_scopes: [],
        operation_id: null,
        operation_stage: null,
        operation_status: null,
        selected_for_project: false,
        capabilities: "capabilities" in grant ? (grant.capabilities ?? []) : ["deploy"],
      }));
      return { rows, rowCount: rows.length };
    }
    if (/FROM project_app_env[\s\S]*WHERE org_id/u.test(sql)) {
      const rows = (state.appEnv ?? []).map((row, index) => ({
        id: `env_${index}`,
        org_id: ORG_ID,
        project_id: PROJECT_ID,
        environment: "production",
        binding_id: null,
        binding_generation: null,
        secret_generation: row["value_ref"] === null ? null : 1,
        description: "",
        ...row,
      }));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

export class RecordingDeployEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: unknown; ambientOrgId?: string }> = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({ eventType: input.eventType, payload: input.payload, ambientOrgId: getJobOrgId() });
  }
}

export function deploySecrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: "secret://org/deploy-token", value: "deploy_token" });
  void store.put({ ref: "secret://org/deploy-token/g/1", value: "deploy_token" });
  void store.put({ ref: "secret://proj/resend", value: "re_live_secret" });
  return store;
}

export const VERCEL_APP_ID = "vercel_app_1";
export const VERCEL_TARGET = { version: 1, deployProvider: "deploy.vercel", deployAppId: VERCEL_APP_ID };
export const VERCEL_GRANT = {
  provider_kind: "deploy.vercel",
  credential_ref: "secret://org/deploy-token",
  metadata: { teamId: "team_abc", slug: "acme" },
  status: "linked",
};

export async function runDeployOnMerge(
  state: DeployOnMergePoolState,
  transport: ScriptedDeployTransport,
  events: RecordingDeployEventStore,
): Promise<void> {
  const watcher = new DeployOnMergeWatcher({
    pool: deployOnMergePool(state),
    secrets: deploySecrets(),
    transport,
    eventStore: events,
    urlProbe: scriptedUrlProbe(),
    verifyPoll: instantVerifyPollPolicy(),
  });
  await watcher.check(RUN_ID);
}
