/**
 * Test-only in-memory `IntegrationQueryClient` for the BindingMaterializer's exact
 * statement set. It lets the happy-path + reconcile flow run WITHOUT Postgres for
 * fast unit coverage; the authoritative schema/RLS/FK behavior is proven by
 * `bindingMaterializer.rls.integration.test.ts` against real Postgres.
 *
 * Rows are stored snake_case (as the queries + zod row schemas expect). Statements
 * are dispatched by distinctive fragments — a deliberately small, self-contained
 * surface, not a general SQL engine.
 */
import type { IntegrationQueryClient, IntegrationQueryResult } from "../../src/engine/repositories/integrationQuery.js";

type Row = Record<string, unknown>;

export class BindingMaterializerMemoryDb implements IntegrationQueryClient {
  readonly bindings: Row[] = [];
  readonly generations: Row[] = [];
  readonly env: Row[] = [];
  readonly appEnv: Row[] = [];
  readonly authGenerations: Row[] = [];

  /** Seed a connection auth generation the reconcile join reads for `credential_ref`. */
  seedAuthGeneration(input: {
    orgId: string;
    providerKind: string;
    connectionId: string;
    generation: number;
    credentialRef: string;
  }): void {
    this.authGenerations.push({
      org_id: input.orgId,
      provider_kind: input.providerKind,
      connection_id: input.connectionId,
      generation: input.generation,
      credential_ref: input.credentialRef,
    });
  }

  async query(sql: string, params: unknown[] = []): Promise<IntegrationQueryResult> {
    if (sql.includes("INSERT INTO integration_bindings")) return this.insertBinding(params);
    if (sql.includes("UPDATE integration_bindings")) return this.advanceBinding(params);
    // in-15 proof-gate generation read matches `g.desired_state_hash` too, so its
    // more-specific `g.drift_state` marker must be dispatched FIRST.
    if (sql.includes("g.drift_state")) return this.proofGeneration(params);
    if (sql.includes("g.desired_state_hash")) return this.loadCurrentGeneration(params);
    if (sql.includes("max(generation)")) return this.maxGeneration(params);
    if (sql.includes("INSERT INTO integration_binding_generations")) return this.insertGeneration(params);
    if (sql.includes("INSERT INTO integration_binding_env")) return this.insertEnv(params);
    if (sql.includes("INSERT INTO project_app_env")) return this.upsertAppEnv(params);
    // in-15 proof-gate reads (dispatched before the in-14 shapes they'd otherwise
    // match — `pae.value_ref` / `ready_binding_id` disambiguate; the generation
    // read's `g.drift_state` marker is handled above, before `g.desired_state_hash`).
    if (sql.includes("pae.value_ref")) return this.proofMaterializedOutputs(params);
    if (sql.includes("count(*)::int AS n FROM project_app_env")) return this.proofProvisionedCount(params);
    if (sql.includes("ready_binding_id")) return this.proofReadyBindingIds(params);
    if (sql.includes("SELECT b.id AS binding_id")) return this.readyBindings(params);
    if (sql.includes("FROM integration_binding_env e")) return this.resolvedOutputs(params);
    throw new Error(`BindingMaterializerMemoryDb: unhandled query: ${sql.slice(0, 80)}`);
  }

  private result(rows: Row[]): IntegrationQueryResult {
    return { rows, rowCount: rows.length };
  }

  private insertBinding(p: unknown[]): IntegrationQueryResult {
    const [orgId, id, projectId, requirementId, environment, providerKind, connectionId] = p as string[];
    if (!this.bindings.some((b) => b["org_id"] === orgId && b["id"] === id)) {
      this.bindings.push({
        org_id: orgId,
        id,
        project_id: projectId,
        requirement_id: requirementId,
        environment,
        provider_kind: providerKind,
        connection_id: connectionId,
        current_generation: null,
        status: "pending",
        drift_state: "unknown",
      });
    }
    return this.result([]);
  }

  private advanceBinding(p: unknown[]): IntegrationQueryResult {
    const [orgId, id, generation] = p as [string, string, number];
    const row = this.bindings.find((b) => b["org_id"] === orgId && b["id"] === id);
    if (row !== undefined) {
      row["current_generation"] = generation;
      row["status"] = "ready";
      row["drift_state"] = "in_sync";
    }
    return this.result([]);
  }

  private loadCurrentGeneration(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, bindingId] = p as string[];
    const binding = this.bindings.find(
      (b) =>
        b["org_id"] === orgId &&
        b["project_id"] === projectId &&
        b["id"] === bindingId &&
        b["current_generation"] !== null,
    );
    if (binding === undefined) return this.result([]);
    const gen = this.generations.find(
      (g) =>
        g["org_id"] === orgId &&
        g["project_id"] === projectId &&
        g["binding_id"] === bindingId &&
        g["generation"] === binding["current_generation"],
    );
    if (gen === undefined) return this.result([]);
    return this.result([
      { current_generation: binding["current_generation"], desired_state_hash: gen["desired_state_hash"] },
    ]);
  }

  private maxGeneration(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, bindingId] = p as string[];
    const gens = this.generations
      .filter((g) => g["org_id"] === orgId && g["project_id"] === projectId && g["binding_id"] === bindingId)
      .map((g) => g["generation"] as number);
    return this.result([{ max_generation: gens.length === 0 ? null : Math.max(...gens) }]);
  }

  private insertGeneration(p: unknown[]): IntegrationQueryResult {
    const keys = [
      "org_id",
      "project_id",
      "requirement_id",
      "environment",
      "binding_id",
      "generation",
      "provider_kind",
      "connection_id",
      "auth_generation",
      "grant_id",
      "grant_generation",
      "adapter_version",
      "external_resource_id",
      "external_resource_name",
      "ownership",
      "teardown_policy",
      "desired_state_hash",
      "status",
    ];
    if (
      this.generations.some(
        (g) => g["org_id"] === p[0] && g["project_id"] === p[1] && g["binding_id"] === p[4] && g["generation"] === p[5],
      )
    ) {
      throw new Error("duplicate generation");
    }
    const row: Row = { drift_state: "unknown" };
    keys.forEach((k, i) => (row[k] = p[i]));
    this.generations.push(row);
    return this.result([]);
  }

  private insertEnv(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, bindingId, generation, key, classification, required, scopes] = p;
    if (
      this.env.some(
        (e) =>
          e["org_id"] === orgId &&
          e["project_id"] === projectId &&
          e["binding_id"] === bindingId &&
          e["binding_generation"] === generation &&
          e["key"] === key,
      )
    ) {
      throw new Error("duplicate binding env row");
    }
    this.env.push({
      org_id: orgId,
      project_id: projectId,
      binding_id: bindingId,
      binding_generation: generation,
      key,
      classification,
      required,
      scopes,
    });
    return this.result([]);
  }

  private upsertAppEnv(p: unknown[]): IntegrationQueryResult {
    const [
      orgId,
      id,
      projectId,
      environment,
      key,
      valueRef,
      plainValue,
      scopes,
      source,
      bindingId,
      bindingGeneration,
      secretGeneration,
      description,
    ] = p;
    const existing = this.appEnv.find(
      (r) =>
        r["org_id"] === orgId && r["project_id"] === projectId && r["environment"] === environment && r["key"] === key,
    );
    const row: Row = existing ?? { org_id: orgId, id, project_id: projectId, environment, key };
    Object.assign(row, {
      value_ref: valueRef ?? null,
      plain_value: plainValue ?? null,
      scopes,
      source,
      binding_id: bindingId ?? null,
      binding_generation: bindingGeneration ?? null,
      secret_generation: secretGeneration ?? null,
      description: description ?? "",
    });
    if (existing === undefined) this.appEnv.push(row);
    return this.result([row]);
  }

  private readyBindings(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, environment] = p as string[];
    const rows = this.bindings
      .filter(
        (b) =>
          b["org_id"] === orgId &&
          b["project_id"] === projectId &&
          b["environment"] === environment &&
          b["status"] === "ready" &&
          b["current_generation"] !== null,
      )
      .flatMap((b) => {
        const gen = this.generations.find(
          (g) =>
            g["org_id"] === orgId &&
            g["project_id"] === projectId &&
            g["binding_id"] === b["id"] &&
            g["generation"] === b["current_generation"],
        );
        if (gen === undefined) return [];
        const auth = this.authGenerations.find(
          (a) =>
            a["org_id"] === orgId &&
            a["provider_kind"] === gen["provider_kind"] &&
            a["connection_id"] === gen["connection_id"] &&
            a["generation"] === gen["auth_generation"],
        );
        if (auth === undefined) return [];
        return [
          {
            binding_id: b["id"],
            requirement_id: b["requirement_id"],
            provider_kind: gen["provider_kind"],
            connection_id: gen["connection_id"],
            auth_generation: gen["auth_generation"],
            grant_id: gen["grant_id"],
            grant_generation: gen["grant_generation"],
            adapter_version: gen["adapter_version"],
            external_resource_id: gen["external_resource_id"],
            external_resource_name: gen["external_resource_name"],
            ownership: gen["ownership"],
            teardown_policy: gen["teardown_policy"],
            credential_ref: auth["credential_ref"],
            current_generation: b["current_generation"],
          },
        ];
      });
    return this.result(rows);
  }

  /** in-15: load the ready binding's current generation + lineage for the proof gate. */
  private proofGeneration(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, bindingId, environment] = p as string[];
    const binding = this.bindings.find(
      (b) =>
        b["org_id"] === orgId &&
        b["project_id"] === projectId &&
        b["id"] === bindingId &&
        b["environment"] === environment &&
        b["status"] === "ready" &&
        b["current_generation"] !== null,
    );
    if (binding === undefined) return this.result([]);
    const gen = this.generations.find(
      (g) =>
        g["org_id"] === orgId &&
        g["project_id"] === projectId &&
        g["binding_id"] === bindingId &&
        g["generation"] === binding["current_generation"],
    );
    if (gen === undefined) return this.result([]);
    return this.result([
      {
        current_generation: binding["current_generation"],
        requirement_id: gen["requirement_id"],
        environment: gen["environment"],
        desired_state_hash: gen["desired_state_hash"],
        provider_kind: gen["provider_kind"],
        connection_id: gen["connection_id"],
        auth_generation: gen["auth_generation"],
        grant_id: gen["grant_id"],
        grant_generation: gen["grant_generation"],
        adapter_version: gen["adapter_version"],
        external_resource_id: gen["external_resource_id"],
        external_resource_name: gen["external_resource_name"],
        ownership: gen["ownership"],
        teardown_policy: gen["teardown_policy"],
        status: binding["status"],
        drift_state: binding["drift_state"],
      },
    ]);
  }

  /** in-15: the exact-generation output shape LEFT JOINed onto the materialized rows. */
  private proofMaterializedOutputs(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, bindingId, generation, environment] = p;
    const rows = this.env
      .filter(
        (e) =>
          e["org_id"] === orgId &&
          e["project_id"] === projectId &&
          e["binding_id"] === bindingId &&
          e["binding_generation"] === generation,
      )
      .map((e) => {
        const app = this.appEnv.find(
          (a) =>
            a["org_id"] === orgId &&
            a["project_id"] === projectId &&
            a["binding_id"] === bindingId &&
            a["binding_generation"] === generation &&
            a["environment"] === environment &&
            a["key"] === e["key"],
        );
        return {
          key: e["key"],
          classification: e["classification"],
          required: e["required"],
          scopes: e["scopes"],
          value_ref: app?.["value_ref"] ?? null,
          secret_generation: app?.["secret_generation"] ?? null,
          plain_value: app?.["plain_value"] ?? null,
        };
      })
      .sort((a, b) => (String(a.key) < String(b.key) ? -1 : 1));
    return this.result(rows);
  }

  /** in-15: count the project_app_env rows provisioned under this exact generation. */
  private proofProvisionedCount(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, environment, bindingId, generation] = p;
    const n = this.appEnv.filter(
      (a) =>
        a["org_id"] === orgId &&
        a["project_id"] === projectId &&
        a["environment"] === environment &&
        a["binding_id"] === bindingId &&
        a["binding_generation"] === generation,
    ).length;
    return this.result([{ n }]);
  }

  /** in-15: every ready binding id of the project/environment. */
  private proofReadyBindingIds(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, environment] = p as string[];
    const rows = this.bindings
      .filter(
        (b) =>
          b["org_id"] === orgId &&
          b["project_id"] === projectId &&
          b["environment"] === environment &&
          b["status"] === "ready" &&
          b["current_generation"] !== null,
      )
      .map((b) => ({ ready_binding_id: b["id"] }))
      .sort((a, b) => (String(a.ready_binding_id) < String(b.ready_binding_id) ? -1 : 1));
    return this.result(rows);
  }

  private resolvedOutputs(p: unknown[]): IntegrationQueryResult {
    const [orgId, projectId, bindingId, generation] = p;
    const rows = this.env
      .filter(
        (e) =>
          e["org_id"] === orgId &&
          e["project_id"] === projectId &&
          e["binding_id"] === bindingId &&
          e["binding_generation"] === generation,
      )
      .map((e) => {
        const app = this.appEnv.find(
          (a) =>
            a["org_id"] === orgId &&
            a["project_id"] === projectId &&
            a["binding_id"] === bindingId &&
            a["binding_generation"] === generation &&
            a["key"] === e["key"],
        );
        return {
          key: e["key"],
          classification: e["classification"],
          required: e["required"],
          scopes: e["scopes"],
          plain_value: app?.["plain_value"] ?? null,
        };
      })
      .sort((a, b) => (String(a.key) < String(b.key) ? -1 : 1));
    return this.result(rows);
  }
}
