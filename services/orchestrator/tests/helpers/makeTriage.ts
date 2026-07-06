// Test helper: makeTriage — the TriageAnswer answerer stub used by every spec-loop
// test suite. Split out of plannerLoopHelpers.ts to hold that file's 500-line cap.
//
// UNLIKE the plain makeAnswerer<TriageAnswer>, this helper AUTOMATICALLY EXTENDS
// each returned workItem's `findingIds` with the input finding ids sniffed from the
// triage prompt (matching `renderFindings` in `loopStagePrompts.ts` — the stable
// `- [<severity>] <id>: <title> — <body>` line format). This keeps the coverage-guard
// (`ensureFindingCoverage`, Codex critic RA1) satisfied for shared fixtures without
// them hardcoding auditor/demoRun/checker-fixed-point ids; the coverage-guard is
// checked as a superset, so extra listed ids are harmless. Explicit answer-declared
// ids stay in the trail. An EXPLICITLY empty `workItems` list is passed through
// unchanged so the empty-workItems P0 branch stays exercised end-to-end.
import type { TriageAnswer } from "../../src/engine/answerers/schemas/index.js";
import type { AnswererAdapter, AnswererRunOptions } from "../../src/engine/providers/types.js";

// Kept in sync with `plannerLoopHelpers.ts` — extracted here to avoid an import cycle.
const fakeAuthRef = "credential/self-hosted/tanren-fake";

export function makeTriage(
  answers: ReadonlyArray<TriageAnswer>,
): AnswererAdapter<TriageAnswer> & { calls: AnswererRunOptions<TriageAnswer>[] } {
  let index = 0;
  const calls: AnswererRunOptions<TriageAnswer>[] = [];
  return {
    kind: "answerer",
    cli: "fake",
    authRef: fakeAuthRef,
    calls,
    async runAnswerer(opts) {
      calls.push(opts);
      const answer = (answers[index] ?? answers.at(-1)) as TriageAnswer;
      index += 1;
      if (answer.workItems.length === 0) return answer;
      const inputIds = new Set<string>();
      for (const m of opts.prompt.matchAll(/^-\s*\[[^\]]+\]\s+([^:]+):/gmu)) inputIds.add(m[1]!.trim());
      if (inputIds.size === 0) return answer;
      return {
        ...answer,
        workItems: answer.workItems.map((wi) => ({
          ...wi,
          findingIds: [...new Set<string>([...wi.findingIds, ...inputIds])],
        })),
      };
    },
  };
}
