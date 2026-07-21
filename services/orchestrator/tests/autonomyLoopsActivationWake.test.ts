import { NOTIFICATION_CHANNEL } from "@tanren/db";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { MergeCoordinator } from "../src/engine/contracts/mergeCoordinator.js";
import { MergeCoordinatorSubscriber } from "../src/engine/merge/subscriber.js";
import { buildMergeCoordinatorSubscriberDeps, type AutonomyLoopsDeps } from "../src/engine/worker/autonomyLoops.js";

class FakeNotifyListener {
  private handlers = new Map<string, Set<(payload: string) => void>>();
  async subscribe(channel: string, handler: (payload: string) => void): Promise<() => void> {
    const handlers = this.handlers.get(channel) ?? new Set<(payload: string) => void>();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
  onConnectionError(): () => void {
    return () => {};
  }
  fire(channel: string, payload: string): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(payload);
  }
}

function activationWakePool(): { pool: pg.Pool; queries: string[] } {
  const queries: string[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/u.test(sql.trim())) return { rows: [], rowCount: 0 };
      if (/SELECT project_id, org_id, event_type, payload FROM events WHERE id/u.test(sql)) {
        return {
          rows: [{ project_id: null, org_id: "org_factory", event_type: "credential.configured", payload: {} }],
          rowCount: 1,
        };
      }
      if (/FROM merge_queue/u.test(sql)) {
        return params.length === 0
          ? { rows: [], rowCount: 0 }
          : { rows: [{ project_id: "proj_factory" }], rowCount: 1 };
      }
      if (/SELECT lifecycle, org_id FROM projects WHERE project_id/u.test(sql)) {
        return { rows: [{ lifecycle: "active", org_id: "org_factory" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { pool: { query: client.query, connect: async () => client } as unknown as pg.Pool, queries };
}

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

describe("autonomyLoops activation-wake production factory", () => {
  it("supplies the mandatory callback and the constructed subscriber invokes it for an org-scoped credential wake", async () => {
    const { pool, queries } = activationWakePool();
    const listener = new FakeNotifyListener();
    const production = buildMergeCoordinatorSubscriberDeps(
      {
        pool,
        secrets: {} as never,
        allocator: {} as never,
        ssh: {} as never,
        githubHttp: {} as never,
        identitySecretRef: "secret://runner/identity",
        runStateWriter: {} as never,
      } as AutonomyLoopsDeps,
      listener as never,
    );
    const coordinator: MergeCoordinator = {
      async coordinate(projectId) {
        return { projectId, holdReason: "empty", queueDepth: 0 };
      },
    };
    const subscriber = new MergeCoordinatorSubscriber({ ...production, coordinator });

    expect(await production.attemptActivation("proj_factory")).toMatchObject({ kind: "not_deriving" });
    await subscriber.start();
    await flush();
    listener.fire(NOTIFICATION_CHANNEL, "credential-event");
    await flush();

    expect(
      queries.filter((query) => /SELECT lifecycle, org_id FROM projects WHERE project_id/u.test(query)),
    ).toHaveLength(2);
    await subscriber.stop();
  });
});
