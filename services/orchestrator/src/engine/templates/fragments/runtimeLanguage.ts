// RUNTIME LANGUAGE MAPPING — the fail-fast bound on which runtime fragments the
// per-fragment authoring DAG will KICK OFF (apex v72 fix — task #144). Extracted
// from `fragmentAuthoringRun.ts` so the file stays under the 500-line
// architecture cap.
//
// A runtime fragment whose target language has no test-file recognizer in
// `functionalTestRecognizer.ts` cannot pass the smoke composition — no matter
// what the writer produces, the composition rejects the fragment with
// "no runtime added a meaningful functional test", the writer's next attempt
// sees the same rejection, and the writer-rework loop halts at the fixed point
// after burning ≥2 LLM cycles on identical rejections. `authorOneFragment`
// consults `deriveRuntimeLanguage(spec.label)` at kick-off and fails LOUD with
// `unsupported_runtime_language` BEFORE the first LLM call so the operator sees
// the real reason (extend the recognizer) instead of the "no meaningful test"
// wall.
//
// The mapping is intentionally lenient: any label whose HEAD token
// (hyphen/underscore/slash-split) matches one of the known heads counts —
// `node-pnpm`, `pnpm`, `ts` all → ts; `python`, `python-uv`, `poetry`, `uv` all
// → python; and so on. A label like `haskell` or `russian-fanfiction` returns
// null and triggers the fail-fast.
//
// EXTENDING: to accept a new runtime language, extend
// `functionalTestRecognizer.ts` FIRST (add the file-shape + assertion regexes),
// THEN extend this mapping. The recognizer must actually accept the language's
// test forms before authoring is allowed to try.

/** The set of runtime "languages" the smoke recognizer supports. */
export type SupportedRuntimeLanguage = "ts" | "ruby" | "go" | "python" | "rust";

/** Map a runtime fragment's label to a supported language, or null when the
 * label does not map. See file docblock for the doctrine + extension protocol. */
export function deriveRuntimeLanguage(label: string): SupportedRuntimeLanguage | null {
  const normalized = label.toLowerCase().trim();
  if (normalized === "") return null;
  const head = normalized.split(/[-/_]/u)[0] ?? "";
  const tsHeads = new Set(["node", "pnpm", "npm", "yarn", "ts", "typescript", "js", "javascript", "bun", "deno"]);
  if (tsHeads.has(head) || tsHeads.has(normalized)) return "ts";
  if (head === "ruby" || head === "rails" || head === "bundler") return "ruby";
  if (head === "go" || head === "golang") return "go";
  if (head === "python" || head === "py" || head === "uv" || head === "poetry" || head === "pip") return "python";
  if (head === "rust" || head === "cargo") return "rust";
  return null;
}

/** The recognized-runtime-language label set (human-readable, kept in sync with
 * `deriveRuntimeLanguage`). Surfaced in the rejection message so an operator
 * halts on the real cause instead of chasing the smoke composition's "no
 * meaningful test" through the writer-rework loop. */
export const SUPPORTED_RUNTIME_LANGUAGES: readonly string[] = ["ts", "ruby", "go", "python", "rust"];

/** Build the `unsupported_runtime_language` rejection reason for the given
 * runtime label. The message names the label, enumerates the recognized set,
 * points at the extension protocol, AND names the two files an operator must
 * touch to add support — so the halt is loud + directly actionable. */
export function unsupportedRuntimeLanguageReason(label: string): string {
  const recognized = SUPPORTED_RUNTIME_LANGUAGES.join(", ");
  return (
    `unsupported_runtime_language: the runtime label "${label}" does not map to a language the ` +
    `Tanren smoke-composition test-file recognizer supports.\n` +
    `Recognized languages: ${recognized}.\n` +
    `To add support for "${label}", the operator MUST touch two files IN ORDER:\n` +
    `  1. services/orchestrator/src/engine/templates/fragments/functionalTestRecognizer.ts\n` +
    `     — extend isCandidateTestPath + hasMeaningfulAssertion for the language's test-file shape ` +
    `and assertion form (see the existing Go/Python/Rust entries as templates).\n` +
    `  2. services/orchestrator/src/engine/templates/fragments/runtimeLanguage.ts\n` +
    `     — extend deriveRuntimeLanguage's head-token map + the SupportedRuntimeLanguage union.\n` +
    `Authoring this runtime BEFORE the recognizer knows the language wastes real LLM credits: every ` +
    `attempt will fail the smoke composition on "no runtime added a meaningful functional test" and ` +
    `the writer-rework loop will halt at the fixed point with no evidence of what the writer got wrong.`
  );
}
