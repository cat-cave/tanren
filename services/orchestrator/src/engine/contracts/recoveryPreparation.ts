import type { ConflictRecoveryReceipt, TerminalParkNoopStatus } from "./conflictResolution.js";

export type RecoveryPreparationRoute =
  | {
      kind: "planner_replan";
      newContext: string;
      otherSpecId?: string;
      conflictSignature: string;
    }
  | {
      kind: "regate_writer_rework";
      prNumber: number;
      gateError: string;
      priorReworks: number;
    }
  | {
      kind: "batch_writer_rework";
      prNumber: number;
      gateError: string;
      priorReworks: number;
    };

/** Exact old ownership plus every byte needed to prepare and observe its successor. */
export interface RecoveryPreparationInput {
  orgId: string;
  projectId: string;
  specId: string;
  oldRunId: string;
  /** Optional only for callers that must resolve the unique old-run queue row server-side. */
  queueId?: string;
  steeringNote: string;
  reopenStatus: "open";
  route: RecoveryPreparationRoute;
}

export type RecoveryPreparationOutcome =
  | { kind: "owned"; receipt: ConflictRecoveryReceipt; newlyPrepared: boolean }
  | { kind: "terminal_noop"; status: TerminalParkNoopStatus; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "failure"; reason: "invalid_input" | "write_failed" | "transport_failed"; message: string };

/** One authority for steering + reopen + successor + canonical routing events. */
export interface RecoveryPreparationWriter {
  prepareRecovery(input: RecoveryPreparationInput): Promise<RecoveryPreparationOutcome>;
  /** Exact durable readback used only after an ambiguous remote response. */
  readRecoveryPreparation(input: RecoveryPreparationInput): Promise<RecoveryPreparationOutcome>;
}
