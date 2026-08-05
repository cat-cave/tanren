/**
 * commitGateSteering — renders a commit rejected by the PROJECT's own pre-commit gate
 * into writer-rework steering. The commit-gate analogue of `subtaskInnerLoop.gateReason`,
 * and deliberately the same shape, because to the writer the two are the same problem: a
 * declared quality bar the work has to clear.
 *
 * Split out of subtaskInnerLoop.ts to keep that file under the 500-line architecture cap.
 *
 * WHY THE WRITER GETS THIS AT ALL. The writer adapters edit the workspace in place and
 * Tanren commits afterwards with the repo's hook path LIVE, so the project's pre-commit
 * gate votes on Tanren's output. A NO vote used to be a thrown `WorkspaceCommandError`
 * that nothing on the writer path caught: the run died, every passed subtask and all
 * convergence state was discarded, and the writer — already exited — never learned
 * anything was wrong. Yet a commit rejected by the project's own quality gate is the most
 * actionable failure a writer can receive: deterministic, local, reproducible, and
 * self-describing. So it is fed back instead (providers/writerCommitGate.ts classifies it,
 * the subtask loop routes it through the same convergence budget a gate tier uses).
 */
import type { CommitRejection } from "../providers/types.js";

/**
 * The hook's own output is the payload, and it is why this typically recovers in one
 * iteration rather than several: it names the files, the lines and the rule, so the writer
 * fixes the actual violation instead of guessing from "the commit failed".
 *
 * The directive is the careful part. A pre-commit hook is trivially defeatable
 * (`--no-verify`, `core.hooksPath=/dev/null`, deleting the hook, loosening a rule to
 * nothing), and a writer told only "make the commit succeed" may well do exactly that —
 * handing back a PR whose green gate proves nothing. So the steering is explicit that the
 * ONLY acceptable resolution is to satisfy the gate. It equally does not over-rotate:
 * registering a genuinely new domain term in the project's own dictionary, or any
 * comparable declared-configuration update, IS the correct fix and is exactly what a human
 * maintainer does — so that is named as legitimate, while disabling, skipping or hollowing
 * out the check is named as not.
 */
export function commitRejectionReason(rejection: CommitRejection | undefined): string {
  const header =
    rejection === undefined
      ? "the project's own pre-commit gate REJECTED your work"
      : `the project's own pre-commit gate REJECTED your work (exit ${rejection.exitCode})`;
  const directive =
    "This is the project's declared quality bar for every commit — lint, format, spell-check, " +
    "types, whatever it enforces — and your change has to clear it. Read the hook output below, " +
    "find the specific violations it names, and fix them at the source. If the hook is flagging " +
    "something that is genuinely correct and new (a new domain term the project's dictionary has " +
    "not seen, a new path its config does not yet cover), then updating the project's OWN " +
    "declared configuration to register it is the right fix — that is what a maintainer would do. " +
    "What you must NOT do is evade the check: never pass --no-verify, never redirect or delete " +
    "core.hooksPath, never remove or disable a hook, and never weaken a rule merely to silence " +
    "this failure. A hook that ran and passed is evidence; a hook that was skipped is not.";
  const parts: string[] = [header, directive];
  if (rejection !== undefined && rejection.output !== "") {
    parts.push(`Commit gate output:\n${rejection.output}`);
  }
  return parts.join("\n");
}
