// Provider-backed fragment authorer (the real LLM seam) —
// docs/roadmap/templating-system.md F2.
//
// Adapts an `AnswererAdapter<FragmentAuthorerOutput>` into the `FragmentAuthorer`
// seam, mirroring the conversation/interview/discovery `wrapProvider*Answerer`
// pattern. Each `authorer(input)` call is ONE structured provider call returning
// `{ bodyTs }`. Production wires the allocating Forge answerer adapter (real LLM,
// real cost record, real per-run scoped credentials); tests use the
// `buildFakeFragmentAuthorer` deterministic fixture.
//
// WHY THE ANSWERER PATTERN (NOT THE WRITER PATTERN): a fragment body is a
// constrained-subset DECLARATIVE artifact (`apply(vfs, config)` calling a small
// typed set of `vfs.write/addPackageJsonDep/...` ops). It is INTERPRETED by
// `unifiedLibrary.ts:interpretOrgFragment` — never executed as raw TS in a
// workspace. The answerer (single-call, structured-output) is the right seam:
// it makes a real LLM call, returns parsed JSON, records cost/usage uniformly
// (the same path planner/checker/auditor/interview use). The writer pattern
// (workspace + diff capture + runner allocation) is OVERKILL — we don't need a
// workspace, a diff, or a runner; we need the LLM's structured body output.
//
// The fragment-authoring run still emits observable events through the
// `FragmentAuthoringEvents` seam (`fragment.authoring.{started,succeeded,failed}`),
// which `buildLiveRunFragmentAuthoring` wires into the durable event store —
// observable in the same run timeline as writer events.

import { z } from "zod";
import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import type { FragmentAuthorer, FragmentAuthorerInput, FragmentAuthorerOutput } from "./fragmentAuthoringRun.js";

const STEP_SCHEMA_NAME = "tanren.fragment_authoring.v1";

// The strict structured-output schema the LLM must satisfy. `bodyTs` is the
// fragment's TypeScript source — a default-exported `Fragment` whose `apply()`
// body uses ONLY the constrained subset `unifiedLibrary.ts:interpretOrgFragment`
// parses. The smoke-composition validator rejects bodies that don't compose.
const FragmentAuthorerAnswer = z
  .object({
    bodyTs: z.string().min(20),
  })
  .strict();

export function buildFragmentAuthorerPrompt(input: FragmentAuthorerInput): string {
  const { spec, lifecycle, previousAttempt } = input;
  const contractJson = JSON.stringify(spec.requiredContract);
  const lines = [
    `You are authoring ONE Tanren template-fragment in TypeScript.`,
    ``,
    `## The fragment slot`,
    `kind:   ${spec.kind}`,
    `label:  ${spec.label}`,
    `id:     ${spec.id}`,
    `contract (required fields the fragment must declare): ${contractJson}`,
    ``,
    `## The project lifecycle (context for what stack the fragment serves)`,
    `stack:     ${lifecycle.stack}`,
    `bootstrap: ${lifecycle.bootstrap}`,
    `build:     ${lifecycle.build}`,
    `deploy:    ${lifecycle.deploy}`,
    ``,
    `## What you must produce`,
    `Return JSON \`{ "bodyTs": "<string>" }\` where bodyTs is the TypeScript source`,
    `for a module that DEFAULT-EXPORTS a \`Fragment\` value. The module must:`,
    ``,
    `  1. Declare \`export const fragment: Fragment = { id, version, kind, contract, async apply(vfs, config) { ... } };\``,
    `     followed by \`export default fragment;\``,
    `  2. The \`apply\` block may ONLY call the constrained-subset vfs operations:`,
    `     - vfs.write("path", "content")             — create a brand-new file`,
    `     - vfs.overwrite("path", "content")          — replace an existing file (rare)`,
    `     - vfs.addPackageJsonDep("name", "version")  — register a runtime dep`,
    `     - vfs.addPackageJsonDevDep("name", "version") — register a dev dep`,
    `     - vfs.addEnvVar("KEY", "example-value")     — declare an env var`,
    `     - vfs.appendToJustfileTarget("target", ["line1", "line2"]) — fill a justfile hook`,
    `  3. NO other code in apply() — no conditionals, no loops, no fs/exec/http,`,
    `     no string concatenation in arguments. Each call must be one statement on`,
    `     its own line with literal string / array arguments. The parser is strict;`,
    `     bodies that step outside this subset are rejected at registration.`,
    `  4. Use ONLY string literals (double-quoted) and array literals as call`,
    `     arguments. Template literals (backticks) are also accepted for multi-line`,
    `     content. Do not interpolate.`,
    `  5. If your contract declares \`testRunner\` + \`reportPath\` (runtime fragments),`,
    `     wire the test runner via package.json deps + a vfs.write of the runner`,
    `     config + a vfs.appendToJustfileTarget("tier-2", [...]) call.`,
    ``,
    `## Example shape (do NOT just paste this — author the real fragment for the slot above):`,
    "```typescript",
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    `export const fragment: Fragment = {`,
    `  id: "${spec.id}",`,
    `  version: "1.0.0",`,
    `  kind: "${spec.kind}",`,
    `  contract: ${contractJson},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `    vfs.write("path/to/file", "content");`,
    `  },`,
    `};`,
    `export default fragment;`,
    "```",
  ];
  if (previousAttempt !== undefined) {
    lines.push(
      ``,
      `## Previous attempt — rejected`,
      `Your previous body was rejected by the validator. Here is what you produced and why it failed:`,
      ``,
      `### Previous bodyTs (truncated to 4000 chars)`,
      "```typescript",
      previousAttempt.bodyTs.slice(0, 4000),
      "```",
      ``,
      `### Rejection reason`,
      previousAttempt.rejection,
      ``,
      `Address the rejection directly in your next attempt. Do not repeat the same body.`,
    );
  }
  return lines.join("\n");
}

export function wrapProviderFragmentAuthorer(adapter: AnswererAdapter<FragmentAuthorerOutput>): FragmentAuthorer {
  const jsonSchema = renderAnswererJsonSchema(FragmentAuthorerAnswer);
  return async (input: FragmentAuthorerInput): Promise<FragmentAuthorerOutput> => {
    return adapter.runAnswerer({
      prompt: buildFragmentAuthorerPrompt(input),
      outputSchema: {
        name: STEP_SCHEMA_NAME,
        jsonSchema,
        parse: (value): FragmentAuthorerOutput => {
          const parsed = FragmentAuthorerAnswer.parse(value);
          return { bodyTs: parsed.bodyTs };
        },
      },
    });
  };
}
