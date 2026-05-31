// Seam conformance suite for the SecretStore contract
// (`engine/contracts/secretStore.ts`). Reusable behavior spec invoked once per
// implementation via `describeSecretStoreConformance`. Asserts the put/get/
// delete contract through the public API only — round-trip, get-missing,
// delete-idempotent, and overwrite semantics — never private fields. The same
// fixtures validate the in-memory store and a mocked Vault-backed store.
// Track C §2 of docs/architecture/portability-and-longevity.md.
import { describe, expect, it } from "vitest";
import type { SecretStore } from "../../src/engine/contracts/secretStore.js";

export interface SecretStoreConformanceHarness {
  /** Build a fresh, empty SecretStore under test. */
  make(): SecretStore;
}

/**
 * Behavior spec every SecretStore implementation must pass. Call once per impl:
 *
 *   describeSecretStoreConformance("InMemorySecretStore", {
 *     make: () => new InMemorySecretStore()
 *   });
 */
export function describeSecretStoreConformance(label: string, harness: SecretStoreConformanceHarness): void {
  describe(`SecretStore conformance: ${label}`, () => {
    it("round-trips a stored secret through get()", async () => {
      const store = harness.make();
      await store.put({ ref: "runner/identity", value: "private-key-material" });
      await expect(store.get("runner/identity")).resolves.toEqual({
        ref: "runner/identity",
        value: "private-key-material",
      });
    });

    it("returns undefined for a missing ref", async () => {
      const store = harness.make();
      await expect(store.get("does/not/exist")).resolves.toBeUndefined();
    });

    it("overwrites the value on a repeated put for the same ref", async () => {
      const store = harness.make();
      await store.put({ ref: "credential/token", value: "first" });
      await store.put({ ref: "credential/token", value: "second" });
      await expect(store.get("credential/token")).resolves.toEqual({
        ref: "credential/token",
        value: "second",
      });
    });

    it("delete() removes a stored secret so get() returns undefined", async () => {
      const store = harness.make();
      await store.put({ ref: "credential/token", value: "v" });
      await store.delete("credential/token");
      await expect(store.get("credential/token")).resolves.toBeUndefined();
    });

    it("delete() is idempotent — deleting an absent ref is a no-op", async () => {
      const store = harness.make();
      await expect(store.delete("never/stored")).resolves.toBeUndefined();
      // A second delete of the same (now-absent) ref must also be a no-op.
      await store.put({ ref: "credential/token", value: "v" });
      await store.delete("credential/token");
      await expect(store.delete("credential/token")).resolves.toBeUndefined();
      await expect(store.get("credential/token")).resolves.toBeUndefined();
    });

    it("keeps distinct refs independent", async () => {
      const store = harness.make();
      await store.put({ ref: "a/one", value: "1" });
      await store.put({ ref: "b/two", value: "2" });
      await store.delete("a/one");
      await expect(store.get("a/one")).resolves.toBeUndefined();
      await expect(store.get("b/two")).resolves.toEqual({ ref: "b/two", value: "2" });
    });

    it("list() returns only the refs under the prefix, never values", async () => {
      const store = harness.make();
      await store.put({ ref: "credregistry/one", value: "v1" });
      await store.put({ ref: "credregistry/two", value: "v2" });
      await store.put({ ref: "other/three", value: "v3" });
      const listed = await store.list("credregistry/");
      expect([...listed].sort()).toEqual(["credregistry/one", "credregistry/two"]);
      // The values never leak through list — the contract returns refs only.
      expect(listed.every((ref) => typeof ref === "string")).toBe(true);
    });

    it("list() recovers nested-path refs and reflects deletes", async () => {
      const store = harness.make();
      await store.put({ ref: "credregistry/org/acme/k1", value: "v1" });
      await store.put({ ref: "credregistry/me/alice/k2", value: "v2" });
      await expect(store.list("credregistry/").then((r) => [...r].sort())).resolves.toEqual([
        "credregistry/me/alice/k2",
        "credregistry/org/acme/k1",
      ]);
      await store.delete("credregistry/org/acme/k1");
      await expect(store.list("credregistry/")).resolves.toEqual(["credregistry/me/alice/k2"]);
    });

    it("list() returns [] when nothing matches the prefix", async () => {
      const store = harness.make();
      await store.put({ ref: "credregistry/one", value: "v" });
      await expect(store.list("nothing/here/")).resolves.toEqual([]);
    });
  });
}
