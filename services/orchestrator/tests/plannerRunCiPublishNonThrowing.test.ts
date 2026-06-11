// §3.8 LOCK (docs/audits/2026-06-09-apex-pre-run.md): the merge-verdict forge publish is
// BEST-EFFORT — it only mirrors an ALREADY-DECIDED verdict onto the PR. Its PREP (head-sha
// resolve + token mint) can throw on a transient Vault/mint failure; that throw must NEVER
// propagate out of `runMergeGateForRun` and FAIL a run whose gate PASSED. This pins the
// gate-passed path: a throwing token mint surfaces a non-fatal `gate.publish_failed` event
// and `runMergeGateForRun` RESOLVES (returns the passing outcome), never throws.

import { describe, expect, it } from "vitest";
import { runMergeGateForRun } from "../src/engine/workflow/plannerRunCi.js";
import type { GateOutcome } from "../src/engine/workflow/gate/index.js";
import type { MergeGateRunContext } from "../src/engine/workflow/plannerRunCi.js";
import type { RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";

const PASSING: GateOutcome = { passed: true, results: [] };

function recordingEvents() {
  const events: string[] = [];
  return { events, append: async (input: { eventType: string }) => void events.push(input.eventType) };
}

describe("§3.8 verdict-publish prep is internally non-throwing", () => {
  it("a throwing token mint on a PASSED gate → non-fatal gate.publish_failed, runMergeGateForRun RESOLVES", async () => {
    const events = recordingEvents();
    // A static credential ref is configured (so the publish is attempted), but the token
    // mint THROWS — modeling a transient Vault/mint failure during the verdict publish PREP.
    const input = {
      ssh: {},
      secrets: {},
      timeoutMs: 1000,
      githubHttp: {
        resolveToken: async () => {
          throw new Error("vault transient failure minting publish token");
        },
        parseRepository: (url: string) => ({ owner: "o", name: url }),
      },
      context: {
        runId: "run_1",
        specId: "spec_1",
        projectId: "proj_1",
        repoUrl: "https://github.com/o/r",
        githubCredentialRef: "credential/github_token/proj_1",
      },
    } as unknown as RunPlannerLoopInput;
    const ctx = {
      // The gate itself PASSED — the publish prep is downstream of the (passing) verdict.
      runGate: async () => PASSING,
      target: { backend: "ssh" },
      workspacePath: "/w",
      eventStore: events,
    } as unknown as MergeGateRunContext;

    // The PUSHED PR head sha is known (so the publish does not even need to resolve it), yet
    // the token mint still throws — the prep must swallow it. The gate PASSED, so the run
    // must PROCEED (resolve), never throw on a best-effort publish failure.
    const outcome = await runMergeGateForRun(input, ctx, "a".repeat(40));

    expect(outcome.passed).toBe(true);
    // The transient failure was recorded as a NON-FATAL warning event, not a thrown error.
    expect(events.events).toContain("gate.publish_failed");
  });
});
