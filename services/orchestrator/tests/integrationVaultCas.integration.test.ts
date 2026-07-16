import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { VaultSecretStore } from "../src/engine/contracts/secretStore.js";

const enabled = process.env["TANREN_VAULT_TEST"] === "1";
const describeVault = enabled ? describe : describe.skip;
const addr = process.env["VAULT_ADDR"] ?? "http://127.0.0.1:18200";
const token = process.env["VAULT_TOKEN"] ?? "dev-root-token";
const ref = `integration-live-proof/${randomUUID()}`;
const store = new VaultSecretStore({ addr, token });

describeVault("IN-1 Vault KV v2 create-only wire contract", () => {
  afterAll(async () => {
    await store.delete(ref).catch(() => {});
  });

  it("proves Vault version, CAS=0 first/identical/different, and malformed 400", async () => {
    const health = await fetch(`${addr.replace(/\/$/u, "")}/v1/sys/health`);
    expect(health.ok).toBe(true);
    const healthBody = (await health.json()) as { version?: string };
    expect(healthBody.version).toMatch(/^1\.18\./u);

    await expect(store.putCreateOnly({ ref, value: "same-bytes" })).resolves.toEqual({ status: "created" });
    await expect(store.putCreateOnly({ ref, value: "same-bytes" })).resolves.toEqual({
      status: "already_exists_identical",
    });
    await expect(store.putCreateOnly({ ref, value: "different-bytes" })).resolves.toEqual({
      status: "conflict_different_value",
    });

    const malformed = await fetch(`${addr.replace(/\/$/u, "")}/v1/secret/data/integration-live-malformed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Vault-Token": token },
      body: JSON.stringify({ options: { cas: "not-an-integer" }, data: { value: "never-written" } }),
    });
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as { errors?: string[] };
    expect(body.errors).not.toEqual(["check-and-set parameter did not match the current version"]);
  }, 30_000);
});
