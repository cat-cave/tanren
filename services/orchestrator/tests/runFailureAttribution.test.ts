// THE NEVER-PARK PROOF — failure-cause attribution + precondition-blocked re-drive.
//
// THE DEFECT THESE PIN (measured on a live instance driving a real monorepo for a day):
// 225 `run.failed`, 146 `dag.spec.redriven`, 80 `dag.spec.needs_attention`, ZERO
// `run.completed`, and 65 specs parked at the terminal `needs_attention` status that only
// an operator `requeue` could free. Three layers produced it:
//
//   1. The failure SIGNATURE was lossy. `classifyRunFailure` keys an allowlist off
//      `error.name`, and the dominant real error classes were absent from it — so 209 of
//      225 failures (93%) classified as the catch-all `internal`.
//   2. The convergence detector was therefore fed IDENTICAL signatures for categorically
//      different causes. Run failures carry no `workSignature`, so the failure code IS the
//      whole signature: an SSH outage, then a missing credential, then a control-plane 500
//      read as ONE repeating state and parked the spec as "genuinely stuck".
//   3. A missing credential parked on its FIRST occurrence (`GENUINE_TERMINAL_CODES`), with
//      zero retries.
//
// Every blocking cause observed was ENVIRONMENTAL and every one CLEARED later (the SSH key
// was re-provisioned, the credential seeded, the config corrected). Tanren resumed for none
// of them. The doctrine: "Halts are not tolerable. If tanren is working correctly, a user
// has budget, and the roadmap is not complete, halting means a fundamental failure in
// tanren." A halt is a BUG REPORT, not a terminal state.
//
// THIS FILE holds the CLASSIFIER arms (the allowlist entries whose absence produced the
// 93%-`internal` reading), the convergence-history SOURCE FILTER in both readers, and the
// back-compat guarantees for history written before this change. The behavioral recovery
// proof lives in `preconditionRedrive.test.ts`.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { buildRedriveHistoryReader } from "../src/engine/workflow/plannerRunRedrive.js";
import { classifyRunFailure } from "../src/engine/worker/runFailureClassifier.js";
import type { ClassifiedRunFailure } from "../src/engine/worker/runFailureClassifier.js";
import { readOrphanConsecutive } from "../src/engine/worker/runFinalize.js";
import { DagSpecRedrivenPayload } from "../src/engine/events/schemas/dagRedrive.js";
import { PersistentSshOutageError } from "../src/engine/ssh/transientRetry.js";
import { MissingGithubCredentialRefError } from "../src/engine/credentials/githubTokenResolver.js";
import { MissingGithubAppCredentialRefError } from "../src/engine/credentials/githubApp.js";
import { UnscopedOrgError } from "../src/engine/credentials/resolveCredentials.js";
import { RunStateWriteTransportError } from "../src/engine/worker/httpRunStateWriter.js";
import { RunnerClaimLiveRowError } from "../src/engine/allocators/runnerStore.js";
import { WorkspaceDepsInstallError } from "../src/engine/workspace/index.js";
// ─────────────────────────────────────────────────────────────────────────────────────
// (1) THE CLASSIFIER — the missing allowlist entries, and their cause/attribution.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("classifyRunFailure — the error classes that produced the live 93%-`internal` reading", () => {
  it("PersistentSshOutageError (~122 of 225 live failures) is NOT `internal` — it is a runner_ssh precondition", () => {
    // The single largest live failure class. Every occurrence landed on the opaque
    // `internal` default, so an SSH outage was indistinguishable from any other unknown
    // throw and three of them in a row read as one repeating state.
    const classified = classifyRunFailure(new PersistentSshOutageError("econnreset recurred", 9));
    expect(classified.code).not.toBe("internal");
    expect(classified).toMatchObject({
      cause: "runner_ssh_outage",
      attribution: "environment",
      precondition: "runner_ssh",
    });
  });

  it("MissingGithubCredentialRefError (49 live failures) is NOT `internal` — it is a github_credential precondition", () => {
    const classified = classifyRunFailure(new MissingGithubCredentialRefError("credential/github_token/org/o1/x"));
    expect(classified.code).not.toBe("internal");
    expect(classified).toMatchObject({
      cause: "github_credential_missing",
      attribution: "environment",
      precondition: "github_credential",
    });
  });

  it("MissingGithubAppCredentialRefError (20 live failures, previously a BARE Error) classifies at all", () => {
    // This throw used to be `new Error("missing GitHub App credential ref: …")`, so its
    // `error.name` was the generic "Error" and the classifier — which keys off the class
    // name and nothing else — structurally could not see it. A named class is the minimum
    // a failure needs in order to be attributable.
    const error = new MissingGithubAppCredentialRefError("credential/github_app/org/o1/default");
    expect(error.name).toBe("MissingGithubAppCredentialRefError");
    // The message is byte-identical to the previous bare throw (callers matching on text
    // keep matching), and `instanceof Error` still holds.
    expect(error.message).toBe("missing GitHub App credential ref: credential/github_app/org/o1/default");
    expect(error).toBeInstanceOf(Error);
    const classified = classifyRunFailure(error);
    expect(classified.code).not.toBe("internal");
    expect(classified).toMatchObject({
      cause: "github_app_credential_missing",
      attribution: "environment",
      precondition: "github_app_credential",
    });
  });

  it("RunStateWriteTransportError is attributed to TANREN yet still carries a precondition", () => {
    // Attribution and precondition are INDEPENDENT axes. Attribution answers "who fixes the
    // bug" (tanren's own control plane is misbehaving); precondition answers "may this
    // park" (no — the endpoint accepting writes again is an external condition that clears).
    const error = new RunStateWriteTransportError("/internal/append-event", 500, "internal server error");
    expect(classifyRunFailure(error)).toMatchObject({
      cause: "control_plane_write_failed",
      attribution: "tanren",
      precondition: "control_plane",
    });
  });

  it("RunnerClaimLiveRowError is TANREN's bug with NO precondition (nothing external clears it)", () => {
    const classified = classifyRunFailure(new RunnerClaimLiveRowError("runner_1", "run_2"));
    expect(classified).toMatchObject({ cause: "runner_double_claim", attribution: "tanren" });
    expect(classified.precondition).toBeUndefined();
  });

  it("UnscopedOrgError stays a GENUINE terminal: tanren's bug, no precondition", () => {
    // This is why `GENUINE_TERMINAL_CODES` is not dead code after the precondition check
    // moved ahead of it — see the sibling assertion in runFinalizeAuthority.test.ts.
    const classified = classifyRunFailure(new UnscopedOrgError());
    expect(classified).toMatchObject({ cause: "credential_org_scope_lost", attribution: "tanren" });
    expect(classified.precondition).toBeUndefined();
  });

  it("attributes the workspace classes to the owner the class name can actually prove", () => {
    // The target repo's dependency graph failed to install in a clean container — a
    // repo-side reproducibility defect the repo can fix.
    expect(classifyRunFailure(new WorkspaceDepsInstallError("pnpm install exited 1"))).toMatchObject({
      cause: "workspace_deps_install_failed",
      attribution: "target_repo",
    });
  });

  it("an unrecognized throw still falls CLOSED — `unclassified` / `unknown`, never message-derived", () => {
    const leaky = new Error("clone https://x-access-token:ghp_SECRET@github.com/acme/p.git failed");
    const classified = classifyRunFailure(leaky);
    expect(classified).toMatchObject({ code: "internal", cause: "unclassified", attribution: "unknown" });
    expect(JSON.stringify(classified)).not.toContain("ghp_SECRET");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// (4) THE SOURCE FILTER — precondition blocks are excluded from BOTH readers.
// ─────────────────────────────────────────────────────────────────────────────────────

/** A `pg.Pool` substitute serving a fixed `dag.spec.redriven` row list to the planner reader. */
function fixedPool(rows: Record<string, unknown>[]): pg.Pool {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.includes("SET LOCAL") || sql.startsWith("SET") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT"))
          return { rows: [], rowCount: 0 };
        if (sql.includes("github.pr.created")) return { rows: [], rowCount: 0 };
        return {
          rows: rows.map((payload, i) => ({ payload, ts: new Date(1_700_000_000_000 + i).toISOString() })),
          rowCount: rows.length,
        };
      },
      release: () => {},
    }),
  } as never;
}

/** A `pg.PoolClient` substitute serving a fixed row list to the orphan reader. */
function fixedClient(rows: Record<string, unknown>[]): pg.PoolClient {
  return {
    query: async () => ({ rows: rows.map((payload) => ({ payload })), rowCount: rows.length }),
    release: () => {},
  } as unknown as pg.PoolClient;
}

const doubleClaimAtBootstrap: ClassifiedRunFailure = {
  code: "internal",
  stage: "bootstrap",
  summary: "the run's runner already carried a live claim",
  cause: "runner_double_claim",
  attribution: "tanren",
};

describe("precondition_block rows are excluded from the convergence history in BOTH readers", () => {
  it("planner reader: interleaved precondition blocks do not break an otherwise-proven cycle", async () => {
    // Two structural `runner_double_claim` priors + the current one is a cycle. If the
    // interleaved waits counted, the history would read as "a new state appeared between
    // structural re-drives" and the genuinely stuck spec would re-drive forever.
    const reader = buildRedriveHistoryReader(
      fixedPool([
        { failureCode: "internal", cause: "runner_double_claim", stage: "bootstrap" },
        { failureCode: "credential", cause: "github_credential_missing", source: "precondition_block" },
        { failureCode: "internal", cause: "runner_double_claim", stage: "bootstrap" },
        { failureCode: "workspace", cause: "runner_ssh_outage", source: "precondition_block" },
      ]),
    );
    const result = await reader({
      orgId: "org_1",
      specId: "spec_1",
      code: "internal",
      stage: "bootstrap",
      cause: "runner_double_claim",
    });
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" ? result.priorSameFixedPoint : -1).toBe(1);
  });

  it("planner reader: a history of ONLY precondition blocks reads as NO structural priors (progress)", async () => {
    const reader = buildRedriveHistoryReader(
      fixedPool([
        { failureCode: "credential", cause: "github_credential_missing", source: "precondition_block" },
        { failureCode: "credential", cause: "github_credential_missing", source: "precondition_block" },
        { failureCode: "credential", cause: "github_credential_missing", source: "precondition_block" },
      ]),
    );
    const result = await reader({
      orgId: "org_1",
      specId: "spec_1",
      code: "credential",
      stage: "credentials",
      cause: "github_credential_missing",
    });
    expect(result.kind === "ok" ? result.priorSameFixedPoint : -1).toBe(0);
  });

  it("orphan reader: a long precondition WAIT between two identical crashes must not hide the cycle", async () => {
    // DELIBERATELY DISCRIMINATING FIXTURE. A naive interleave (A, P, A, P + A) is NOT a
    // valid test of the filter: the latest `A` still recurs an earlier `A` inside the
    // detector's 8-attempt cycle window, so the verdict is `escalate` with or without the
    // filter — the assertion would pass against a broken filter. This fixture pads the wait
    // out to the FULL window, which is also the realistic shape (a spec that crashed twice,
    // then waited many probe cycles for a credential). Unfiltered, the eight waits push both
    // genuine crashes out of the window and the spec would re-drive forever; filtered, the
    // three identical crashes are the proven dead-end they are.
    const wait = {
      failureCode: "credential",
      cause: "github_credential_missing",
      stage: "credentials",
      source: "precondition_block",
    };
    const got = await readOrphanConsecutive(
      fixedClient([
        { failureCode: "internal", cause: "runner_double_claim", stage: "bootstrap" },
        { failureCode: "internal", cause: "runner_double_claim", stage: "bootstrap" },
        ...Array.from({ length: 8 }, () => ({ ...wait })),
      ]),
      "spec_1",
      doubleClaimAtBootstrap,
    );
    expect(got.kind === "ok" ? got.consecutive : -1).toBe(1);
  });

  it("orphan reader: a history of ONLY precondition blocks reads as NO structural priors (progress)", async () => {
    // Also deliberately discriminating: the CURRENT failure shares the waits' cause, so
    // WITHOUT the filter the three waits plus this attempt are a textbook cycle and the
    // spec parks — waiting would have manufactured its own fixed point, which is exactly
    // the live defect. WITH the filter there are no structural priors at all.
    const credentialMissing: ClassifiedRunFailure = {
      code: "credential",
      stage: "credentials",
      summary: "a required credential is missing",
      cause: "credential_missing",
      attribution: "environment",
      precondition: "credential",
    };
    const got = await readOrphanConsecutive(
      fixedClient([
        { failureCode: "credential", cause: "credential_missing", stage: "credentials", source: "precondition_block" },
        { failureCode: "credential", cause: "credential_missing", stage: "credentials", source: "precondition_block" },
        { failureCode: "credential", cause: "credential_missing", stage: "credentials", source: "precondition_block" },
      ]),
      "spec_1",
      credentialMissing,
    );
    expect(got.kind === "ok" ? got.consecutive : -1).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// (5) BACK-COMPAT — history written before this change still parses and still works.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("back-compat: legacy dag.spec.redriven rows (no cause/attribution) keep working", () => {
  it("a legacy payload PARSES against the .strict() schema with the new fields absent", () => {
    const legacy = {
      specId: "spec_1",
      runId: "run_1",
      failureCode: "internal",
      stage: "run",
      consecutiveSameFailure: 1,
      backoffSeconds: 30,
    };
    expect(() => DagSpecRedrivenPayload.parse(legacy)).not.toThrow();
    const parsed = DagSpecRedrivenPayload.parse(legacy);
    expect(parsed.cause).toBeUndefined();
    expect(parsed.attribution).toBeUndefined();
    expect(parsed.precondition).toBeUndefined();
  });

  it("planner reader: a legacy history with NO cause still keys the signature off failureCode", async () => {
    // Two legacy `internal` rows + a current attempt whose signature is also `internal`
    // (supplied without a cause, as a pre-change caller would) ⇒ the cycle is still found.
    const reader = buildRedriveHistoryReader(
      fixedPool([
        { failureCode: "internal", stage: "run" },
        { failureCode: "internal", stage: "run" },
      ]),
    );
    const result = await reader({ orgId: "org_1", specId: "spec_1", code: "internal", stage: "run" });
    expect(result.kind === "ok" ? result.priorSameFixedPoint : -1).toBe(1);
    // And a DIFFERENT legacy code is still progress, exactly as before.
    const mixed = buildRedriveHistoryReader(
      fixedPool([
        { failureCode: "internal", stage: "run" },
        { failureCode: "merge", stage: "merge" },
      ]),
    );
    const progressed = await mixed({ orgId: "org_1", specId: "spec_1", code: "internal", stage: "run" });
    expect(progressed.kind === "ok" ? progressed.priorSameFixedPoint : -1).toBe(0);
  });

  it("orphan reader: a legacy history with NO cause still keys the signature off failureCode@stage", async () => {
    const legacyInternalAtRun: ClassifiedRunFailure = {
      code: "internal",
      stage: "run",
      summary: "the run failed with an internal error",
      cause: "unclassified",
      attribution: "unknown",
    };
    // The legacy rows key off `internal@run`; this attempt keys off `unclassified@run`, so
    // the transition reads as PROGRESS exactly once — a deliberate, one-time reset of stale
    // evidence when the classifier's vocabulary changed, never a permanent escape hatch.
    const transition = await readOrphanConsecutive(
      fixedClient([
        { failureCode: "internal", stage: "run" },
        { failureCode: "internal", stage: "run" },
      ]),
      "spec_1",
      legacyInternalAtRun,
    );
    expect(transition.kind === "ok" ? transition.consecutive : -1).toBe(0);
    // Once the history is written in the new shape, the cycle is found again.
    const settled = await readOrphanConsecutive(
      fixedClient([
        { failureCode: "internal", cause: "unclassified", stage: "run" },
        { failureCode: "internal", cause: "unclassified", stage: "run" },
      ]),
      "spec_1",
      legacyInternalAtRun,
    );
    expect(settled.kind === "ok" ? settled.consecutive : -1).toBe(1);
  });
});
