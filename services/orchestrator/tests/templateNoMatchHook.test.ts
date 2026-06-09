// Tests for the NO-MATCH AUTO-TRIGGER hook (wave 4) — `maybeCreateTemplateForNoMatch`,
// the "no validated template matches → create one" decision selection calls. It
// composes the wave-1 registry capability query + the wave-4 createTemplate flow:
//   - a VALIDATED template already matches the capabilities → return it (no creation).
//   - NONE matches → run the creation meta-flow + return the new template.
// The registry query is exercised against a tiny in-memory pool that returns the
// rows it holds; creation reuses the same stubbed seams as templateCreation.test.ts.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { DEFAULT_CI_CONFIG } from "../src/engine/ci/index.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { EventStore } from "../src/engine/eventStore.js";
import type { DeriveInput, DeriveResult } from "../src/engine/forge/interview/derive.js";
import {
  type BuiltTemplate,
  type CreateTemplateDeps,
  maybeCreateTemplateForNoMatch,
  type TemplateAuditor,
  type TemplateBuildDriver,
  type TemplateCreationRequest,
  type TemplateResearch,
  type TemplateResearcher,
} from "../src/engine/templates/index.js";

// A clean SSH where every gate catches its planted defect (a creation publishes).
class CleanSsh implements CommandSubstrate {
  private readonly planted = new Set<string>();
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const cmd = command.command;
    if (cmd.includes("base64 -d")) {
      const dir = cmd.match(/(\/[^'"\s]*\/nc-\d+-[a-z]+)/u)?.[1];
      if (dir !== undefined) this.planted.add(dir);
      return ok();
    }
    if (cmd.startsWith("rm -rf") || cmd.includes("cp -a")) return ok();
    return this.planted.has(command.cwd ?? "") ? fail() : ok();
  }
}
function ok(): CommandResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
}
function fail(): CommandResult {
  return { exitCode: 1, stdout: "", stderr: "", timedOut: false };
}

// In-memory pool: handles the INSERT + the SELECT FROM templates (the capability
// query returns whatever rows it holds — capability filtering is the integration
// test's job; here we control matches by pre-seeding/leaving the pool empty).
class TemplatesPool {
  readonly rows: Array<Record<string, unknown>> = [];
  seed(row: Record<string, unknown>): void {
    this.rows.push(row);
  }
  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("INSERT INTO templates")) {
      const [id, orgId, repoRef, manifest, status, channel] = params as string[];
      const row = { id, org_id: orgId, repo_ref: repoRef, manifest: JSON.parse(manifest), status, channel };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("FROM templates")) return { rows: [...this.rows], rowCount: this.rows.length };
    throw new Error(`unhandled SQL: ${sql}`);
  }
  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

class RecordingEvents implements EventStore {
  readonly appended: Array<{ eventType: string }> = [];
  async append(input: { eventType: string }): Promise<void> {
    this.appended.push({ eventType: input.eventType });
  }
}

const actor: ActorContext = {
  userId: "u1",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

const research: TemplateResearch = {
  researchSources: ["https://example.test/a"],
  lifecycle: {
    bootstrap: "pnpm install",
    tier1: "pnpm typecheck",
    tier2: "pnpm test",
    tier3: "pnpm e2e",
    build: "pnpm build",
    deploy: "pnpm deploy",
  },
  tooling: { typecheck: true, lint: true, test: true, mutation: false, junit: false, bdd: false },
  summary: "ts",
};
const researcher: TemplateResearcher = {
  async research() {
    return research;
  },
};

function builtTemplate(): BuiltTemplate {
  const auditor: TemplateAuditor = {
    async openBlockingFindings() {
      return 0;
    },
  };
  return {
    repoRef: "cat-cave/new",
    builtSha: "b".repeat(40),
    ssh: new CleanSsh(),
    target: { backend: "ssh" } as RunnerHandle,
    workspacePath: "/ws",
    scratchRoot: "/ws/.git/tanren-tmp/nc",
    config: DEFAULT_CI_CONFIG,
    auditor,
    release: async () => {},
  };
}
const buildDriver: TemplateBuildDriver = {
  async build() {
    return builtTemplate();
  },
};

const stubDerive = async (_p: pg.Pool, _i: DeriveInput): Promise<DeriveResult> => ({
  projectId: "project_new",
  projectName: "new",
  specIds: [],
  personaIds: [],
  behaviorIds: [],
  milestoneIds: [],
});

const request: TemplateCreationRequest = { stack: "ts", runtime: "node", packageManager: "pnpm" };

function deps(pool: TemplatesPool): CreateTemplateDeps {
  return {
    pool: pool.asPgPool(),
    events: new RecordingEvents(),
    actor,
    researcher,
    buildDriver,
    deriveOptions: { repoUrl: "https://example.test/repo" },
    derive: stubDerive,
    now: () => new Date("2026-06-09T12:00:00.000Z"),
    timeoutMs: 1000,
  };
}

describe("maybeCreateTemplateForNoMatch", () => {
  it("an existing validated template matches → returns it, runs NO creation", async () => {
    const pool = new TemplatesPool();
    pool.seed({
      id: "template_existing",
      org_id: "org_acme",
      repo_ref: "cat-cave/existing",
      status: "validated",
      channel: "lts",
      manifest: {
        version: 1,
        stack: "ts",
        capabilities: {
          runtime: "node",
          packageManager: "pnpm",
          gates: ["tier-1"],
          bdd: false,
          mutation: false,
          junit: false,
        },
        channel: "lts",
        templateVersion: "1.0.0",
        provenance: { researchSources: ["seed"] },
        validationProof: null,
      },
    });

    const decision = await maybeCreateTemplateForNoMatch(deps(pool), request);
    expect(decision).toMatchObject({ created: false, template: { id: "template_existing" } });
    // No new row was inserted (the existing one is the only row).
    expect(pool.rows).toHaveLength(1);
  });

  it("no template matches → runs creation, returns the new validated template", async () => {
    // empty registry → no match → creation runs
    const pool = new TemplatesPool();
    const decision = await maybeCreateTemplateForNoMatch(deps(pool), request);
    expect(decision).toMatchObject({
      created: true,
      result: { template: { status: "validated", repoRef: "cat-cave/new" } },
    });
    expect(pool.rows).toHaveLength(1);
  });
});
