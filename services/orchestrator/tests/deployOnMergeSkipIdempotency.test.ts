// Hot-loop PROOF (apex-v35): the template-build `deploy.skipped` must be emitted AT MOST ONCE
// per run, never once-per-pass.
//
// The live repro: `skipTemplateBuildDeploy` UNCONDITIONALLY appended a `deploy.skipped`
// (carrying a runId) every pass. That append fires a `tanren_run` NOTIFY → re-wakes the
// post-merge subscriber → re-drives `check()` → re-appends: a self-feeding hot-loop (1911
// `deploy.skipped` events in seconds). The fix gates the emit on a prior `template_build`
// skip for the same run, so a repeated `check()` is a no-op (still a true skip — no deploy).
//
// Driven over a fake pool whose skip-existence query reflects what the RecordingEventStore has
// appended, so the idempotency across repeated `check()` calls is asserted with no Postgres.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { getJobOrgId } from "@tanren/db";
import { DeployOnMergeWatcher } from "../src/engine/postMerge/deployOnMerge.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { scriptedDeployTransport } from "./conformance/fakes/scriptedDeployTransport.js";
import { scriptedUrlProbe, instantVerifyPollPolicy } from "./conformance/fakes/scriptedUrlProbe.js";

const RUN_ID = "run_skip_idem";
const PROJECT_ID = "project_skip_idem";
const ORG_ID = "org_skip_idem";
const PR_URL = "https://github.com/acme/widget/pull/7";
const MERGE_SHA = "abc1234def5678901234567890abcdef12345678";
// A template-creation build: a COMPLETE deploy target + a linked grant (so PRODUCTS built FROM
// it deploy later), but the build itself must never deploy — it must SKIP, exactly once.
const TEMPLATE_CONFIG = {
  version: 1,
  deployProvider: "deploy.vercel",
  deployAppId: "vercel_app_1",
  templateBuild: true,
};

class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: unknown; ambientOrgId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({ eventType: input.eventType, payload: input.payload, ambientOrgId: getJobOrgId() });
  }
}

// A fake pool whose `deploy.skipped` existence query reflects what `recorded` has appended, so
// a repeated `check()` sees the prior skip — exactly the durable-event idempotency the
// production path relies on.
function fakePool(recorded: RecordingEventStore): pg.Pool {
  // eslint-disable-next-line @typescript-eslint/require-await
  const query = async (sql: string, _params?: readonly unknown[]) => {
    const text = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SET )/u.test(text)) return { rows: [], rowCount: 0 };
    if (/event_type = 'merge\.completed'/u.test(sql)) {
      return { rows: [{ payload: { prNumber: 7, mergeSha: MERGE_SHA } }], rowCount: 1 };
    }
    if (/event_type = 'deploy\.skipped' AND payload->>'reason' = 'template_build'/u.test(sql)) {
      // The IDEMPOTENCY gate (alreadyTemplateBuildSkipped): reflect appended events.
      const prior = recorded.appends.some(
        (a) => a.eventType === "deploy.skipped" && (a.payload as { reason?: string }).reason === "template_build",
      );
      return prior ? { rows: [{ id: "s1" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/FROM runs r WHERE/u.test(sql)) {
      return { rows: [{ project_id: PROJECT_ID, pr_url: PR_URL }], rowCount: 1 };
    }
    if (/SELECT config, org_id FROM projects/u.test(sql)) {
      return { rows: [{ config: TEMPLATE_CONFIG, org_id: ORG_ID }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release: () => {} };
  return { query, connect: async () => client } as unknown as pg.Pool;
}

function secrets(): InMemorySecretStore {
  return new InMemorySecretStore();
}

describe("template-build deploy.skipped is idempotent per run (apex-v35 hot-loop fix)", () => {
  it("repeated check() of the same template-build run emits deploy.skipped AT MOST ONCE (no self-loop)", async () => {
    const transport = scriptedDeployTransport("vercel", []);
    const events = new RecordingEventStore();
    const watcher = new DeployOnMergeWatcher({
      pool: fakePool(events),
      secrets: secrets(),
      transport,
      eventStore: events,
      urlProbe: scriptedUrlProbe(),
      verifyPoll: instantVerifyPollPolicy(),
    });

    // Drive the storm: many `check()` passes over the SAME run (the live 1911-in-seconds loop).
    for (let i = 0; i < 10; i++) {
      await watcher.check(RUN_ID);
    }

    // The self-feeding skip fired exactly ONCE.
    const skips = events.appends.filter((a) => a.eventType === "deploy.skipped");
    expect(skips).toHaveLength(1);
    const payload = skips[0]!.payload as { reason?: string };
    expect(payload.reason).toBe("template_build");
    expect(skips[0]!.ambientOrgId).toBe(ORG_ID);
    // Still a true skip across every pass — never a stray deploy, never a deploy.failed.
    expect(transport.deploysTriggered()).toEqual([]);
    expect(events.appends.find((a) => a.eventType === "deploy.triggered")).toBeUndefined();
    expect(events.appends.find((a) => a.eventType === "deploy.failed")).toBeUndefined();
  });
});
