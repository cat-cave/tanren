// The intake-poller / audit-scheduler regression (apex v94): the Forge runner-context
// load must run SYSTEM-scoped so a cross-org poll/audit wake with NO ambient org scope
// resolves an EXISTING project instead of misreporting it as ForgeProjectNotFoundError.
//
// The intake poller + audit scheduler wake CROSS-ORG with no ambient org scope and
// resolve a project's forge answerer LAZILY; the answerer's first act is to load the
// project's runner context off the RAW boot pool. Under the NOBYPASSRLS `tanren_app`
// role with no `app.current_org_id` GUC, a raw read of the `projects` (then the
// `organizations`) tenant table is denied by deny-by-default RLS ⇒ ZERO rows ⇒ an
// EXISTING project was misreported as ForgeProjectNotFoundError, stalling both loops.
// The permissive stub pool in forgeProviderFactory.test.ts cannot catch this (it
// ignores scope); this fixture REPRODUCES RLS — a raw read returns zero rows, an
// injected BYPASSRLS system pool always returns rows, and a scoped read returns rows
// only when the GUC matches. So it fails on the pre-fix raw-pool read and passes only
// when the project read is system-scoped AND the credential read is org-scoped.
//
// Kept in its own file so forgeProviderFactory.test.ts stays under the 500-line cap.

import { afterEach, describe, expect, it } from "vitest";
import { allowRuntimePoolAsSystemForTests, resetSystemPool, setSystemPool } from "@tanren/db";
import type pg from "pg";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { RunnerCommand, CommandResult, CommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { buildForgeTriageAnswererFactory, type ForgeAnswererInfra } from "../src/engine/forge/providerFactory.js";

const authJson = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "a", refresh_token: "r" } });

const PROJECT_ROW = {
  runner_image: "ghcr.io/cat-cave/tanren-runner:v0",
  config: { version: 1 },
  org_id: "org_a",
};

const ORG_ROW = {
  config: {
    version: 1,
    defaultCredentials: { defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" } },
  },
};

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

// Replays the Codex answerer's SSH command sequence with a final structured answer.
class ScriptedSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  constructor(private readonly results: CommandResult[]) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    const result = this.results.shift();
    if (result === undefined) throw new Error(`unexpected SSH command: ${command.command}`);
    return result;
  }
}

// The NOBYPASSRLS tenant pool. A RAW `.query` (no txn/GUC) of a tenant table denies
// (ZERO rows); a `.connect()`-checked-out client honors a `SET LOCAL
// app.current_org_id` GUC and returns the `organizations` row only when the GUC matches
// (the real `rls_org_isolation` predicate `id = current_setting('app.current_org_id')`).
function rlsTenantPool() {
  const state = { rawProjectReads: 0, rawOrgReads: 0, scopedOrgReads: 0, gucSeen: [] as string[] };
  const makeClient = () => {
    let guc: string | null = null;
    return {
      async query(text: string, params?: unknown[]) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK)/u.test(text)) return { rows: [] };
        const setLocal = text.match(/SET LOCAL app\.current_org_id = '([^']*)'/u);
        if (setLocal !== null) {
          guc = setLocal[1] ?? null;
          if (guc !== null) state.gucSeen.push(guc);
          return { rows: [] };
        }
        if (text.includes("FROM organizations")) {
          state.scopedOrgReads += 1;
          // RLS: the org row is visible only when the GUC equals the requested id.
          return guc !== null && guc === params?.[0] ? { rows: [ORG_ROW] } : { rows: [] };
        }
        return { rows: [] };
      },
      release() {},
    };
  };
  const pool = {
    // RAW reads carry no GUC ⇒ RLS deny-by-default returns ZERO rows (the pre-fix trap).
    async query(text: string) {
      if (text.includes("FROM projects")) state.rawProjectReads += 1;
      if (text.includes("FROM organizations")) state.rawOrgReads += 1;
      return { rows: [] };
    },
    async connect() {
      return makeClient();
    },
  } as unknown as pg.Pool;
  return Object.assign(state, { pool });
}

// The BYPASSRLS `tanren_system` pool injected via `setSystemPool`: a cross-org read
// returns rows regardless of the (absent) GUC — the narrow privileged role the
// system-scoped project read must run on.
function bypassSystemPool() {
  const state = { projectReads: 0 };
  const client = {
    async query(text: string) {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/u.test(text)) return { rows: [] };
      if (text.includes("FROM projects")) {
        state.projectReads += 1;
        return { rows: [PROJECT_ROW] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  } as unknown as pg.Pool;
  return Object.assign(state, { pool });
}

describe("loadProjectRunnerContext — system-scoped so a no-ambient-scope poll/audit wake resolves the project", () => {
  afterEach(() => {
    // Restore the unit-suite default (runWithSystemScope uses the passed pool) so later
    // tests are unaffected by the explicit BYPASSRLS pool injected below.
    resetSystemPool();
    allowRuntimePoolAsSystemForTests(true);
  });

  it("resolves an EXISTING project's runner context with NO ambient org scope (no ForgeProjectNotFoundError)", async () => {
    const tenant = rlsTenantPool();
    const system = bypassSystemPool();
    // Inject the BYPASSRLS system pool so runWithSystemScope uses it (not the tenant pool).
    setSystemPool(system.pool);

    const triageAnswer = JSON.stringify({
      dedupe: "no match",
      match: "new behavior",
      placement: "auto → queued",
      verdict: "needs_call",
      duplicateOfSpecId: null,
      discoveryVariant: "feature",
    });
    const ssh = new ScriptedSsh([ok(""), ok(""), ok(""), ok('{"type":"done"}\n'), ok(authJson), ok(triageAnswer)]);
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/codex/dev", value: authJson });
    const infra: ForgeAnswererInfra = {
      pool: tenant.pool,
      secrets,
      allocator: new FakeAllocator(),
      ssh,
      identitySecretRef: "runner/test/identity",
    };

    // The poller/scheduler condition: build the answerer and triage with NO ambient
    // org scope established. Pre-fix, the raw-pool project read is RLS-denied and this
    // throws ForgeProjectNotFoundError; post-fix the system-scoped read resolves it.
    const answerer = buildForgeTriageAnswererFactory(infra)({ orgId: "org_a", projectId: "project_a" });
    const verdict = await answerer.triage({
      candidate: { title: "planted issue", body: "b", severity: "warn", sourceKind: "issues", projectId: "project_a" },
      source: {
        id: "s1",
        orgId: "org_a",
        kind: "issues",
        name: "GH",
        projectId: "project_a",
        detail: "",
        config: {},
        enabled: true,
        autoRoute: false,
      },
      existingSpecs: [],
    });

    // The whole load succeeded end-to-end despite the tenant pool DENYING every raw read.
    expect(verdict.verdict).toBe("needs_call");
    // The project read went through the BYPASSRLS system pool — never the raw tenant pool.
    expect(system.projectReads).toBe(1);
    expect(tenant.rawProjectReads).toBe(0);
    // The downstream `organizations` credential read ran under the RESOLVED org scope
    // (GUC set to the project's org), so it saw its row instead of an RLS deny.
    expect(tenant.gucSeen).toContain("org_a");
    expect(tenant.scopedOrgReads).toBeGreaterThan(0);
    expect(tenant.rawOrgReads).toBe(0);
  });
});
