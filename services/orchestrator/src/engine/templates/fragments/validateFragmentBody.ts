// F2 VALIDATE — parse + smoke-compose the authored body (docs/roadmap/templating-system.md).
//
// Extracted from `fragmentAuthoringRun.ts` to keep that file under the 500-line cap.
// A pass proves:
//   • the body's structure IS the constrained subset (parses via `parseFragmentBody`),
//   • `interpretOrgFragment` builds a real Fragment,
//   • that Fragment composes with the bundled library BOTH in isolation AND in the
//     full-library kitchen-sink (audit finding H5 — task #150),
//   • AND — when the runtime-validity seam is wired — the runtime's dependency
//     resolver accepts the composed scaffold (runtime-validity smoke — the final gate).
//
// The persisted `dependsOn` is DERIVED from the parsed ops (audit finding #11) so a
// fragment that uses node-pnpm-only ops without declaring the runtime dep is caught
// here rather than silently dropping deps in a later compose.

import { deriveImplicitDependsOn } from "./implicitDependsOn.js";
import { runRuntimeValiditySmoke, type RuntimeValiditySmokeDeps } from "./runtimeValiditySmoke.js";
import {
  runFullLibrarySmokeComposition,
  runSmokeComposition,
  type SmokeFailed,
  type SmokeOk,
} from "./smokeComposition.js";
import type { FragmentSpec } from "./selectFragmentConfig.js";
import { type Fragment } from "./types.js";
import { type FragmentOp, interpretOrgFragment, FragmentBodyParseError, parseFragmentBody } from "./unifiedLibrary.js";
import { createLogger } from "../../observability/logger.js";

const log = createLogger("fragment-validate");

/** Parse + smoke-compose an authored body. See the file header for the pass contract.
 * Non-throwing — every rejection surfaces as a `SmokeFailed.reason` so the F2 loop
 * can feed it back to the writer as `previousAttempt.rejection`. */
export async function validateFragmentBody(args: {
  spec: FragmentSpec;
  bodyTs: string;
  runtimeValiditySmoke?: RuntimeValiditySmokeDeps;
}): Promise<SmokeOk | SmokeFailed> {
  // 1) Parse — rejects bodies that step outside the constrained subset. We pull
  // ops separately to derive the implicit dependsOn (audit finding #11) and to
  // build the smoke Fragment with the correct dependsOn so the cross-runtime
  // pre-flight in `composeTemplate` sees the right shape.
  let ops: FragmentOp[];
  try {
    ops = parseFragmentBody(args.bodyTs);
  } catch (err) {
    const reason =
      err instanceof FragmentBodyParseError
        ? `body parse rejected: ${err.message}`
        : `body parse threw: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "failed", reason };
  }

  // 2) Derive implicit `dependsOn` (audit #11) — see `implicitDependsOn.ts`.
  const derivedDependsOn = deriveImplicitDependsOn(ops, args.spec);

  // 3) Build the Fragment carrying derivedDependsOn so cross-runtime pre-flight sees it.
  let fragment: Fragment;
  try {
    fragment = interpretOrgFragment({
      fragmentId: `validate:${args.spec.id}:1.0.0`,
      kind: args.spec.kind,
      label: args.spec.label,
      version: "1.0.0",
      bodyTs: args.bodyTs,
      contract: args.spec.requiredContract,
      dependsOn: derivedDependsOn,
    });
  } catch (err) {
    const reason =
      err instanceof FragmentBodyParseError
        ? `body parse rejected: ${err.message}`
        : `body parse threw: ${err instanceof Error ? err.message : String(err)}`;
    return { kind: "failed", reason };
  }

  // 4) Smoke-compose in isolation — the minimal config that exercises THIS
  // fragment. Post-compose runtime validators (ci.yml schema, fresh-checkout
  // bootstrap, pnpm non-interactive) run here.
  const isolated = await runSmokeComposition(args.spec, fragment, derivedDependsOn);
  if (isolated.kind !== "ok") return isolated;

  // 5) Full-library smoke — kitchen-sink compose (audit H5 — catches isolated-fine-but-composes-with-conflict).
  const full = await runFullLibrarySmokeComposition(args.spec, fragment, derivedDependsOn);
  if (full.kind !== "ok") return full;

  // 6) Runtime-validity smoke — the final gate; composition-validity ≠ runtime-validity.
  // Materializes the composed VFS + runs the runtime's dep resolver (e.g. pnpm install).
  // Skipped with a log when deps aren't wired (composition-validity tests).
  if (args.runtimeValiditySmoke === undefined) {
    log.info("runtime-validity smoke deps not wired — skipping", { specId: args.spec.id });
    return { kind: "ok", dependsOn: derivedDependsOn };
  }
  const runtime = await runRuntimeValiditySmoke({
    spec: args.spec,
    fragment,
    derivedDependsOn,
    deps: args.runtimeValiditySmoke,
  });
  if (runtime.kind !== "ok") return runtime;
  return { kind: "ok", dependsOn: derivedDependsOn };
}
