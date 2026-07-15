// Plane B resolution coverage: `resolveAppEnvForScope` returns ONLY the entries
// whose scopes include the requested phase, resolves secret value_refs via the
// SecretStore (never the value from the DB), materializes plain values inline,
// and never leaks an out-of-scope entry. A misconfigured secret ref fails loudly.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { systemActor } from "../src/engine/state/actor.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { AppEnvironmentStore } from "../src/engine/repositories/appEnvironment.js";
import { resolveAppEnvForScope } from "../src/engine/workflow/resolveAppEnv.js";

// A minimal single-project in-memory pg target for the app-env table. RLS is not
// the concern here (the repo conformance covers it); this only models the rows so
// the resolver's scope-filtering + secret-resolution can be exercised.
class AppEnvDb {
  readonly rows: Record<string, unknown>[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(
    rawSql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (/INSERT INTO project_app_env/u.test(sql)) {
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
      ] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string[],
        string,
        string | null,
        number | null,
        number | null,
        string,
      ];
      const row = {
        id,
        org_id: orgId,
        project_id: projectId,
        environment,
        key,
        value_ref: valueRef,
        plain_value: plainValue,
        scopes,
        source,
        binding_id: bindingId,
        binding_generation: bindingGeneration,
        secret_generation: secretGeneration,
        description,
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM project_app_env WHERE org_id = \$1/u.test(sql)) {
      const [orgId, projectId, environment] = params as [string, string, string];
      const rows = this.rows.filter(
        (r) => r["org_id"] === orgId && r["project_id"] === projectId && r["environment"] === environment,
      );
      return { rows, rowCount: rows.length };
    }
    throw new Error(`AppEnvDb: unrecognized SQL: ${sql}`);
  }
}

async function seed(db: AppEnvDb): Promise<void> {
  const client = db as unknown as Pick<pg.Pool, "query">;
  await AppEnvironmentStore.upsert(
    client,
    {
      orgId: "org_1",
      projectId: "proj",
      environment: "test",
      key: "RESEND_API_KEY",
      valueRef: "secret://proj/resend",
      secretGeneration: 1,
      scopes: ["test", "runtime"],
    },
    systemActor,
  );
  await AppEnvironmentStore.upsert(
    client,
    {
      orgId: "org_1",
      projectId: "proj",
      environment: "test",
      key: "DEV_ONLY",
      plainValue: "dev-value",
      scopes: ["dev"],
    },
    systemActor,
  );
  await AppEnvironmentStore.upsert(
    client,
    {
      orgId: "org_1",
      projectId: "proj",
      environment: "test",
      key: "PUBLIC_URL",
      plainValue: "https://app.example",
      scopes: ["build", "test"],
    },
    systemActor,
  );
}

describe("resolveAppEnvForScope", () => {
  it("returns only entries whose scopes include the phase; resolves secrets via the SecretStore", async () => {
    const db = new AppEnvDb();
    await seed(db);
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "secret://proj/resend", value: "re_live_xyz" });

    const testEnv = await resolveAppEnvForScope({
      client: db as unknown as Pick<pg.Pool, "query">,
      secrets,
      orgId: "org_1",
      projectId: "proj",
      environment: "test",
      scope: "test",
      actor: systemActor,
    });
    // test scope: RESEND (secret, resolved) + PUBLIC_URL (plain). NOT DEV_ONLY.
    expect(testEnv).toEqual({ RESEND_API_KEY: "re_live_xyz", PUBLIC_URL: "https://app.example" });
    expect(testEnv).not.toHaveProperty("DEV_ONLY");
  });

  it("a dev-scoped entry never appears in build/runtime resolution", async () => {
    const db = new AppEnvDb();
    await seed(db);
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "secret://proj/resend", value: "re_live_xyz" });

    const buildEnv = await resolveAppEnvForScope({
      client: db as unknown as Pick<pg.Pool, "query">,
      secrets,
      orgId: "org_1",
      projectId: "proj",
      environment: "test",
      scope: "build",
      actor: systemActor,
    });
    // build scope: only PUBLIC_URL.
    expect(buildEnv).toEqual({ PUBLIC_URL: "https://app.example" });

    const devEnv = await resolveAppEnvForScope({
      client: db as unknown as Pick<pg.Pool, "query">,
      secrets,
      orgId: "org_1",
      projectId: "proj",
      environment: "test",
      scope: "dev",
      actor: systemActor,
    });
    expect(devEnv).toEqual({ DEV_ONLY: "dev-value" });
  });

  it("an unresolved secret ref fails loudly (no silent empty value)", async () => {
    const db = new AppEnvDb();
    await seed(db);
    // The RESEND ref is deliberately NOT put into the store → unresolved.
    const secrets = new FakeSecretStore();
    await expect(
      resolveAppEnvForScope({
        client: db as unknown as Pick<pg.Pool, "query">,
        secrets,
        orgId: "org_1",
        projectId: "proj",
        environment: "test",
        scope: "runtime",
        actor: systemActor,
      }),
    ).rejects.toThrow(/unresolved secret ref/u);
  });
});
