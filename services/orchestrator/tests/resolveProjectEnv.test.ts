import { describe, expect, it } from "vitest";
import type pg from "pg";
import {
  computeEnvKey,
  GOLDEN_BASE_IMAGE,
  resolveGoldenBaseDigest,
  resolveProjectEnv,
} from "../src/engine/environments/index.js";
import { renderMiseToml } from "../src/engine/forge/scaffold/skeleton.js";
import { systemActor } from "../src/engine/state/actor.js";

// Environment management (environment-management.md §3 Layer 4 + §6 + §7 P3) — the
// PER-PROJECT env resolution at the image seam. Proves the three branches the
// design requires WITHOUT a DB (the registry lookup is the only DB touch, faked):
//   - env match     → env.image_ref (the keyed image)
//   - no-match      → the golden base (P4 will JIT-build instead)
//   - no lockfile   → the golden base (a fresh greenfield first boot, today's flow)

const TOOLCHAIN = { node: "22", python: "3.13" } as const;

// A fake QueryClient that returns ONE `environments` row from `getByEnvKey` when
// the looked-up env_key matches, else zero rows. Captures the looked-up env_key so
// the test can assert resolution hashed the toolchain correctly.
type QueryClient = Pick<pg.Pool, "query">;

function fakeClient(opts: { match?: { id: string; imageRef: string } }): {
  client: QueryClient;
  lookups: string[];
} {
  const lookups: string[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (_sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const envKey = String(params?.[0] ?? "");
    lookups.push(envKey);
    if (opts.match === undefined) return { rows: [] };
    return {
      rows: [
        {
          id: opts.match.id,
          org_id: "org_x",
          env_key: envKey,
          image_ref: opts.match.imageRef,
          capabilities: { tools: { ...TOOLCHAIN } },
          channel: "lts",
          status: "validated",
          provenance: { baseDigest: resolveGoldenBaseDigest(), miseLockHash: "abc" },
          validation_proof: null,
        },
      ],
    };
  };
  const client = { query } as unknown as QueryClient;
  return { client, lookups };
}

describe("resolveProjectEnv — per-project env binding at the image seam", () => {
  it("NO toolchain → the golden base (a fresh greenfield first boot, today's flow)", async () => {
    const { client, lookups } = fakeClient({});
    const binding = await resolveProjectEnv(client, { toolchain: undefined }, systemActor);
    expect(binding.imageRef).toBe(GOLDEN_BASE_IMAGE);
    expect(binding.source).toBe("golden-base-no-toolchain");
    expect(binding.envKey).toBeUndefined();
    expect(binding.environmentRef).toBeUndefined();
    // No env_key ⇒ no registry lookup at all.
    expect(lookups).toHaveLength(0);
  });

  it("EMPTY toolchain → the golden base (no env_key, no lookup)", async () => {
    const { client, lookups } = fakeClient({});
    const binding = await resolveProjectEnv(client, { toolchain: {} }, systemActor);
    expect(binding.imageRef).toBe(GOLDEN_BASE_IMAGE);
    expect(binding.source).toBe("golden-base-no-toolchain");
    expect(lookups).toHaveLength(0);
  });

  it("preserves a PINNED project image as the no-toolchain fallback (not the canonical golden base)", async () => {
    const { client } = fakeClient({});
    const binding = await resolveProjectEnv(
      client,
      { toolchain: undefined, baseImage: "ghcr.io/acme/pinned-runner:9" },
      systemActor,
    );
    expect(binding.imageRef).toBe("ghcr.io/acme/pinned-runner:9");
    expect(binding.source).toBe("golden-base-no-toolchain");
  });

  it("a declared toolchain with NO registry match → the golden base (P4 JIT-builds)", async () => {
    const { client, lookups } = fakeClient({});
    const binding = await resolveProjectEnv(client, { toolchain: { ...TOOLCHAIN } }, systemActor);
    expect(binding.imageRef).toBe(GOLDEN_BASE_IMAGE);
    expect(binding.source).toBe("golden-base-no-match");
    // The env_key WAS computed (over the project's rendered mise lockfile).
    const expectedKey = computeEnvKey({ baseDigest: resolveGoldenBaseDigest(), miseLock: renderMiseToml(TOOLCHAIN) });
    expect(binding.envKey).toBe(expectedKey);
    expect(binding.environmentRef).toBeUndefined();
    expect(lookups).toEqual([expectedKey]);
  });

  it("a declared toolchain WITH a validated registry match → env.image_ref", async () => {
    const matchImage = "registry:5000/tanren-env@sha256:abc123";
    const { client, lookups } = fakeClient({ match: { id: "env_match", imageRef: matchImage } });
    const binding = await resolveProjectEnv(client, { toolchain: { ...TOOLCHAIN } }, systemActor);
    expect(binding.imageRef).toBe(matchImage);
    expect(binding.source).toBe("registry-match");
    expect(binding.environmentRef).toBe("env_match");
    const expectedKey = computeEnvKey({ baseDigest: resolveGoldenBaseDigest(), miseLock: renderMiseToml(TOOLCHAIN) });
    expect(binding.envKey).toBe(expectedKey);
    expect(lookups).toEqual([expectedKey]);
  });
});
