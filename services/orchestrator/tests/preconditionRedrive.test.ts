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
// THIS FILE holds the two BEHAVIORAL proofs, driven through a closed-loop simulator:
// the unattended recovery of a precondition-blocked spec, and the signature fix that stops
// unrelated causes aliasing. The classifier arms, the reader source filter and the
// back-compat guarantees live in `runFailureAttribution.test.ts`.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { applyTerminalOutcome, buildRedriveHistoryReader } from "../src/engine/workflow/plannerRunRedrive.js";
import type { DispositionSeams } from "../src/engine/workflow/plannerRunRedrive.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import { classifyRunFailure } from "../src/engine/worker/runFailureClassifier.js";
import { PersistentSshOutageError } from "../src/engine/ssh/transientRetry.js";
import { MissingGithubCredentialRefError } from "../src/engine/credentials/githubTokenResolver.js";
import { MissingCredentialError } from "../src/engine/credentials/resolveCredentials.js";
import { RunnerClaimLiveRowError } from "../src/engine/allocators/runnerStore.js";
import { AnswererStalledError } from "../src/engine/providers/answererSchemaError.js";
// ─────────────────────────────────────────────────────────────────────────────────────
// A CLOSED-LOOP SPEC SIMULATOR.
//
// The disposition applier writes `dag.spec.redriven` rows; the convergence reader reads
// them back. Wiring the applier's OWN output into the REAL `buildRedriveHistoryReader`
// closes the loop, so the tests below exercise the actual feedback path a live spec takes
// across attempts rather than asserting one decision against hand-fed facts.
// ─────────────────────────────────────────────────────────────────────────────────────

interface LoggedEvent {
  eventType: string;
  payload: Record<string, unknown>;
  ts: string;
}

class SpecSimulator implements DispositionSeams {
  readonly events: LoggedEvent[] = [];
  specStatus = "in_flight";
  private seq = 0;

  private append(event: AppendEventInput): void {
    this.seq += 1;
    this.events.push({
      eventType: event.eventType,
      payload: event.payload as Record<string, unknown>,
      ts: new Date(1_700_000_000_000 + this.seq).toISOString(),
    });
  }

  // --- DispositionSeams -------------------------------------------------------------
  async finalizeNonPass(): Promise<void> {}
  async setSpecStatus(status: string): Promise<void> {
    this.specStatus = status;
  }
  async finalizeRunState(): Promise<void> {}
  async updateSpecAtomic(spec: { status: string }, event: AppendEventInput): Promise<void> {
    this.specStatus = spec.status;
    this.append(event);
  }
  async finalizeGenuineHaltAtomic(event: AppendEventInput): Promise<void> {
    this.append(event);
  }
  async finalizePauseForCapacityAtomic(event: AppendEventInput): Promise<void> {
    this.append(event);
  }
  async finalizeRedriveAtomic(input: { runFailedEvent: AppendEventInput }): Promise<void> {
    this.append(input.runFailedEvent);
  }

  // --- the reader's view of the same log ---------------------------------------------
  /** A `pg.Pool` substitute serving the reader's two queries off THIS simulator's log. */
  pool(): pg.Pool {
    const events = this.events;
    return {
      connect: async () => ({
        query: async (sql: string) => {
          if (sql.includes("SET LOCAL") || sql.startsWith("SET") || sql.startsWith("BEGIN") || sql.startsWith("COMMIT"))
            return { rows: [], rowCount: 0 };
          if (sql.includes("github.pr.created")) return { rows: [], rowCount: 0 };
          const rows = events
            .filter((e) => e.eventType === "dag.spec.redriven")
            .map((e) => ({ payload: e.payload, ts: e.ts }));
          return { rows, rowCount: rows.length };
        },
        release: () => {},
      }),
    } as never;
  }

  ctx() {
    return {
      appendEvent: async () => {},
      input: { redriveHistoryReader: buildRedriveHistoryReader(this.pool()) },
      context: { runId: `run_${this.seq}`, specId: "spec_1", projectId: "project_1", orgId: "org_1" },
    } as const;
  }

  /** Drive ONE attempt that throws `error`, returning the bucket the authority chose. */
  async attemptThrowing(error: unknown): Promise<string> {
    return applyTerminalOutcome({ kind: "error", error }, this.ctx(), this);
  }

  redrivenRows(): Record<string, unknown>[] {
    return this.events.filter((e) => e.eventType === "dag.spec.redriven").map((e) => e.payload);
  }

  parked(): LoggedEvent | undefined {
    return this.events.find((e) => e.eventType === "dag.spec.needs_attention");
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// (2) THE HEADLINE RECOVERY PROOF — no operator action anywhere.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("THE RECOVERY PROOF — a precondition-blocked spec never parks and resumes UNATTENDED", () => {
  it("fails 12 consecutive times on an absent GitHub credential, NEVER parks, then COMPLETES once the credential is seeded — with zero operator action", async () => {
    // BEFORE this change this spec parked on attempt ONE (`credential` was in
    // `GENUINE_TERMINAL_CODES`), and only an operator `requeue` could free it. Even without
    // that immediate park it would have parked by attempt three, because every failure
    // classified `internal` and three identical signatures are a proven fixed point.
    //
    // 12 is chosen to be WELL above the 3-attempt cycle threshold AND above the
    // 5-re-drive wandering-halt threshold, so neither escalation path can fire silently.
    const sim = new SpecSimulator();
    const ATTEMPTS = 12;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      const bucket = await sim.attemptThrowing(
        new MissingGithubCredentialRefError("credential/github_token/org/org_1/default"),
      );
      // Every single attempt re-drives. No attempt cap, no time cap, no park.
      expect(bucket, `attempt ${attempt} must re-drive`).toBe("re_drive");
      // The spec is returned to `open` so the walker re-enqueues it — the work stays LIVE.
      expect(sim.specStatus, `attempt ${attempt} must leave the spec open`).toBe("open");
      // NO operator action is performed anywhere in this loop: nothing calls requeue, and
      // nothing touches `needs_attention`.
      expect(sim.parked(), `attempt ${attempt} must not park the spec`).toBeUndefined();
    }

    expect(sim.redrivenRows()).toHaveLength(ATTEMPTS);
    // `run.failed` — NOT `dag.spec.redriven` — is the payload that reaches the PUBLIC
    // timeline, and `MissingGithubCredentialRefError` carries the credential ref inside its
    // own message. `runFailureAttribution.test.ts` pins that the CLASSIFIED object holds no
    // raw text; nothing pinned the EMITTED event until here. This is the path that now
    // re-emits forever on a probe cadence, so a leak would be republished every cycle
    // rather than once.
    const runFailed = sim.events.filter((e) => e.eventType === "run.failed");
    expect(runFailed).toHaveLength(ATTEMPTS);
    for (const event of runFailed) {
      expect(JSON.stringify(event.payload)).not.toContain("credential/github_token/org/org_1/default");
      expect(event.payload).toMatchObject({ cause: "github_credential_missing", attribution: "environment" });
    }
    for (const row of sim.redrivenRows()) {
      expect(row).toMatchObject({
        source: "precondition_block",
        precondition: "github_credential",
        cause: "github_credential_missing",
        attribution: "environment",
        // A WAIT IS NOT A STRIKE. The counter never advances, so a wait can never
        // accumulate toward the fixed point that would park the spec.
        consecutiveSameFailure: 0,
      });
      // The backoff is a fixed probe CADENCE (the window-pause prober's model:
      // "sign-of-life, never a deadline"), not an escalating punishment — but it is
      // non-zero, so the re-drive cannot hot-loop.
      expect(row["backoffSeconds"]).toBeGreaterThan(0);
    }

    // ── THE PRECONDITION IS SATISFIED ────────────────────────────────────────────────
    // An operator seeds the secret OUT OF BAND. Nothing is done to the spec, the run, or
    // the queue: no requeue, no status edit, no manual intervention of any kind. The next
    // attempt is simply the next scheduled re-drive, and the re-drive IS the probe.
    const bucket = await applyTerminalOutcome({ kind: "merge", mergeOutcome: "merged" }, sim.ctx(), sim);

    expect(bucket).toBe("converge");
    expect(sim.parked()).toBeUndefined();
    // Still exactly the 12 waiting re-drives — the successful attempt added none.
    expect(sim.redrivenRows()).toHaveLength(ATTEMPTS);
  });

  it("a SUSTAINED SSH outage is NOT a wait — it already carries a fixed-point proof, and it PARKS", async () => {
    // The counter-case to everything above, and the correction to what this test asserted
    // when it was first written ("8 SSH outages in a row park nothing").
    //
    // `PersistentSshOutageError` is not raised when SSH fails. `ssh/transientRetry.ts`
    // raises it only after ITS OWN convergence detector proves a fixed point — the class
    // doc says "a proven fixed point" and the message says "NOT retrying a fixed point
    // forever". Treating that conclusion as a precondition made the run layer retry it
    // forever anyway, with the rows filtered out of both convergence histories so nothing
    // downstream could re-derive the proof. A system that can prove it is stuck and keeps
    // going is the exact failure this cluster exists to remove; a precondition tag is not
    // a license to reintroduce it one layer up.
    const sim = new SpecSimulator();
    const buckets: string[] = [];
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      buckets.push(
        await sim.attemptThrowing(
          new PersistentSshOutageError({ stuckSignature: "handshake-lost recurred", retriesObserved: 9 }),
        ),
      );
      if (sim.parked() !== undefined) break;
    }
    // It still RE-DRIVES first: one outage is not proof at the run layer either, so an
    // outage that clears on the next attempt recovers unattended exactly as before.
    expect(buckets[0]).toBe("re_drive");
    // But a sustained one reaches the proven fixed point and PARKS — bounded, and
    // attributable, rather than an invisible 30s probe loop with no escalation.
    expect(buckets).toContain("genuine_halt");
    expect(buckets.length).toBeLessThan(8);
    const parked = sim.parked();
    expect(parked).toBeDefined();
    expect(parked?.payload).toMatchObject({ cause: "runner_ssh_outage", attribution: "environment" });
    // And it is NEVER tagged as a wait, so it is real convergence evidence in both readers.
    expect(sim.redrivenRows().every((r) => r["source"] === undefined)).toBe(true);
    expect(sim.redrivenRows().every((r) => r["precondition"] === undefined)).toBe(true);
  });

  it("the precondition wait is invisible to the WANDERING-halt detector too, not only the fixed-point one", async () => {
    // The wandering-halt detector (5 re-drives, no deliverable progress) is the second
    // escalation path and would otherwise catch an indefinitely-waiting spec at attempt 6.
    // Its history is assembled from the SAME filtered row set, so the exemption covers both.
    const sim = new SpecSimulator();
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      await sim.attemptThrowing(new MissingCredentialError("github_token"));
    }
    expect(sim.parked()).toBeUndefined();
    expect(sim.specStatus).toBe("open");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// (3) THE SIGNATURE FIX — different causes are different states; the same cause still converges.
// ─────────────────────────────────────────────────────────────────────────────────────

describe("the convergence signature keys on CAUSE, so unrelated failures stop aliasing", () => {
  it("a distinct CAUSE is carried even when the broad CODE is unchanged", () => {
    // The point of the second axis: the CODE stays put (it is public timeline contract and
    // other code branches on it) while the CAUSE separates states the code aliases.
    const classified = classifyRunFailure(new AnswererStalledError("plan"));
    expect(classified.code).toBe("internal");
    expect(classified.cause).toBe("answerer_stalled");
  });

  it("three DIFFERENT causes that all share the `internal` CODE do NOT reach a fixed point", async () => {
    // All three classify to `code: "internal"`, so under the old code-keyed signature this
    // sequence read as `internal, internal, internal` — a proven cycle — and parked the
    // spec. They are three categorically different problems and must read as progress.
    const sim = new SpecSimulator();
    const differentCauses = [
      new RunnerClaimLiveRowError("runner_1", "run_2"),
      new AnswererStalledError("plan"),
      new Error("some novel unclassified throw"),
    ];
    for (const error of differentCauses) {
      expect(classifyRunFailure(error).code).toBe("internal");
    }

    for (const error of differentCauses) {
      expect(await sim.attemptThrowing(error)).toBe("re_drive");
    }
    expect(sim.parked()).toBeUndefined();
    // Three DISTINCT causes on the wire — the evidence the detector now sees.
    expect(new Set(sim.redrivenRows().map((r) => r["cause"]))).toEqual(
      new Set(["runner_double_claim", "answerer_stalled", "unclassified"]),
    );
  });

  it("three occurrences of the SAME cause STILL reach the fixed point and park (the detector is not weakened)", async () => {
    // The counter-test. Loosening the signature must not make a genuinely stuck spec
    // immortal: an identical cause recurring is still a proven dead-end.
    const sim = new SpecSimulator();
    expect(await sim.attemptThrowing(new RunnerClaimLiveRowError("runner_1", "run_2"))).toBe("re_drive");
    expect(await sim.attemptThrowing(new RunnerClaimLiveRowError("runner_1", "run_2"))).toBe("re_drive");
    expect(await sim.attemptThrowing(new RunnerClaimLiveRowError("runner_1", "run_2"))).toBe("genuine_halt");

    const parked = sim.parked();
    expect(parked?.payload).toMatchObject({
      source: "strand",
      reason: "persistent_failure",
      // (5) THE HALT IS LEGIBLE: the parked-state event names WHAT broke and WHOSE bug it
      // is, so an operator knows which repository to open without reconstructing it.
      cause: "runner_double_claim",
      attribution: "tanren",
    });
    expect(String(parked?.payload["message"])).toContain("this is a bug in TANREN");
  });
});
