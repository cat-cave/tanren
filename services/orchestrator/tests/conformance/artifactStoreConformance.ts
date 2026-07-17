import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../../src/engine/design/system/artifactStore.js";

export interface ArtifactStoreConformanceHarness {
  make(): Promise<ArtifactStore>;
}

/** The byte-level behavior every sha256-addressed artifact store must preserve. */
export function describeArtifactStoreConformance(label: string, harness: ArtifactStoreConformanceHarness): void {
  describe(`ArtifactStore conformance: ${label}`, () => {
    it("sha256-addresses and round-trips bytes", async () => {
      const store = await harness.make();
      const bytes = new Uint8Array([0, 1, 2, 255]);
      const digest = await store.put(bytes);

      expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      await expect(store.get(digest)).resolves.toEqual(bytes);
    });

    it("is idempotent for identical bytes", async () => {
      const store = await harness.make();
      const first = await store.put(new Uint8Array([7, 8, 9]));
      const second = await store.put(new Uint8Array([7, 8, 9]));

      expect(second).toBe(first);
    });

    it("does not mutate bytes returned from get", async () => {
      const store = await harness.make();
      const digest = await store.put(new Uint8Array([1, 2, 3]));
      const first = await store.get(digest);
      first[0] = 99;

      await expect(store.get(digest)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    });
  });
}
