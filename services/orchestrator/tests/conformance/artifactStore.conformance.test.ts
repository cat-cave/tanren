import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ArtifactDigestFormatError,
  ArtifactDigestMismatchError,
  ArtifactNotFoundError,
  FilesystemArtifactStore,
} from "../../src/engine/design/system/artifactStore.js";
import { describeArtifactStoreConformance } from "./artifactStoreConformance.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeStore(): Promise<FilesystemArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), "tanren-artifact-store-"));
  roots.push(root);
  return new FilesystemArtifactStore(root);
}

describeArtifactStoreConformance("FilesystemArtifactStore", { make: makeStore });

describe("FilesystemArtifactStore", () => {
  it("rejects malformed and missing content addresses loudly", async () => {
    const store = await makeStore();
    await expect(store.get("not-a-digest")).rejects.toThrow(ArtifactDigestFormatError);
    await expect(store.get(`sha256:${"a".repeat(64)}`)).rejects.toThrow(ArtifactNotFoundError);
  });

  it("rejects a filesystem object whose contents do not match its address", async () => {
    const store = await makeStore();
    const digest = await store.put(new Uint8Array([1, 2, 3]));
    await writeFile(store.pathFor(digest), new Uint8Array([4, 5, 6]));

    await expect(store.get(digest)).rejects.toThrow(ArtifactDigestMismatchError);
  });
});
