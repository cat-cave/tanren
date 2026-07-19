// Demos-as-evidence wiring (design doc § "Native Deployment And Demos"): a merged run
// whose deploy is VERIFIED gets its spec's BEHAVIORS exercised against the live deploy
// surface + per-behavior evidence recorded; a run with NO verified deploy is a clean
// no-op; a re-check after a prior demo is idempotent. Driven over a fake pool (the
// watcher's system-scoped reads) + the scripted deploy transport + a scripted web
// probe — no Postgres, no real provider, no live HTTP.

import { describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { defaultIntegrationResourceConstraints } from "../src/engine/contracts/integrationAuthority.js";
import type pg from "pg";
import { getJobOrgId } from "@tanren/db";
import { DemoOnDeployWatcher } from "../src/engine/postMerge/demoOnDeploy.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { ProofBackedWebDemo, type AcceptanceExecutor } from "../src/engine/demo/proofBackedWebDemo.js";
import type { AcceptancePlanLoader } from "../src/engine/verification/acceptance/index.js";
import type { BehaviorVerdictOutcome } from "../src/engine/contracts/runtimeVerificationAdapters.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { scriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";

const RUN_ID = "run_demo";
const SPEC_ID = "spec_demo";
const PROJECT_ID = "proj_demo";
const ORG_ID = "org_demo";
const APP_ID = "vercel_app_1";
const DEPLOYMENT_ID = "vercel_deploy_1";

interface BehaviorSeed {
  id: string;
  title: string;
  surfacePath?: string;
}

interface PoolState {
  /** Whether a `deploy.verified` event exists for the run. */
  verified: boolean;
  /**
   * Whether a prior TERMINAL demo outcome exists for the run — `demo.completed`
   * OR `demo.failed`. BOTH gate `check()` to a no-op via `alreadyTerminalDemo`
   * (mirrors deployOnMerge's `alreadyTerminal`). Without the failed gate the
   * `demo.failed` NOTIFY re-wakes the subscriber, re-appends `demo.failed`, and
   * storms `warn`s per merge.
   */
  alreadyTerminalDemo?: boolean;
  /** The org connection/grant authority row for the deploy provider. */
  grant?: { provider_kind: string; credential_ref: string; metadata: Record<string, unknown> };
  /** The spec's behaviors (returned by BehaviorStore.listForSpec). */
  behaviors: BehaviorSeed[];
  projectOwnerOrgId?: string;
  authorityReads?: { count: number };
}

const VERCEL_GRANT = {
  provider_kind: "deploy.vercel",
  credential_ref: "secret://org/deploy-token/g/1",
  metadata: { teamId: "team_abc", slug: "acme" },
};

function fakePool(state: PoolState): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string, params: readonly unknown[] = []) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/FROM events e/u.test(sql) && params[1] === "deploy.verified") {
      if (!state.verified) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            event_run_id: RUN_ID,
            event_spec_id: null,
            event_project_id: PROJECT_ID,
            event_org_id: ORG_ID,
            payload: { provider: "deploy.vercel", appId: APP_ID, deploymentId: DEPLOYMENT_ID },
            run_id: RUN_ID,
            run_spec_id: SPEC_ID,
            run_project_id: PROJECT_ID,
            run_org_id: ORG_ID,
            pr_url: "https://github.com/acme/widget/pull/1",
            project_org_id: state.projectOwnerOrgId ?? ORG_ID,
            spec_org_id: ORG_ID,
            spec_project_id: PROJECT_ID,
          },
        ],
        rowCount: 1,
      };
    }
    if (/SELECT EXISTS \(/u.test(sql) && /demo\.completed/u.test(sql)) {
      return { rows: [{ demoed: state.alreadyTerminalDemo === true }], rowCount: 1 };
    }
    // loadVerifiedDeploy: the deploy.verified event + run/project + a prior TERMINAL
    // demo flag. The `demoed` EXISTS subquery targets `demo.completed` OR
    // `demo.failed` — both wake the run-activity bus, so gating on the failed
    // outcome too breaks the demo.failed self-loop storm (Codex round-3 #2).
    if (/event_type = 'deploy\.verified'/u.test(sql)) {
      if (!state.verified) return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            payload: { provider: "deploy.vercel", appId: APP_ID, deploymentId: DEPLOYMENT_ID },
            spec_id: SPEC_ID,
            project_id: PROJECT_ID,
            org_id: ORG_ID,
            demoed: state.alreadyTerminalDemo === true,
          },
        ],
        rowCount: 1,
      };
    }
    // The org grant lookup (demoSurface resolution). `status` is NOT NULL DEFAULT
    // 'linked' on the real row; the store decodes it via the validated read seam.
    if (/SELECT connection_id, grant_id FROM project_integration_grant_selections/u.test(sql)) {
      const selected = state.grant !== undefined && state.grant.provider_kind === params[2];
      return selected
        ? { rows: [{ connection_id: "connection_demo", grant_id: "grant_demo" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (/FROM org_integration_connections c/u.test(sql)) {
      if (state.authorityReads !== undefined) state.authorityReads.count += 1;
      if (state.grant === undefined) return { rows: [], rowCount: 0 };
      // authorizeOperation eligibility row (selected generations match).
      if (/project_integration_grant_selections/u.test(sql) || /selected_auth_generation/u.test(sql)) {
        const credentialRef = (state.grant.credential_ref ?? "secret://org/deploy-token/g/1").includes("/g/")
          ? (state.grant.credential_ref ?? "secret://org/deploy-token/g/1")
          : `${state.grant.credential_ref ?? "secret://org/deploy-token"}/g/1`;
        return {
          rows: [
            {
              connection_id: "connection_demo",
              provider_kind: state.grant.provider_kind,
              provider_principal_id: "account_demo",
              display_name: "account_demo",
              principal_metadata: state.grant.metadata ?? {},
              connection_health: "healthy",
              connection_status: "active",
              current_auth_generation: 1,
              grant_id: "grant_demo",
              grant_current_generation: 1,
              grant_status: "active",
              plane: "control",
              environment: "control",
              credential_ref: credentialRef,
              auth_expires_at: null,
              auth_status: "active",
              capabilities: ["deploy"],
              operations: ["resolve_demo_surface"],
              provider_scopes: [],
              resource_constraints: defaultIntegrationResourceConstraints(),
              policy_revision: "integration-catalog.v2",
              consent_revision: "consent.test",
              grant_expires_at: null,
              grant_generation_status: "active",
              selected_auth_generation: 1,
              selected_grant_generation: 1,
              selected_connection_id: "connection_demo",
              selected_grant_id: "grant_demo",
            },
          ],
          rowCount: 1,
        };
      }
      return {
        rows: [
          {
            connection_id: "connection_demo",
            grant_id: "grant_demo",
            org_id: ORG_ID,
            provider_kind: state.grant.provider_kind,
            provider_principal_id: "account_demo",
            principal_kind: "team",
            display_name: "account_demo",
            health: "healthy",
            connection_status: "active",
            current_auth_generation: 1,
            grant_generation: 1,
            grant_status: "active",
            auth_expires_at: null,
            provider_scopes: [],
            operation_id: null,
            operation_stage: null,
            operation_status: null,
            selected_for_project: true,
          },
        ],
        rowCount: 1,
      };
    }
    // ReleaseInstancesStore.listForProject — the run's deployed release, carrying the
    // behavior revisions the proof-backed web demo proves + the live URL. Bound to the
    // run's integration node (rv-6 binds `integration_node_id == runId`).
    if (/FROM release_instances ri/u.test(sql)) {
      return {
        rows: [
          {
            org_id: ORG_ID,
            id: "ri_demo",
            project_id: PROJECT_ID,
            provider: "deploy.vercel",
            app_id: APP_ID,
            environment: "production",
            deployment_id: DEPLOYMENT_ID,
            source_ref: "abcdef",
            artifact_digest: `sha256:${"a".repeat(64)}`,
            provider_checksum: null,
            integration_node_id: RUN_ID,
            url: `https://${DEPLOYMENT_ID}.vercel.app`,
            region: null,
            previous_release_instance_id: null,
            state: "live",
            created_at: new Date(),
            behavior_revision_ids: state.behaviors.map((b) => b.id),
          },
        ],
        rowCount: 1,
      };
    }
    // BehaviorStore.listForSpec join.
    if (/FROM behaviors b/u.test(sql) || /INNER JOIN spec_behaviors/u.test(sql)) {
      return {
        rows: state.behaviors.map((b) => ({
          id: b.id,
          persona_id: "persona_1",
          title: b.title,
          given: "",
          when: "",
          // "then" is the BDD Given/When/Then column name, not a thenable.
          // eslint-disable-next-line unicorn/no-thenable
          then: "",
          description: null,
          metadata: b.surfacePath === undefined ? {} : { surfacePath: b.surfacePath },
          created_at: new Date(),
          updated_at: new Date(),
        })),
        rowCount: state.behaviors.length,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: Record<string, unknown>; ambientOrgId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({
      eventType: input.eventType,
      payload: input.payload as Record<string, unknown>,
      ambientOrgId: getJobOrgId(),
    });
  }
}

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: "secret://org/deploy-token/g/1", value: "deploy_token" });
  return store;
}

// A scripted PROOF-BACKED web demo: the real ProofBackedWebDemo mapping over a scripted
// acceptance executor (returns a per-behavior acceptance verdict keyed by behavior-revision
// id) + a plan loader that mints one plan per behavior revision. Exercises the real
// classify → evidence → demo.* event mapping without a live orchestrator/HTTP/Postgres.
function scriptedProofBackedDemo(
  events: EventStore,
  outcomeById: Record<string, BehaviorVerdictOutcome>,
): ProofBackedWebDemo {
  const planLoader: AcceptancePlanLoader = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async loadPlans({ behaviorRevisionIds }) {
      return behaviorRevisionIds.map((id) => ({
        planId: `plan_${id}`,
        behaviorRevisionId: id,
        requiredSurfaces: ["api"] as const,
        assertions: [],
        fixtures: [],
        examples: [],
        executionMatrix: {
          browser: [],
          viewport: [],
          locale: [],
          theme: [],
          motion: [],
          contrast: [],
          device: [],
        },
        httpProbes: [],
      }));
    },
  };
  const orchestrator: AcceptanceExecutor = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(request) {
      const behaviors = request.plans.map((plan) => {
        const outcome = outcomeById[plan.behaviorRevisionId] ?? "passed";
        return {
          behaviorRevisionId: plan.behaviorRevisionId,
          planId: plan.planId,
          verdictId: `verdict_${plan.behaviorRevisionId}`,
          outcome,
          requiredAssertionCount: 1,
          executedAssertionCount: outcome === "inconclusive_infrastructure" ? 0 : 1,
          passedAssertionCount: outcome === "passed" ? 1 : 0,
          evidenceLinkRefs: [],
        };
      });
      return {
        runId: "acceptance_run",
        requiredVerdictCount: behaviors.length,
        passedVerdictCount: behaviors.filter((b) => b.outcome === "passed").length,
        runtimeBehaviorContextHash: `sha256:${"c".repeat(64)}` as unknown as Digest,
        behaviors,
      };
    },
  };
  // The fake orchestrator ignores the env id, so a stub resolver suffices; the PERSISTING
  // env-bound path is proven in the *.rls.integration demo tests.
  return new ProofBackedWebDemo({
    events,
    planLoader,
    orchestrator,
    resolveEnvironment: { resolveForLiveRelease: (liveRelease) => Promise.resolve(liveRelease.integrationNodeId) },
  });
}

async function run(
  state: PoolState,
  events: RecordingEventStore,
  proofBackedWebDemo?: ProofBackedWebDemo,
  transport = scriptedDeployTransport("vercel", ["acme-web"]),
): Promise<void> {
  const watcher = new DemoOnDeployWatcher({
    pool: fakePool(state),
    secrets: secrets(),
    transport,
    eventStore: events,
    ...(proofBackedWebDemo !== undefined && { proofBackedWebDemo }),
  });
  await watcher.check(RUN_ID);
}

describe("DemoOnDeployWatcher (proof-backed demos-as-evidence wiring)", () => {
  it("PROOF-BACKED: routes the web deploy to the acceptance-driven demo + records the real per-behavior verdict", async () => {
    const events = new RecordingEventStore();
    // The release delivers two behaviors; acceptance PASSES one and reports a
    // `failed_product` for the other (its declared behavior failed on the live surface).
    const demo = scriptedProofBackedDemo(events, { beh_links: "passed", beh_admin: "failed_product" });
    await run(
      {
        verified: true,
        grant: VERCEL_GRANT,
        behaviors: [
          { id: "beh_links", title: "Create a short link" },
          { id: "beh_admin", title: "View the admin dashboard" },
        ],
      },
      events,
      demo,
    );

    // One evidence event per behavior, org-scoped, + a demo.completed summary. The demo
    // verdict is the REAL acceptance verdict (1 passed, 1 failed_product) — not a `/`-probe.
    const recorded = events.appends.filter((a) => a.eventType === "demo.evidence.recorded");
    expect(recorded).toHaveLength(2);
    expect(recorded.every((a) => a.ambientOrgId === ORG_ID)).toBe(true);
    expect(JSON.stringify(recorded)).toContain("failed_product");
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "web_url", behaviorCount: 2, passed: 1, failed: 1 });
    expect(JSON.stringify(events.appends)).not.toContain("deploy_token");
  });

  it("is a clean NO-OP when the run has no verified deploy (no demo, no error)", async () => {
    const events = new RecordingEventStore();
    await run({ verified: false, behaviors: [] }, events);
    expect(events.appends).toEqual([]);
  });

  it("is idempotent on demo.completed: a re-check after a prior successful demo records nothing new", async () => {
    const events = new RecordingEventStore();
    await run(
      {
        verified: true,
        alreadyTerminalDemo: true,
        grant: VERCEL_GRANT,
        behaviors: [{ id: "beh_x", title: "X" }],
      },
      events,
    );
    expect(events.appends).toEqual([]);
  });

  // A demo.failed append fires a `tanren_run` NOTIFY that wakes the post-merge
  // subscriber (per eventStore.ts) → without gating on demo.failed as TERMINAL,
  // the next pass re-enters check(), re-throws in resolveSurface (grant still
  // lost / provider read still failing), re-appends demo.failed, and storms
  // `warn`s per merge. Regression pin for Codex round-3 audit finding #2:
  // demoOnDeployReads must include demo.failed in the terminal IN clause
  // (mirrors deployOnMerge's alreadyTerminal unification of verified/failed/
  // skipped).
  it("is TERMINAL on demo.failed: a re-check after a prior failure is a no-op (no self-loop storm)", async () => {
    const events = new RecordingEventStore();
    await run(
      {
        verified: true,
        // A prior demo.failed exists on the run — same TERMINAL gate as
        // demo.completed. No grant seeded either: without the terminal gate the
        // watcher would throw "no matching grant" again + re-append demo.failed.
        alreadyTerminalDemo: true,
        behaviors: [{ id: "beh_x", title: "X" }],
      },
      events,
    );
    // The terminal gate held — no new demo.failed (and no demo.completed either).
    expect(events.appends).toEqual([]);
  });

  it("fails LOUD (proof-backed) when the release delivered no declared behaviors — nothing to prove, never a fabricated pass", async () => {
    const events = new RecordingEventStore();
    const demo = scriptedProofBackedDemo(events, {});
    await expect(run({ verified: true, grant: VERCEL_GRANT, behaviors: [] }, events, demo)).rejects.toThrow(
      /delivered no behavior revisions/u,
    );
    expect(events.appends.filter((a) => a.eventType === "demo.completed")).toEqual([]);
    const failed = events.appends.find((a) => a.eventType === "demo.failed");
    expect(failed!.payload["reason"]).toBe("load_behaviors_failed");
    expect(failed!.payload["surfaceKind"]).toBe("web_url");
  });

  it("fails LOUD when the verified deploy's org grant has gone missing (never a silent skip)", async () => {
    const events = new RecordingEventStore();
    await expect(run({ verified: true, behaviors: [{ id: "b", title: "B" }] }, events)).rejects.toThrow(
      /no matching grant/u,
    );
  });

  it("records a DURABLE demo.failed when resolveSurface throws (grant lost mid-flight)", async () => {
    // Mirrors the deploy.failed durable-failure discipline: a demo that reached the
    // watcher (verified deploy, not yet demoed) but died in resolveSurface must record
    // a DURABLE `demo.failed` under the org scope BEFORE re-throwing, so the operator
    // + run timeline SEE the demo failure rather than a subscriber-swallowed log.error.
    // (No grant seeded → resolveSurface throws the "no matching grant" hard error.)
    const events = new RecordingEventStore();
    await expect(run({ verified: true, behaviors: [{ id: "b", title: "B" }] }, events)).rejects.toThrow(
      /no matching grant/u,
    );
    const failed = events.appends.find((a) => a.eventType === "demo.failed");
    expect(failed).toBeDefined();
    expect(failed!.ambientOrgId).toBe(ORG_ID);
    expect(failed!.payload["reason"]).toBe("resolve_surface_failed");
    // The detail is a FIXED non-secret summary — NOT the raw error (which can carry
    // provider text). The full error is preserved in the run logs via the re-throw.
    expect(failed!.payload["detail"]).toContain("resolve the deployed exercise surface");
    expect(failed!.payload["provider"]).toBe("deploy.vercel");
    // A resolve-surface throw never got a kind — surfaceKind is honestly absent.
    expect(failed!.payload["surfaceKind"]).toBeUndefined();
    // No secret material reached the event.
    expect(JSON.stringify(failed)).not.toContain("deploy_token");
  });

  it("rejects a foreign project owner before demo authority or provider I/O", async () => {
    const authorityReads = { count: 0 };
    const transport = scriptedDeployTransport("vercel", ["acme-web"]);
    const events = new RecordingEventStore();
    await expect(
      run(
        { verified: true, behaviors: [], projectOwnerOrgId: "org_foreign", authorityReads },
        events,
        undefined,
        transport,
      ),
    ).rejects.toThrow(/run lineage mismatch.*does not own its project/u);
    expect(authorityReads.count).toBe(0);
    expect(transport.requestLog()).toEqual([]);
    expect(events.appends).toEqual([]);
  });
});
