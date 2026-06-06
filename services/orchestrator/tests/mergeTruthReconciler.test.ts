import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import type { PullRequestRef, PullRequestState, ResolvedVcsToken } from "../src/engine/contracts/vcsProvider.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgMergeTruthReconciler } from "../src/engine/merge/mergeTruthReconciler.js";
import { InMemoryVcsProvider } from "./conformance/fakes/inMemoryVcsProvider.js";

const PROJECT = "project_apex";
const ORG = "org_acme";
const RUN = "run_child";
const SPEC = "spec_child";
const QUEUE = "mq_child";
const PR_URL = "https://github.com/acme/apex/pull/14";

class ReconcilerPool {
  readonly events: Array<{ eventType: string; payload: unknown }> = [];
  queueStatus: "merged" | "queued" = "merged";
  specStatus: "merged" | "review" = "merged";
  queueUpdateSucceeds = true;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (["BEGIN", "COMMIT", "ROLLBACK", "LOCK TABLE merge_queue IN SHARE ROW EXCLUSIVE MODE"].includes(trimmed)) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SET LOCAL")) return { rows: [], rowCount: 0 };
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      return params[0] === PROJECT ? { rows: [{ org_id: ORG }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("SELECT config FROM organizations WHERE id = $1")) {
      return { rows: [{ config: { version: 1 } }], rowCount: 1 };
    }
    if (trimmed.startsWith("SELECT mq.queue_id")) {
      if (this.queueStatus !== "merged" || this.specStatus !== "merged") return { rows: [], rowCount: 0 };
      return {
        rows: [
          {
            queue_id: QUEUE,
            run_id: RUN,
            spec_id: SPEC,
            org_id: ORG,
            project_id: PROJECT,
            pr_url: PR_URL,
            pr_number: "14",
            project_config: {
              version: 1,
              credentials: {
                codexCredentialRef: "credential/codex/test",
                githubCredentialRef: "credential/github/test",
              },
            },
          },
        ],
        rowCount: 1,
      };
    }
    if (trimmed.startsWith("UPDATE merge_queue")) {
      if (this.queueStatus !== "merged" || !this.queueUpdateSucceeds) return { rows: [], rowCount: 0 };
      this.queueStatus = "queued";
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  async connect(): Promise<ReconcilerPool> {
    return this;
  }

  release(): void {}

  asPgPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

class StateVcsProvider extends InMemoryVcsProvider {
  constructor(private readonly state: PullRequestState) {
    super();
  }

  override async readPullRequestState(_pr: PullRequestRef, _token: ResolvedVcsToken): Promise<PullRequestState> {
    return this.state;
  }
}

function writer(pool: ReconcilerPool): RunStateWriter {
  return {
    append: async (event) => {
      pool.events.push({ eventType: event.eventType, payload: event.payload });
    },
    setSpecStatus: async (input) => {
      expect(input).toEqual({ specId: SPEC, orgId: ORG, status: "review" });
      pool.specStatus = "review";
    },
  } as unknown as RunStateWriter;
}

describe("PgMergeTruthReconciler", () => {
  it("requeues a false merged row when the forge confirms the PR is open and unmerged", async () => {
    const pool = new ReconcilerPool();
    const reconciler = new PgMergeTruthReconciler({
      pool: pool.asPgPool(),
      secrets: new InMemorySecretStore(),
      vcsProvider: new StateVcsProvider({ confirmed: true, open: true, merged: false }),
      runStateWriter: writer(pool),
    });

    await expect(reconciler.reconcile(PROJECT)).resolves.toBe(1);

    expect(pool.queueStatus).toBe("queued");
    expect(pool.specStatus).toBe("review");
    expect(pool.events).toEqual([
      {
        eventType: "merge.false_merged.corrected",
        payload: expect.objectContaining({ prNumber: 14, specId: SPEC, reason: "forge_pr_open_unmerged" }),
      },
    ]);
  });

  it("requeues a false merged row when the forge confirms the PR is closed and unmerged", async () => {
    const pool = new ReconcilerPool();
    const reconciler = new PgMergeTruthReconciler({
      pool: pool.asPgPool(),
      secrets: new InMemorySecretStore(),
      vcsProvider: new StateVcsProvider({ confirmed: true, open: false, merged: false }),
      runStateWriter: writer(pool),
    });

    await expect(reconciler.reconcile(PROJECT)).resolves.toBe(1);

    expect(pool.queueStatus).toBe("queued");
    expect(pool.specStatus).toBe("review");
    expect(pool.events).toEqual([
      {
        eventType: "merge.false_merged.corrected",
        payload: expect.objectContaining({ prNumber: 14, specId: SPEC, reason: "forge_pr_closed_unmerged" }),
      },
    ]);
  });

  it("does not emit a false-merged correction when the guarded queue update does not move a row", async () => {
    const pool = new ReconcilerPool();
    pool.queueUpdateSucceeds = false;
    const reconciler = new PgMergeTruthReconciler({
      pool: pool.asPgPool(),
      secrets: new InMemorySecretStore(),
      vcsProvider: new StateVcsProvider({ confirmed: true, open: true, merged: false }),
      runStateWriter: writer(pool),
    });

    await expect(reconciler.reconcile(PROJECT)).resolves.toBe(0);

    expect(pool.queueStatus).toBe("merged");
    expect(pool.specStatus).toBe("merged");
    expect(pool.events).toEqual([]);
  });

  it("still emits missing merge completion when the forge confirms the PR merged", async () => {
    const pool = new ReconcilerPool();
    const reconciler = new PgMergeTruthReconciler({
      pool: pool.asPgPool(),
      secrets: new InMemorySecretStore(),
      vcsProvider: new StateVcsProvider({ confirmed: true, open: false, merged: true, mergeSha: "abc123" }),
      runStateWriter: writer(pool),
    });

    await expect(reconciler.reconcile(PROJECT)).resolves.toBe(1);

    expect(pool.queueStatus).toBe("merged");
    expect(pool.specStatus).toBe("merged");
    expect(pool.events).toEqual([
      {
        eventType: "merge.completed",
        payload: expect.objectContaining({ prNumber: 14, integration: "native_queue", mergeSha: "abc123" }),
      },
    ]);
  });
});
