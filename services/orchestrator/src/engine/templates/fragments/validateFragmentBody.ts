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
import { loadFragmentLibrary } from "./library/index.js";
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

  // 1a) Round-III M4: reject an EMPTY apply() body. A body that parses cleanly
  // but declares zero vfs operations is a no-op fragment — it validates through
  // both smokes because base+runtime+deploy produce the meaningful files, but
  // the org's persisted fragment then contributes NOTHING. A no-op fragment
  // is never useful; more importantly, it silently passes as "validated" and
  // shadows the bundled fragment for that (kind, label) — a stealth downgrade.
  if (ops.length === 0) {
    return {
      kind: "failed",
      reason:
        `empty apply() body: the fragment declares no vfs operations (no file writes, no dep declarations, no env vars, no justfile hooks). ` +
        `A fragment must produce at least one meaningful mutation — the writer must fill the apply() block with at least one ` +
        `vfs.write / vfs.overwrite / vfs.addPackageJsonDep / vfs.addPackageJsonDevDep / vfs.addEnvVar / vfs.appendToJustfileTarget call.`,
    };
  }

  // 2) Derive implicit `dependsOn` (audit #11) — see `implicitDependsOn.ts`.
  const derivedDependsOn = deriveImplicitDependsOn(ops, args.spec);

  // 2a) Round-III M1: pre-check derived runtime-dependency ids against the
  // BUNDLED library. If any derived `runtime-<lang>` id is not shipped, halt
  // LOUD with an unsupported_runtime_language reason BEFORE the smoke steps
  // (which would defer the failure to a cryptic `library.require: no fragment
  // registered for id "runtime-python-uv"` deep in the composer). The writer's
  // rework loop then sees the direct halt class + can pivot to a shipped
  // runtime instead of iterating on runtime tooling the library cannot compose.
  const bundled = loadFragmentLibrary();
  const missingRuntimeDeps = derivedDependsOn.filter((id) => id.startsWith("runtime-") && !bundled.has(id));
  if (missingRuntimeDeps.length > 0) {
    const shippedRuntimes = bundled
      .all()
      .filter((f) => f.kind === "runtime")
      .map((f) => f.id);
    return {
      kind: "failed",
      reason:
        `unsupported_runtime_language: the fragment implicitly requires runtime "${missingRuntimeDeps[0]}" ` +
        `(derived from the ops it declared — pyproject/go.mod/Cargo.toml/pip/poetry/uv/cargo/rustc/go/python tokens) ` +
        `but no such runtime fragment ships in the Tanren library. Available runtimes: ${shippedRuntimes.join(", ")}. ` +
        `Author your fragment for one of the shipped runtimes — do not fill the body with tooling for a runtime the library cannot compose.`,
    };
  }

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
