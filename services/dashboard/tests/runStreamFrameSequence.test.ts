// PR #943 final dependency-plane audit: pin the run-detail SSE client's
// frame-sequence contract — a terminal `status` frame does NOT abort delivery,
// so a final same-id cost reconciliation (null→known) arriving after terminal
// status still applies, and the stream closes only on EOF once terminal has
// been seen. Drives the pure `RunStreamReducer` seam (the exact state
// `initRunStream` wires to its EventSource listeners) — no DOM/EventSource.

import { describe, expect, it } from "vitest";
import { RunStreamReducer } from "../src/client/runStream.js";

interface Frame {
  id?: string | number;
  billingMode: "per_token" | "subscription" | "self_hosted" | "unattributed";
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  costUsd: string | null;
}

function frame(over: { id?: string; costUsd?: string | null } = {}): Frame {
  return {
    id: "1",
    billingMode: "per_token",
    model: "m",
    inputTokens: 1,
    outputTokens: 0,
    cachedInputTokens: 0,
    totalTokens: 1,
    costUsd: null,
    ...over,
  };
}

describe("runStream frame-sequence protocol (terminal status does not close before final reconciliation + EOF)", () => {
  it("terminal status frame does not abort a later same-id cost reconciliation; only EOF closes", () => {
    const reducer = new RunStreamReducer();
    // Mirrors the production error-listener gate in initRunStream: the stream
    // closes on EOF only once a terminal status has been seen.
    const eofCloses = (): boolean => reducer.isTerminal;

    // 1. snapshot: one unknown-cost row (null).
    reducer.ingestSnapshotCosts([frame({ id: "9007199254740993", costUsd: null })]);
    expect(reducer.totals.perTokenUnknown).toBe(1);
    expect(reducer.totals.perTokenPriced).toBe(0);
    expect(reducer.isTerminal).toBe(false);
    expect(eofCloses()).toBe(false);

    // 2. terminal status frame arrives — marked terminal, but delivery is NOT
    //    aborted (no frame is dropped once terminal is seen).
    reducer.ingestStatus("completed");
    expect(reducer.isTerminal).toBe(true);
    // An EOF would now close, yet the null row is still unreconciled — proving
    // the close gate alone does not drop the pending final reconciliation.
    expect(eofCloses()).toBe(true);
    expect(reducer.totals.perTokenUnknown).toBe(1);

    // 3. final same-id reconciliation (null -> $1.00) arrives AFTER terminal.
    //    It MUST still apply: terminal status does not close before final
    //    same-id cost reconciliation.
    reducer.ingestCosts([frame({ id: "9007199254740993", costUsd: "1.00" })]);
    expect(reducer.totals.perTokenPriced).toBe(1);
    expect(reducer.totals.perTokenUnknown).toBe(0);
    expect(reducer.totals.perTokenKnownUsd).toBeCloseTo(1, 5);
    // Upsert by exact identity, not append-sum: tokens counted once.
    expect(reducer.totals.totalTokens).toBe(1);
  });

  it("a non-terminal status never gates an EOF close (a live run keeps reconnecting)", () => {
    const reducer = new RunStreamReducer();
    reducer.ingestSnapshotCosts([frame({ id: "1", costUsd: "0.50" })]);
    reducer.ingestStatus("running");
    // A transient error on a still-live run must NOT close — reconnect stays
    // possible so delivery of subsequent frames (incl. final reconciliation) is
    // not abandoned prematurely.
    expect(reducer.isTerminal).toBe(false);
  });

  it("snapshot resets the upsert map (a reconnect never double-counts prior rows)", () => {
    const reducer = new RunStreamReducer();
    reducer.ingestCosts([frame({ id: "1", costUsd: "1.00" })]);
    expect(reducer.totals.perTokenPriced).toBe(1);
    // A fresh snapshot clears the map before re-applying — the same row id is
    // not summed twice across a reconnect.
    reducer.ingestSnapshotCosts([frame({ id: "1", costUsd: "1.00" })]);
    expect(reducer.totals.perTokenPriced).toBe(1);
    expect(reducer.totals.perTokenKnownUsd).toBeCloseTo(1, 5);
  });
});
