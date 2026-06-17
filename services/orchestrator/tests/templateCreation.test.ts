// Tests for the template CREATION META-DAG (wave 4) — the `createTemplate(request)`
// orchestration: research → author → build → validate → publish, REUSING the loop
// (a stubbed derive + a stubbed build driver) + the real validation harness + the
// real registry store. The wave's KEY contract:
//   1. a flow producing a VALID template (real gates) → PUBLISHES: the registry has
//      it, status `validated`, the proof attached, `template.registered` emitted.
//   2. a flow producing an INVALID template (no-op typecheck) → does NOT publish
//      (LOUD `TemplateValidationFailedError`), the harness verdict is false, the
//      registry is empty.
// Everything live is a SEAM: research + build are stubbed; derive is stubbed (the
// real `deriveProductGraph` is the production default); the harness runs over a
// scripted SSH (the same shape as templateValidationHarness.test.ts).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { DEFAULT_CI_CONFIG } from "../src/engine/ci/index.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import type { EventStore } from "../src/engine/eventStore.js";
import type { DeriveInput, DeriveResult } from "../src/engine/forge/interview/derive.js";
import type { DagSnapshot, DagSpecNode } from "../src/engine/contracts/dagWalker.js";
import {
  type BuiltTemplate,
  type CreateTemplateDeps,
  createTemplate,
  type TemplateAuditor,
  type TemplateBuildDriver,
  type TemplateBuildRecoveryDeps,
  TemplateBuildRecoveryExhaustedError,
  type TemplateCreationRequest,
  type TemplateResearch,
  type TemplateResearcher,
  TemplateValidationFailedError,
} from "../src/engine/templates/index.js";

// ---- Scripted SSH (mirrors the harness test) -------------------------------
// "real" ⇒ the planted defect makes the gate FAIL (proven). "noop" ⇒ the gate
// passes despite the defect (the v29 no-op typecheck → unproven).
type GateMode = "real" | "noop";
interface ScriptOptions {
  typecheck?: GateMode;
  lint?: GateMode;
  test?: GateMode;
}
class ScriptedSsh implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];
  private readonly planted = new Map<string, string>();
  constructor(private readonly opts: ScriptOptions) {}
  async run(_t: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
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
    // clean-template positive controls all pass
    return ok();
  }
}
function ok(): CommandResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
}
function fail(): CommandResult {
  return { exitCode: 1, stdout: "", stderr: "gate caught it", timedOut: false };
}

// ---- In-memory templates pool (only the store's SQL shapes) ----------------
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

// ---- Recording event store -------------------------------------------------
class RecordingEvents implements EventStore {
  readonly appended: Array<{ eventType: string; payload: unknown; projectId: string }> = [];
  async append(input: { eventType: string; payload: unknown; projectId: string }): Promise<void> {
    this.appended.push({ eventType: input.eventType, payload: input.payload, projectId: input.projectId });
  }
}

// ---- Stub seams ------------------------------------------------------------
const actor: ActorContext = {
  userId: "u1",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

const research: TemplateResearch = {
  researchSources: ["https://example.test/best-practice-ts", "https://example.test/tooling"],
  lifecycle: {
    bootstrap: "pnpm install",
    tier1: "pnpm typecheck && pnpm lint",
    tier2: "pnpm test",
    tier3: "pnpm test:e2e",
    build: "pnpm build",
    deploy: "pnpm deploy",
  },
  tooling: { typecheck: true, lint: true, test: true, mutation: false, junit: true, bdd: true },
  summary: "modern TS/pnpm with tsgo + oxlint + vitest",
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
    release: releaseSpy,
  };
}
// Records whether the creation flow released the validation runner (audit §3.11/4).
let releaseCount = 0;
const releaseSpy = async (): Promise<void> => {
  releaseCount += 1;
};
function buildDriverFor(ssh: ScriptedSsh): TemplateBuildDriver {
  return {
    async build() {
      return builtWith(ssh);
    },
  };
}

// A stub derive: returns a fixed project id (the real deriveProductGraph is the
// production default; this isolates the orchestration from the entity-creation DB).
const stubDerive = async (_pool: pg.Pool, _input: DeriveInput): Promise<DeriveResult> => ({
  projectId: "project_tmpl",
  projectName: "tmpl",
  specIds: ["s1"],
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

function deps(ssh: ScriptedSsh, pool: TemplatesPool, events: RecordingEvents): CreateTemplateDeps {
  return {
    pool: pool.asPgPool(),
    events,
    actor,
    researcher,
    buildDriver: buildDriverFor(ssh),
    deriveOptions: { repoUrl: "https://example.test/repo" },
    derive: stubDerive,
    now: () => new Date("2026-06-09T12:00:00.000Z"),
    timeoutMs: 1000,
  };
}

describe("createTemplate — VALID template publishes (the happy path)", () => {
  it("research→author→build→validate→publish: registry has it, status validated, proof attached, event emitted", async () => {
    const ssh = new ScriptedSsh({ typecheck: "real", lint: "real", test: "real" });
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    releaseCount = 0;

    const result = await createTemplate(deps(ssh, pool, events), request);

    // The validation runner was RELEASED (audit §3.11/4 — no leak on the happy path).
    expect(releaseCount).toBe(1);

    // Published: the registry has exactly one row, status validated.
    expect(pool.rows).toHaveLength(1);
    expect(result.template.status).toBe("validated");
    expect(result.template.repoRef).toBe("cat-cave/tmpl-ts-pnpm");
    expect(result.template.orgId).toBe("org_acme");

    // The proof is attached on the manifest + the verdict was true.
    expect(result.template.manifest.validationProof).not.toBeNull();
    expect(result.proof.positiveControlsPassed).toBe(true);
    expect(result.proof.negativeControls).toEqual({
      typecheck: "proven",
      lint: "proven",
      test: "proven",
      mutation: "n/a",
    });
    expect(result.proof.validatedSha).toBe("a".repeat(40));

    // Provenance: the research sources + the building project id are recorded.
    expect(result.template.manifest.provenance.researchSources).toEqual(research.researchSources);
    expect(result.template.manifest.provenance.createdByRunId).toBe("project_tmpl");

    // Channel defaults to lts; capabilities mirror the researched tooling.
    expect(result.template.manifest.channel).toBe("lts");
    expect(result.template.manifest.capabilities.junit).toBe(true);
    expect(result.template.manifest.capabilities.mutation).toBe(false);
    expect(result.template.manifest.capabilities.gates).toContain("tier-1");
    expect(result.template.manifest.capabilities.gates).toContain("tier-3");

    // OBSERVABILITY (Fix 4): the validation harness runs the REAL gate runner, whose
    // per-gate `gate.*` events must land on the build project's timeline — NOT be
    // swallowed by a no-op sink. Assert the harness narrated `gate.*` events through the
    // real project-scoped sink (the positive-control + negative-control gate runs).
    const gateEvents = events.appended.filter((e) => e.eventType.startsWith("gate."));
    expect(gateEvents.length).toBeGreaterThan(0);
    expect(gateEvents.every((e) => e.projectId === "project_tmpl")).toBe(true);
    expect(events.appended.some((e) => e.eventType === "gate.started")).toBe(true);

    // The template.registered event was emitted with the run/project context.
    const registered = events.appended.find((e) => e.eventType === "template.registered");
    expect(registered).toMatchObject({
      projectId: "project_tmpl",
      payload: { status: "validated", stack: "ts-pnpm", channel: "lts" },
    });

    // DURABLE no-match → creation trail: selection.no_match → creation.started →
    // creation.published, all against the template-build project (never a vanishing log).
    const noMatch = events.appended.find((e) => e.eventType === "template.selection.no_match");
    expect(noMatch).toMatchObject({ projectId: "project_tmpl", payload: { stack: "ts-pnpm", orgId: "org_acme" } });
    const started = events.appended.find((e) => e.eventType === "template.creation.started");
    expect(started).toMatchObject({ projectId: "project_tmpl", payload: { stack: "ts-pnpm" } });
    const published = events.appended.find((e) => e.eventType === "template.creation.published");
    expect(published).toMatchObject({
      projectId: "project_tmpl",
      payload: { stack: "ts-pnpm", repoRef: "cat-cave/tmpl-ts-pnpm" },
    });
    // Ordering: started precedes published.
    const order = events.appended.map((e) => e.eventType);
    expect(order.indexOf("template.creation.started")).toBeLessThan(order.indexOf("template.creation.published"));
  });

  it("forces the template-build derive to scaffold from scratch (scaffoldOrigin=template_build, no registry query)", async () => {
    // The creation flow's derive IS the ONE legitimate from-scratch authoring. Assert
    // it passes `scaffoldOrigin: "template_build"` and NO `templateRegistryQuery` — so
    // a project-direct from-scratch path can never be reached this way.
    const ssh = new ScriptedSsh({ typecheck: "real", lint: "real", test: "real" });
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    let seen: DeriveInput | undefined;
    const d = deps(ssh, pool, events);
    d.derive = async (_pool: pg.Pool, input: DeriveInput): Promise<DeriveResult> => {
      seen = input;
      return {
        projectId: "project_tmpl",
        projectName: "tmpl",
        specIds: ["s1"],
        personaIds: ["p1"],
        behaviorIds: ["b1"],
        milestoneIds: ["m1"],
      };
    };
    await createTemplate(d, request);
    expect(seen?.scaffoldOrigin).toBe("template_build");
    expect(seen?.templateRegistryQuery).toBeUndefined();
  });
});

describe("createTemplate — INVALID template does NOT publish (the fail-closed gate)", () => {
  it("a no-op typecheck → harness verdict false → TemplateValidationFailedError, registry empty, no event", async () => {
    // typecheck is "noop": it PASSES even with the planted type error (the v29 bug).
    const ssh = new ScriptedSsh({ typecheck: "noop", lint: "real", test: "real" });
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    releaseCount = 0;

    await expect(createTemplate(deps(ssh, pool, events), request)).rejects.toBeInstanceOf(
      TemplateValidationFailedError,
    );

    // The validation runner was RELEASED even on the FAIL path (the `finally` —
    // audit §3.11/4: no leak whether validation passes or fails).
    expect(releaseCount).toBe(1);

    // NOT published: the registry is empty, no template.registered/published event.
    expect(pool.rows).toHaveLength(0);
    expect(events.appended.find((e) => e.eventType === "template.registered")).toBeUndefined();
    expect(events.appended.find((e) => e.eventType === "template.creation.published")).toBeUndefined();

    // DURABLE failure record: creation.started fired, then creation.failed (LOUD,
    // never a silent from-scratch), against the template-build project.
    expect(events.appended.find((e) => e.eventType === "template.creation.started")).toBeDefined();
    const failed = events.appended.find((e) => e.eventType === "template.creation.failed");
    expect(failed).toMatchObject({ projectId: "project_tmpl", payload: { stack: "ts-pnpm", orgId: "org_acme" } });
  });

  it("the thrown error carries the failing proof (typecheck unproven) for a LOUD finding", async () => {
    const ssh = new ScriptedSsh({ typecheck: "noop", lint: "real", test: "real" });
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    const error = await createTemplate(deps(ssh, pool, events), request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TemplateValidationFailedError);
    const proof = (error as TemplateValidationFailedError).proof;
    expect(proof.negativeControls.typecheck).toBe("unproven");
    // green-by-accident on a clean tree — the negative control is what exposes it
    expect(proof.positiveControlsPassed).toBe(true);
  });
});

describe("createTemplate — ungrounded research fails LOUD before any build", () => {
  it("research with no sources → throws, never builds or publishes", async () => {
    const ssh = new ScriptedSsh({ typecheck: "real", lint: "real", test: "real" });
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    const d = deps(ssh, pool, events);
    d.researcher = {
      async research() {
        return { ...research, researchSources: [] };
      },
    };
    await expect(createTemplate(d, request)).rejects.toThrow(/ungrounded|no sources/u);
    expect(pool.rows).toHaveLength(0);
  });
});

// ---- Self-recovery: a RESUMED stranded build is auto-requeued, bounded ------
//
// The robustness gap: a template-build is bound to a deterministic slug, so a re-
// trigger RESUMES the SAME (possibly stranded) build project — and re-strands forever.
// On the resume path, BEFORE driving the build, the injected `recovery` seam DETECTS a
// stranded build (terminally-blocked spec, no validated publish) and AUTO-REQUEUES it,
// BOUNDED. These tests inject a fake recovery seam over a fake DAG to prove the wiring.

function recoveryNode(specId: string, phase: DagSpecNode["phase"]): DagSpecNode {
  return { specId, phase, dependsOn: [], priority: "tbd", orderKey: 0 };
}

interface FakeRecovery {
  recovery: TemplateBuildRecoveryDeps;
  reset: string[];
}

function fakeRecovery(opts: {
  events: RecordingEvents;
  nodes: DagSpecNode[];
  priorRecoveries?: number;
  published?: boolean;
  maxAttempts?: number;
}): FakeRecovery {
  const reset: string[] = [];
  const recovery: TemplateBuildRecoveryDeps = {
    loadSnapshot: async (projectId): Promise<DagSnapshot> => ({ projectId, nodes: opts.nodes, archived: false }),
    resetStrandedSpec: async ({ specId }) => {
      reset.push(specId);
      return true;
    },
    // The progress-aware bound reads each prior recovery's progress signal; a bare
    // count here synthesizes that many IDENTICAL no-progress recoveries matching the
    // current snapshot (a stuck build — the case these tests model).
    priorRecoveries: async () => {
      const merged = opts.nodes.filter((n) => n.phase === "done").length;
      const stranded = [...new Set(opts.nodes.filter((n) => n.phase === "terminal_blocked").map((n) => n.specId))].sort(
        (x, y) => (x < y ? -1 : x > y ? 1 : 0),
      );
      return Array.from({ length: opts.priorRecoveries ?? 0 }, () => ({
        mergedCount: merged,
        strandedSpecIds: stranded,
      }));
    },
    hasPublishedValidatedTemplate: async () => opts.published ?? false,
    events: opts.events,
    ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
  };
  return { recovery, reset };
}

describe("createTemplate — RESUME path auto-recovers a stranded template-build", () => {
  it("a resumed build with a terminally-stranded spec is REQUEUED (reset + recovered event), then re-built + published", async () => {
    const ssh = new ScriptedSsh({ typecheck: "real", lint: "real", test: "real" });
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    const { recovery, reset } = fakeRecovery({
      events,
      nodes: [recoveryNode("s1", "done"), recoveryNode("s2", "terminal_blocked")],
    });
    const d = { ...deps(ssh, pool, events), recovery };

    const result = await createTemplate(d, request);

    // The stranded spec was reset to re-drivable BEFORE the build ran (the requeue).
    expect(reset).toEqual(["s2"]);
    const recovered = events.appended.find((e) => e.eventType === "template.build.recovered");
    expect(recovered).toMatchObject({
      projectId: "project_tmpl",
      payload: { stack: "ts-pnpm", requeuedSpecIds: ["s2"], attempt: 1 },
    });
    // And the recovered build re-drove to convergence + published (the stub driver
    // returns a clean built template; the harness validates it) — NOT re-stranded.
    expect(result.template.status).toBe("validated");
    expect(pool.rows).toHaveLength(1);
  });

  it("BOUNDED: after the recovery cap the resume fails LOUD (recovery_exhausted + creation.failed), no publish", async () => {
    const ssh = new ScriptedSsh({ typecheck: "real", lint: "real", test: "real" });
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    const { recovery, reset } = fakeRecovery({
      events,
      nodes: [recoveryNode("s1", "terminal_blocked")],
      priorRecoveries: 3,
      maxAttempts: 3,
    });
    const d = { ...deps(ssh, pool, events), recovery };

    await expect(createTemplate(d, request)).rejects.toBeInstanceOf(TemplateBuildRecoveryExhaustedError);

    // No requeue this time (bounded), nothing published, and the LOUD durable records
    // were emitted (recovery_exhausted + the creation.failed envelope).
    expect(reset).toEqual([]);
    expect(pool.rows).toHaveLength(0);
    expect(events.appended.find((e) => e.eventType === "template.build.recovery_exhausted")).toBeDefined();
    const failed = events.appended.find((e) => e.eventType === "template.creation.failed");
    expect(failed).toMatchObject({ projectId: "project_tmpl", payload: { stack: "ts-pnpm" } });
  });

  it("a build that already PUBLISHED a validated template is NOT recovered (no spec reset)", async () => {
    const ssh = new ScriptedSsh({ typecheck: "real", lint: "real", test: "real" });
    const pool = new TemplatesPool();
    const events = new RecordingEvents();
    const { recovery, reset } = fakeRecovery({
      events,
      nodes: [recoveryNode("s1", "terminal_blocked")],
      published: true,
    });
    const d = { ...deps(ssh, pool, events), recovery };

    await createTemplate(d, request);

    // The succeeded-build short-circuit: no spec was reset, no recovery event emitted.
    expect(reset).toEqual([]);
    expect(events.appended.find((e) => e.eventType === "template.build.recovered")).toBeUndefined();
  });
});
