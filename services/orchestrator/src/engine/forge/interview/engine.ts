// P3-0015 greenfield onboarding: the vision-interview engine.
//
// Two operations, mirroring the P3-0014 discovery engine shape:
//
//   runRound(deps, input)
//     Runs ONE interview round over the injectable `InterviewAnswerer` (the
//     same seam shape as the P3-0010 conversation answerer — provider in prod,
//     fake in tests, deterministic fallback otherwise). It feeds the answerer
//     the round number + the operator's prior answer + the running capture,
//     then MERGES the returned delta into the capture and returns the next
//     question + the updated capture. NOTHING is persisted — the surface
//     re-submits the running capture each round (pause/resume = stash the
//     capture client-side / on a draft), so there is no interview-session table.
//
//   deriveFromCapture(deps, input)
//     On completion, turns the accumulated capture into a live project's
//     product graph through the existing P2A-0018/0013 creation paths (see
//     `derive.ts`). Returns the new project + the derived spec/entity ids; the
//     DAG is then read back via P3-0013's `getProjectDag`.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import { mergeCapture } from "./capture.js";
import { createDeterministicInterviewAnswerer } from "./defaultAnswerer.js";
import { deriveProductGraph, type DeriveResult } from "./derive.js";
import {
  DEFAULT_TOTAL_ROUNDS,
  InterviewCapture,
  InterviewRoundOutput,
  emptyCapture,
  type InterviewAnswerer,
  type InterviewRoundOutput as InterviewRoundOutputType,
  type InterviewSuggestion,
} from "./types.js";

export interface InterviewEngineDeps {
  pool: pg.Pool;
  // Injectable/mockable interview seam. Defaults to the deterministic scripted
  // answerer so the greenfield flow is live without provider infra.
  answerer?: InterviewAnswerer;
  totalRounds?: number;
}

export interface RunRoundInput {
  // 1-based round the operator is answering. Round 1 has an empty `answer`.
  round: number;
  answer: string;
  // The capture accumulated so far (the surface re-submits it each round).
  capture: InterviewCapture;
}

export interface RunRoundResult {
  round: number;
  totalRounds: number;
  // Forge's next question (or closing line when `complete`).
  say: string;
  suggestions: InterviewSuggestion[];
  // The capture AFTER merging this round's delta.
  capture: InterviewCapture;
  complete: boolean;
}

export async function runRound(deps: InterviewEngineDeps, input: RunRoundInput): Promise<RunRoundResult> {
  const totalRounds = deps.totalRounds ?? DEFAULT_TOTAL_ROUNDS;
  const answerer = deps.answerer ?? createDeterministicInterviewAnswerer();
  const priorCapture = InterviewCapture.parse(input.capture);

  const rawOutput = await answerer.ask({
    round: input.round,
    totalRounds,
    answer: input.answer,
    capture: priorCapture,
  });
  // Validate the answerer output at the engine boundary (defence in depth; a
  // provider that drifts from the schema is normalized/rejected here).
  const output: InterviewRoundOutputType = InterviewRoundOutput.parse(rawOutput);

  const nextCapture = mergeCapture(priorCapture, output.captureDelta);
  return {
    round: input.round,
    totalRounds,
    say: output.say,
    suggestions: output.suggestions,
    capture: nextCapture,
    complete: output.complete,
  };
}

export interface DeriveFromCaptureInput {
  orgId: string;
  capture: InterviewCapture;
  actor: ActorContext;
  repoUrl?: string;
}

export async function deriveFromCapture(
  deps: InterviewEngineDeps,
  input: DeriveFromCaptureInput,
): Promise<DeriveResult> {
  return deriveProductGraph(deps.pool, {
    orgId: input.orgId,
    capture: InterviewCapture.parse(input.capture),
    actor: input.actor,
    ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
  });
}

export { emptyCapture, DEFAULT_TOTAL_ROUNDS };
export type { DeriveResult };
