// CREATION-TIME UPGRADE tests (environment-management.md §4.5/§7 P1 — "scaffold-time
// upgrade so new projects start near-latest"). The contract:
//   1. when the template-build project declares an `upgrade` verb, the creation flow
//      INSERTS a gated upgrade DAG node (depending on the build specs) BEFORE driving the
//      build, and emits a durable `template.creation.upgraded` — so the freshly-born
//      template is bumped to latest through the SAME gate (no side path).
//   2. when no upgrade verb is declared (or the project is pinned), it SKIPS LOUDLY — a
//      durable `template.creation.upgrade_skipped`, never a silent no-op.
//   3. a broken upgrade is NOT special-cased here: it routes through the build's existing
//      write→gate self-heal (the inserted node is a normal spec) — the creation flow never
//      hard-fails on the upgrade itself.
//
// Mirrors templateCreation.test.ts: a stubbed research + build driver + derive; the
// creation-upgrade seam is a fake that records what it was asked to insert.

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
  createTemplate,
  type CreationUpgrade,
  type CreationUpgradeInput,
  type CreationUpgradeOutcome,
  type TemplateAuditor,
  type TemplateBuildDriver,
  type TemplateCreationRequest,
  type TemplateResearch,
  type TemplateResearcher,
} from "../src/engine/templates/index.js";

// ---- Scripted SSH (mirrors templateCreation.test.ts) -----------------------
// The negative controls plant a defect into a scratch copy and expect the gate to FAIL
// (so the capability is "proven"). A `real` mode makes the planted defect fail the gate;
// the clean positive controls all pass. These tests always use `real` (we exercise the
// upgrade wiring, not a no-op gate).
type GateMode = "real" | "noop";
class ScriptedSsh implements CommandSubstrate {
  private readonly planted = new Map<string, string>();
  constructor(private readonly opts: { typecheck: GateMode; lint: GateMode; test: GateMode }) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    const cwd = command.cwd ?? "";
    const cmd = command.command;
    if (cmd.includes("base64 -d")) {
      const dir = cmd.match(/(\/[^'"\s]*\/nc-\d+-[a-z]+)/u)?.[1];
      if (dir !== undefined) this.planted.set(dir, dir.match(/nc-\d+-([a-z]+)$/u)?.[1] ?? "");
      return ok();
    }
    if (cmd.startsWith("rm -rf") || cmd.includes("cp -a")) return ok();
    const planted = this.planted.get(cwd);
    if (planted !== undefined) {
      const mode = planted === "typecheck" ? this.opts.typecheck : planted === "lint" ? this.opts.lint : this.opts.test;
      return mode === "real" ? fail() : ok();
    }
    return ok();
  }
}
function ok(): CommandResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
}
function fail(): CommandResult {
  return { exitCode: 1, stdout: "", stderr: "gate caught it", timedOut: false };
}
function greenScriptedSsh(): ScriptedSsh {
  return new ScriptedSsh({ typecheck: "real", lint: "real", test: "real" });
}

class TemplatesPool {
  readonly rows: Array<Record<string, unknown>> = [];
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
  readonly appended: Array<{ eventType: string; payload: unknown; projectId: string }> = [];
  async append(input: { eventType: string; payload: unknown; projectId: string }): Promise<void> {
    this.appended.push({ eventType: input.eventType, payload: input.payload, projectId: input.projectId });
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
  researchSources: ["https://example.test/best-practice-ts"],
  lifecycle: {
    bootstrap: "pnpm install",
    tier1: "pnpm typecheck && pnpm lint",
    tier2: "pnpm test",
    tier3: "pnpm test:e2e",
    build: "pnpm build",
    deploy: "pnpm deploy",
    upgrade: "mise upgrade --bump && mise install && pnpm update --latest",
  },
  tooling: { typecheck: true, lint: true, test: true, mutation: false, junit: true, bdd: true },
  summary: "modern TS/pnpm",
};
const researcher: TemplateResearcher = {
  async research() {
    return research;
  },
};

function builtWith(ssh: ScriptedSsh): BuiltTemplate {
  const cleanAuditor: TemplateAuditor = {
    async openBlockingFindings() {
      return 0;
    },
  };
  return {
    repoRef: "cat-cave/tmpl-ts-pnpm",
    builtSha: "a".repeat(40),
    ssh,
    target: { backend: "ssh" } as RunnerHandle,
    workspacePath: "/ws/tmpl",
    scratchRoot: "/ws/tmpl/.git/tanren-tmp/nc",
    config: DEFAULT_CI_CONFIG,
    auditor: cleanAuditor,
    release: async () => {},
  };
}
function buildDriverFor(ssh: ScriptedSsh): TemplateBuildDriver {
  return {
    async build() {
      return builtWith(ssh);
    },
  };
}

const stubDerive = async (_pool: pg.Pool, _input: DeriveInput): Promise<DeriveResult> => ({
  projectId: "project_tmpl",
  projectName: "tmpl",
  specIds: ["s_scaffold", "s_feature"],
  personaIds: ["p1"],
  behaviorIds: ["b1"],
  milestoneIds: ["m1"],
});

const request: TemplateCreationRequest = {
  stack: "ts-pnpm",
  runtime: "node",
  packageManager: "pnpm",
  framework: "next",
  deployTarget: "vercel",
};

// A fake creation-upgrade seam: records what it was asked to insert and returns a scripted
// outcome (generated | skipped). Lets the orchestration be exercised without a live DAG/DB.
function fakeCreationUpgrade(outcome: CreationUpgradeOutcome): {
  upgrade: CreationUpgrade;
  calls: CreationUpgradeInput[];
} {
  const calls: CreationUpgradeInput[] = [];
  const upgrade: CreationUpgrade = {
    async run(input: CreationUpgradeInput): Promise<CreationUpgradeOutcome> {
      calls.push(input);
      return outcome;
    },
  };
  return { upgrade, calls };
}

function deps(
  ssh: ScriptedSsh,
  pool: TemplatesPool,
  events: RecordingEvents,
  creationUpgrade?: CreationUpgrade,
): CreateTemplateDeps {
  return {
    pool: pool.asPgPool(),
    events,
    actor,
    researcher,
    buildDriver: buildDriverFor(ssh),
    deriveOptions: { repoUrl: "https://example.test/repo" },
    derive: stubDerive,
    ...(creationUpgrade === undefined ? {} : { creationUpgrade }),
    now: () => new Date("2026-06-09T12:00:00.000Z"),
    timeoutMs: 1000,
  };
}

describe("createTemplate — CREATION-TIME upgrade inserts a gated node when a verb is declared", () => {
  it("runs the upgrade seam (depending on the build specs) BEFORE the build + emits template.creation.upgraded", async () => {
    const ssh = greenScriptedSsh();
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    const { upgrade, calls } = fakeCreationUpgrade({ kind: "generated", specId: "s_upgrade" });

    const result = await createTemplate(deps(ssh, pool, events, upgrade), request);

    // The creation-time upgrade ran with the build specs as its `dependsOn` (so the
    // once-at-birth bump gates behind the green scaffold/features).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.projectId).toBe("project_tmpl");
    expect(calls[0]!.dependsOn).toEqual(["s_scaffold", "s_feature"]);

    // The durable observability event fired with the inserted node + the before signal.
    const upgraded = events.appended.find((e) => e.eventType === "template.creation.upgraded");
    expect(upgraded).toMatchObject({
      projectId: "project_tmpl",
      payload: { stack: "ts-pnpm", specId: "s_upgrade", afterSpecIds: ["s_scaffold", "s_feature"] },
    });

    // Ordering: the upgrade ran AFTER creation.started and BEFORE publish (it is inserted
    // before the build is driven to convergence).
    const order = events.appended.map((e) => e.eventType);
    expect(order.indexOf("template.creation.started")).toBeLessThan(order.indexOf("template.creation.upgraded"));
    expect(order.indexOf("template.creation.upgraded")).toBeLessThan(order.indexOf("template.creation.published"));

    // The flow still published (the build converged + validated as before).
    expect(result.template.status).toBe("validated");
    expect(pool.rows).toHaveLength(1);
  });
});

describe("createTemplate — CREATION-TIME upgrade SKIPS LOUDLY when no verb is declared", () => {
  it("emits template.creation.upgrade_skipped (no silent no-op) and still publishes", async () => {
    const ssh = greenScriptedSsh();
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    // The seam refuses because the project declares no upgrade command.
    const { upgrade, calls } = fakeCreationUpgrade({ kind: "skipped", reason: "no_upgrade_command" });

    const result = await createTemplate(deps(ssh, pool, events, upgrade), request);

    expect(calls).toHaveLength(1);
    // The LOUD skip is durable — never a hidden no-op.
    const skipped = events.appended.find((e) => e.eventType === "template.creation.upgrade_skipped");
    expect(skipped).toMatchObject({
      projectId: "project_tmpl",
      payload: { stack: "ts-pnpm", reason: "no_upgrade_command" },
    });
    expect(events.appended.find((e) => e.eventType === "template.creation.upgraded")).toBeUndefined();
    // The build is unaffected — the template still publishes.
    expect(result.template.status).toBe("validated");
    expect(pool.rows).toHaveLength(1);
  });

  it("a pinned project skips loudly with the policy_pinned reason", async () => {
    const ssh = greenScriptedSsh();
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    const { upgrade } = fakeCreationUpgrade({ kind: "skipped", reason: "policy_pinned" });

    await createTemplate(deps(ssh, pool, events, upgrade), request);

    const skipped = events.appended.find((e) => e.eventType === "template.creation.upgrade_skipped");
    expect(skipped).toMatchObject({ payload: { reason: "policy_pinned" } });
  });
});

describe("createTemplate — the creation-time upgrade is bounded + best-effort (never hard-fails the build)", () => {
  it("a seam that THROWS is recorded as a loud skip, not a creation failure (broken bump self-heals via the gate)", async () => {
    const ssh = greenScriptedSsh();
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    const upgrade: CreationUpgrade = {
      async run() {
        throw new Error("transient insert failure");
      },
    };

    // The build still converges + publishes — the upgrade insert error never aborts it.
    const result = await createTemplate(deps(ssh, pool, events, upgrade), request);
    expect(result.template.status).toBe("validated");
    expect(pool.rows).toHaveLength(1);
    // Recorded as a LOUD skip (never a silent swallow), and creation did NOT fail.
    expect(events.appended.find((e) => e.eventType === "template.creation.upgrade_skipped")).toBeDefined();
    expect(events.appended.find((e) => e.eventType === "template.creation.failed")).toBeUndefined();
  });

  it("when NO creation-upgrade seam is wired the flow is unchanged (no event, still publishes)", async () => {
    const ssh = greenScriptedSsh();
    const pool = new TemplatesPool();
    const events = new RecordingEvents();

    const result = await createTemplate(deps(ssh, pool, events), request);
    expect(result.template.status).toBe("validated");
    expect(events.appended.find((e) => e.eventType.startsWith("template.creation.upgrade"))).toBeUndefined();
  });
});
