// The merge-stage behavior when the project has not opted into any MergeIntegration
// (`mergeIntegration: "not_configured"` — the safe default until an operator wires an
// integration). BEFORE this fix, `dispatchedIntegrationFor` coerced `not_configured` →
// `external_reviewer` and the stage emitted `merge.queued` with `integration:
// external_reviewer` — indistinguishable from a real external_reviewer opt-in, so the
// operator UI showed "waiting on external reviewer" for a project that never opted in.
// The mergeForRun path now short-circuits `not_configured` BEFORE the coercion and emits
// a DISTINCT `merge.blocked` event (mode `not_configured`, no `posture` — this is a
// CONFIG-gap block, not a posture block). Task is left running so the recovery surface
// (an operator wiring an integration) picks it up — same pattern as `blockByPosture`.

import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { mergeForRun } from "../src/engine/workflow/reviewMerge/index.js";
import { noopConflictResolver } from "./fixtures/noopConflictResolver.js";
import {
  authorityBundle,
  authorityLand,
  fakeMergeWriter,
  recordingMergeProbe,
  ReviewMergePool,
  unusedHttp,
} from "./reviewMerge.fixtures.js";

describe("mergeForRun — not_configured emits DISTINCT merge.blocked (mode: not_configured)", () => {
  it("no land, task left running, no merge.queued (distinct from external_reviewer)", async () => {
    const pool = new ReviewMergePool("not_configured");
    const events = new FakeEventStore();
    const { host, landed } = authorityLand();
    const result = await mergeForRun({
      pool: pool.asPgPool(),
      eventStore: events,
      runStateWriter: fakeMergeWriter(pool, events),
      secrets: new FakeSecretStore(),
      resolveConflict: noopConflictResolver,
      githubHttp: unusedHttp(),
      runId: "run_1",
      mergeProbe: recordingMergeProbe(),
      mergeAuthority: authorityBundle(host, landed),
    });

    expect(result.outcome).toBe("blocked");
    expect(landed).toEqual([]);
    const blocked = events.events.find((e) => e.eventType === "merge.blocked");
    expect(blocked?.payload).toMatchObject({ mode: "not_configured", externalLogins: [] });
    // No posture stamped (this is a CONFIG-gap block, not a posture block).
    const payload = (blocked?.payload ?? {}) as Record<string, unknown>;
    expect(payload["posture"]).toBeUndefined();
    // The distinguishing signal from the external_reviewer hand-off: no `merge.queued`.
    expect(events.events.find((e) => e.eventType === "merge.queued")).toBeUndefined();
    // Task left running for the recovery surface (operator wires an integration → re-drive).
    expect(pool.tasks.find((t) => t.kind === "merge")?.status).toBe("running");
  });
});
