// plannerRunGateJunit — best-effort native JUnit ingest for the run loop's gate.
// Kept separate from plannerRunGate so the gate callback stays under the architecture cap.

import { type CiWhen, junitReportFor } from "../ci/index.js";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { EventStore } from "../eventStore.js";
import { type GateOutcome, ingestGateJunit } from "./gate/index.js";
import type { CiConfigV1 } from "../ci/index.js";
import type { JunitReport } from "../ci/junit.js";
import { createLogger } from "../observability/logger.js";
import type { RunPlannerLoopInput } from "./plannerRun.js";

const log = createLogger("gate");

/**
 * Ingest the gate's JUnit report in-process, best-effort. Skipped when there is no
 * head-sha anchor (fake-SSH unit path) or no org (a system / null-org job — the
 * `ci_test_results` row is org-stamped). The run already runs under the org's ambient
 * scope, so `input.pool` self-scopes the INSERT. A read/parse error is logged + swallowed
 * (the per-test grain is an enrichment, never a gate-blocker), so it can NEVER fail the run.
 *
 * NO-SILENT-FALLBACK: the ingest result is DISCRIMINATED. "JUnit expected" is decided
 * from the EXPLICIT CI-config contract — a tier mapped to this lifecycle point DECLARED a
 * `junitReport` path (`junitReportFor`), NOT a command-string sniff (a writer's
 * `just tier-2` never mentions the path). No declaration ⇒ a clean QUIET skip. When a
 * tier DID declare a report but the runner produced none (absent/unreadable/empty), the
 * `missing_expected` result is surfaced LOUDLY AND DURABLY: a persisted `ci.junit_missing`
 * event (the durable signal) PLUS a structured `log.error` breadcrumb. The per-test grain is gone though a test
 * tier ran, so flaky-intelligence is blind — a reporter misconfig / a runner crash after
 * the step. Non-merge-gating (the verdict already stands) — VISIBILITY, not a blocker.
 */
export async function ingestGateJunitBestEffort(
  input: RunPlannerLoopInput,
  target: RunnerHandle,
  workspacePath: string,
  headSha: string,
  outcome: GateOutcome,
  config: CiConfigV1,
  when: CiWhen,
  // The control-plane-routed event store: the `ci.tests.reported` append the ingest emits
  // lands in `events` (a control-plane table the data plane can't write directly), so it
  // routes through here (the run-state writer when remote-writes is on), NOT `input.pool`.
  eventStore: EventStore,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
  taskId: string | undefined,
): Promise<void> {
  const orgId = input.context.orgId;
  if (headSha === "" || orgId === undefined || orgId === null) {
    return;
  }
  // Decide "JUnit expected" from the DECLARED contract field, not a command sniff: the
  // first tier mapped to `when` that DECLARES a `junitReport` path names the tier + the
  // path to read back. The scaffold `fast` tier (lint+typecheck) declares none ⇒
  // expectReport=false ⇒ a clean QUIET skip.
  const declared = junitReportFor(config, when);
  const expectReport = declared !== undefined;
  // EVIDENCE-REUSE (apex v57 task #64): if the gate's evidence harvester already
  // read + parsed the JUnit report for this lifecycle's declared tier, pass it
  // through so the per-test ingest reuses it (no double-read over SSH). The harvester
  // keys parsed reports by step name; the FIRST step that wrote one in the declared
  // tier wins (matching `junitReportFor`'s tier-then-step ordering).
  const preParsedReport = declared === undefined ? undefined : findParsedJunitReport(outcome, declared.tier);
  try {
    const result = await ingestGateJunit({
      ssh: input.ssh,
      target,
      workspacePath,
      client: input.pool,
      eventStore,
      runId: input.context.runId,
      projectId: input.context.projectId,
      orgId,
      headSha,
      gatePassed: outcome.passed,
      expectReport,
      ...(declared === undefined ? {} : { tier: declared.tier, reportPath: declared.path }),
      ...(preParsedReport === undefined ? {} : { preParsedReport }),
    });
    if (result.kind === "missing_expected") {
      // LOUD + DURABLE: a tier DECLARED a junit report but the runner produced none — the
      // per-test grain (flaky detection) just went blind. Persist `ci.junit_missing`
      // (reason + tier + path + headSha) so the blindness is on the durable LEDGER (the
      // event is the durable signal), and ALSO a structured `log.error` so it surfaces as
      // an operator BREADCRUMB in the run output. The event is advisory — non-blocking,
      // the gate verdict already stands.
      await appendEvent(
        "ci.junit_missing",
        {
          headSha,
          tier: declared?.tier ?? "unknown",
          reportPath: declared?.path ?? "unknown",
          reason: result.reason,
        },
        taskId,
      );
      log.error(
        "native JUnit report EXPECTED but missing — flaky-intelligence has NO per-test grain for this gate " +
          "(a reporter misconfig or a runner crash after the test step). Non-blocking.",
        {
          runId: input.context.runId,
          reason: result.reason,
          tier: declared?.tier ?? "unknown",
          reportPath: declared?.path ?? "unknown",
          headSha,
        },
      );
    }
  } catch (error) {
    log.error("native JUnit ingest failed (non-blocking)", { runId: input.context.runId }, error);
  }
}

/**
 * Find the parsed JUnit report the evidence harvester already produced for the
 * declared lifecycle tier, if any. Walks the outcome's tier results, looks up
 * the `parsedJunitReports` side channel on the matching tier, and returns the FIRST
 * parsed report — matching `junitReportFor`'s tier-then-step ordering. Returns
 * undefined when the harvester did not parse a report (the legacy / pre-evidence
 * path), the tier was not run, or the report was junit_missing (the read failed).
 */
function findParsedJunitReport(outcome: GateOutcome, tierName: string): JunitReport | undefined {
  for (const tierResult of outcome.results) {
    if (tierResult.tier !== tierName) continue;
    const parsed = tierResult.parsedJunitReports;
    if (parsed === undefined) continue;
    for (const step of tierResult.steps) {
      const report = parsed.get(step.name);
      if (report !== undefined) return report;
    }
  }
  return undefined;
}
