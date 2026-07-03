// addEnvVar reconciliation — task #148 (apex v75 fix).
//
// Locks the CONFLICT-POLICY change: `VirtualFileSystem.addEnvVar` no longer throws
// when the same key is declared twice with a DIFFERENT example. The later
// declaration wins, a reconciliation record is appended to the trail, and the
// composer emits a warn log naming both fragments. Idempotent same-example
// addEnvVar REMAINS a no-op (this is the doctrine-preserving guarantee).
//
// The v75 halt looked like:
//   composeTemplate failed for config "node-pnpm-next-postgres-prisma-none":
//   TemplateComposeError: fragment db-postgres-prisma threw:
//     Error: VirtualFileSystem.addEnvVar: DATABASE_URL declared twice with
//       conflicting examples ("postgres://postgres:postgres@localhost:5432/app" vs
//        "postgresql://tanren:tanren@localhost:5432/tanren")
//
// The composer runs the runtime phase BEFORE db-*, so a JIT-authored runtime
// fragment that generically added `DATABASE_URL="postgres://..."` first was
// halting the compose the moment db-postgres-prisma re-declared it with the
// authoritative `postgresql://...` shape. This test file pins that later-wins is
// the composer's contract + that the isolated VFS surface behaves the same way.

import { describe, expect, it } from "vitest";
import {
  BASE_FRAGMENT_ID,
  composeTemplate,
  DB_POSTGRES_PRISMA_ID,
  type Fragment,
  loadFragmentLibraryForTests,
  RUNTIME_NODE_PNPM_ID,
  type TemplateConfig,
  VirtualFileSystem,
} from "../src/engine/templates/index.js";

describe("VirtualFileSystem.addEnvVar — reconciliation policy (task #148)", () => {
  it("idempotent same-example is a no-op (compose-doctrine-preserved)", () => {
    const vfs = new VirtualFileSystem();
    vfs.addEnvVar("DATABASE_URL", "postgres://tanren:tanren@localhost/tanren");
    vfs.addEnvVar("DATABASE_URL", "postgres://tanren:tanren@localhost/tanren");
    const collected = vfs.collectedEnvVars();
    expect(collected.size).toBe(1);
    expect(collected.get("DATABASE_URL")).toBe("postgres://tanren:tanren@localhost/tanren");
    expect(vfs.envReconciliations()).toEqual([]);
  });

  it("different examples reconcile — LATER wins, previous is recorded", () => {
    const vfs = new VirtualFileSystem();
    vfs.addEnvVar("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/app");
    vfs.addEnvVar("DATABASE_URL", "postgresql://tanren:tanren@localhost:5432/tanren");
    // Later wins.
    expect(vfs.collectedEnvVars().get("DATABASE_URL")).toBe("postgresql://tanren:tanren@localhost:5432/tanren");
    // Trail records the conflict.
    const reconciliations = vfs.envReconciliations();
    expect(reconciliations).toHaveLength(1);
    expect(reconciliations[0]?.key).toBe("DATABASE_URL");
    expect(reconciliations[0]?.previousExample).toBe("postgres://postgres:postgres@localhost:5432/app");
    expect(reconciliations[0]?.currentExample).toBe("postgresql://tanren:tanren@localhost:5432/tanren");
  });

  it("attribution seam records both fragment ids when set", () => {
    const vfs = new VirtualFileSystem();
    vfs.beginFragment("runtime-node-pnpm-next");
    vfs.addEnvVar("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/app");
    vfs.endFragment();
    vfs.beginFragment("db-postgres-prisma");
    vfs.addEnvVar("DATABASE_URL", "postgresql://tanren:tanren@localhost:5432/tanren");
    vfs.endFragment();
    const [record] = vfs.envReconciliations();
    expect(record?.previousDeclaringFragment).toBe("runtime-node-pnpm-next");
    expect(record?.currentDeclaringFragment).toBe("db-postgres-prisma");
  });

  it("throw-on-conflict is GONE — the second declaration must NOT throw", () => {
    const vfs = new VirtualFileSystem();
    vfs.addEnvVar("SOMETHING", "a");
    // Doctrine: this line USED to throw (halted compose). It must now silently
    // reconcile — that is the entire point of task #148.
    expect(() => vfs.addEnvVar("SOMETHING", "b")).not.toThrow();
    expect(vfs.collectedEnvVars().get("SOMETHING")).toBe("b");
  });

  it("multiple different-example calls chain — trail records each", () => {
    const vfs = new VirtualFileSystem();
    vfs.addEnvVar("K", "a");
    vfs.addEnvVar("K", "b");
    vfs.addEnvVar("K", "c");
    expect(vfs.collectedEnvVars().get("K")).toBe("c");
    const trail = vfs.envReconciliations();
    expect(trail.map((r) => `${r.previousExample}->${r.currentExample}`)).toEqual(["a->b", "b->c"]);
  });

  it("idempotent AFTER reconciliation is still a no-op", () => {
    const vfs = new VirtualFileSystem();
    vfs.addEnvVar("K", "a");
    vfs.addEnvVar("K", "b");
    // Same-example after reconciliation — no new reconciliation record.
    vfs.addEnvVar("K", "b");
    expect(vfs.envReconciliations()).toHaveLength(1);
    expect(vfs.collectedEnvVars().get("K")).toBe("b");
  });
});

describe("composeTemplate — runtime-declared DATABASE_URL reconciles with db-* (v75 halt regression)", () => {
  // The v75-halting scenario: a JIT-authored runtime fragment (mocked here as
  // `runtime-node-pnpm-next`) that JIT-added DATABASE_URL BEFORE db-postgres-prisma
  // runs. Under the pre-task-#148 policy the composer HALTED at the db-* fragment;
  // under the fixed policy the db-* declaration wins and compose succeeds.
  //
  // We build this by REPLACING the runtime-node-pnpm fragment with a variant that
  // also declares DATABASE_URL with the runtime writer's guess ("postgres://...").
  // The rest of the runtime contract is preserved so processCiYml + the functional
  // test recognizer + the base invariants still pass.

  const RUNTIME_DATABASE_URL = "postgres://postgres:postgres@localhost:5432/app";
  const DB_DATABASE_URL = "postgresql://tanren:tanren@localhost:5432/tanren";

  it("compose SUCCEEDS + db-*'s DATABASE_URL example wins in .env.example", async () => {
    const library = loadFragmentLibraryForTests();
    const originalRuntime = library.require(RUNTIME_NODE_PNPM_ID);
    // Wrap the real runtime fragment: preserve every declaration, but ADD a
    // DATABASE_URL addEnvVar call BEFORE the db-* fragment runs. This mirrors the
    // v75 finding — the JIT-authored `node-pnpm-next` writer added DATABASE_URL
    // to the runtime because Next.js + Postgres "feels natural".
    const runtimeWithJitDatabaseUrl: Fragment = {
      ...originalRuntime,
      async apply(vfs: VirtualFileSystem, config: TemplateConfig): Promise<void> {
        await originalRuntime.apply(vfs, config);
        vfs.addEnvVar("DATABASE_URL", RUNTIME_DATABASE_URL);
      },
    };
    library.replaceForTests(runtimeWithJitDatabaseUrl);

    const config: TemplateConfig = {
      slug: "v75-runtime-jit-database-url",
      runtime: "node-pnpm",
      db: "postgres-prisma",
      deploy: "none",
      addons: [],
      examples: [],
    };

    // The load-bearing assertion: compose does NOT throw.
    const vfs = await composeTemplate(config, library);

    const envExample = vfs.read(".env.example");
    // The db-* fragment ran AFTER the runtime, so its declaration wins.
    expect(envExample).toContain(`DATABASE_URL=${DB_DATABASE_URL}`);
    // And the runtime's earlier declaration does NOT appear.
    expect(envExample).not.toContain(RUNTIME_DATABASE_URL);
    // The reconciliation trail records the swap, with attribution.
    const trail = vfs.envReconciliations();
    expect(trail).toHaveLength(1);
    expect(trail[0]?.key).toBe("DATABASE_URL");
    expect(trail[0]?.previousExample).toBe(RUNTIME_DATABASE_URL);
    expect(trail[0]?.currentExample).toBe(DB_DATABASE_URL);
    expect(trail[0]?.previousDeclaringFragment).toBe(RUNTIME_NODE_PNPM_ID);
    expect(trail[0]?.currentDeclaringFragment).toBe(DB_POSTGRES_PRISMA_ID);
  });

  it("BASE_FRAGMENT_ID is unchanged (defensive — ensures test setup didn't drift)", () => {
    // Sanity: the constants the setup keys on match the production ids the fix
    // targets. A future rename would break the test loudly rather than turn it
    // into a silent no-op — this pins the invariant.
    expect(BASE_FRAGMENT_ID).toBe("base");
    expect(RUNTIME_NODE_PNPM_ID).toBe("runtime-node-pnpm");
    expect(DB_POSTGRES_PRISMA_ID).toBe("db-postgres-prisma");
  });
});
