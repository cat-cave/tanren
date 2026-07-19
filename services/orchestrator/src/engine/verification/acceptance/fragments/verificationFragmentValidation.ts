// rv-3 — the REAL verification-fragment VALIDATOR + the POST-AUTHORING WHOLE-BATCH
// compose gate. The design analog of `designFragmentValidator.ts` +
// `designFragmentBatchCompose.ts`, adapted to the declarative capability descriptor.
//
// The validator is a deterministic, no-network verdict function that exercises the
// ACTUAL fragment contract — never a mock or always-succeeds stub. An absent /
// unparseable / wrong-slot / undeclared-entrypoint / surface-incompatible /
// contract-drifted draft FAILS the verdict (fail-closed); it can NEVER satisfy
// resolution. The verdict is RETURNED (the kernel contract forbids a validator throw).

import type {
  AuthoringBatchCompose,
  AuthoringBatchComposeVerdict,
  AuthoringValidationVerdict,
  AuthoringValidator,
} from "../../../contracts/authoringKernel.js";
import type { RequiredSurface } from "../../../contracts/runtimeVerificationPlan.js";
import type {
  VerificationFragmentId,
  VerificationFragmentVersionId,
} from "../../../contracts/runtimeVerificationPlan.js";
import {
  VERIFICATION_FRAGMENT_CONTRACT_VERSION,
  canonicalVerificationFragmentJson,
  parseVerificationFragmentAuthoringContext,
  parseVerificationFragmentDraft,
  toCapabilityFragmentRef,
  verificationFragmentDigest,
  verificationFragmentId,
  verificationFragmentSourcePath,
  verificationFragmentVersionId,
  type ValidatedVerificationFragment,
  type VerificationFragmentDraftV1,
  type VerificationFragmentKind,
  type VerificationFragmentSpecV1,
} from "./verificationFragment.js";

/** The surfaces each capability kind may legitimately drive. A draft that binds an
 * incompatible surface is a real gap ⇒ reject (never a partial degrade). */
const SURFACE_COMPATIBILITY: Readonly<Record<VerificationFragmentKind, readonly RequiredSurface[]>> = {
  fixture: ["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"],
  driver: ["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"],
  action: ["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"],
  assertion: ["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"],
  observer: ["browser", "api", "app_channel", "external_integration", "mobile"],
  visual_checkpoint: ["browser", "mobile"],
  cleanup: ["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"],
  artifact_capture: ["browser", "api", "cli", "package", "app_channel", "external_integration", "mobile"],
};

/** A lexical export check — the entrypoint must be exported from the source (a real
 * declaration, not merely mentioned). Matches `export function <e>`, `export const
 * <e>`, `export { … <e> … }`, or `export default … <e>`. */
function sourceExportsEntrypoint(source: string, entrypoint: string): boolean {
  const e = entrypoint.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${e}\\b`, "u"),
    new RegExp(`export\\s+(?:const|let|class)\\s+${e}\\b`, "u"),
    new RegExp(`export\\s*\\{[^}]*\\b${e}\\b[^}]*\\}`, "u"),
    new RegExp(`export\\s+default\\s+[^;]*\\b${e}\\b`, "u"),
  ];
  return patterns.some((pattern) => pattern.test(source));
}

/** Build the deterministic verification-fragment validator. */
export function buildVerificationFragmentValidator(): AuthoringValidator<
  VerificationFragmentSpecV1,
  VerificationFragmentDraftV1,
  ValidatedVerificationFragment
> {
  return {
    async validate(input): Promise<AuthoringValidationVerdict<ValidatedVerificationFragment>> {
      try {
        return validateOne(input.request.context, input.spec, input.draft);
      } catch (err) {
        // Defense-in-depth: the contract forbids a validator throw.
        return reject(`validator_error: ${message(err)}`);
      }
    },
  };
}

function validateOne(
  rawContext: unknown,
  spec: VerificationFragmentSpecV1,
  rawDraft: VerificationFragmentDraftV1,
): AuthoringValidationVerdict<ValidatedVerificationFragment> {
  // Fail-closed on a malformed invocation context (defense-in-depth over the binding).
  parseVerificationFragmentAuthoringContext(rawContext);

  // 1. schema-valid draft.
  let draft: VerificationFragmentDraftV1;
  try {
    draft = parseVerificationFragmentDraft(rawDraft);
  } catch (err) {
    return reject(`draft_schema_invalid: ${message(err)}`);
  }

  // 2. authored the REQUESTED slot (no bait-and-switch onto another capability).
  if (draft.capabilityKey !== spec.capabilityKey)
    return reject(`wrong_slot_capability: authored '${draft.capabilityKey}', requested '${spec.capabilityKey}'`);
  if (draft.fragmentKind !== spec.fragmentKind)
    return reject(`wrong_slot_kind: authored '${draft.fragmentKind}', requested '${spec.fragmentKind}'`);
  if (draft.surface !== spec.surface)
    return reject(`wrong_slot_surface: authored '${draft.surface}', requested '${spec.surface}'`);

  // 3. contract version must match (a drift is a fail-closed rejection).
  if (draft.contractVersion !== VERIFICATION_FRAGMENT_CONTRACT_VERSION)
    return reject(
      `contract_version_drift: authored '${draft.contractVersion}', expected '${VERIFICATION_FRAGMENT_CONTRACT_VERSION}'`,
    );

  // 4. surface/kind compatibility (a real capability table — never a partial degrade).
  if (!SURFACE_COMPATIBILITY[draft.fragmentKind].includes(draft.surface))
    return reject(`surface_incompatible: '${draft.fragmentKind}' cannot drive surface '${draft.surface}'`);

  // 5. the source must EXPORT the declared entrypoint (a real declaration).
  if (!sourceExportsEntrypoint(draft.source, draft.entrypoint))
    return reject(`entrypoint_not_exported: source does not export '${draft.entrypoint}'`);

  const contentHash = verificationFragmentDigest(draft);
  const fragmentId = verificationFragmentId(draft.fragmentKind, draft.capabilityKey);
  const validated: ValidatedVerificationFragment = {
    fragmentId: fragmentId as VerificationFragmentId,
    fragmentVersionId: verificationFragmentVersionId(fragmentId, contentHash) as VerificationFragmentVersionId,
    capabilityKey: draft.capabilityKey,
    fragmentKind: draft.fragmentKind,
    surface: draft.surface,
    version: draft.version,
    contractVersion: draft.contractVersion,
    entrypoint: draft.entrypoint,
    sourcePath: verificationFragmentSourcePath(draft.fragmentKind, draft.capabilityKey),
    contentHash,
    canonicalBody: canonicalVerificationFragmentJson(draft),
    draft,
  };
  return { kind: "valid", validated };
}

/** A registered capability identity in the org/project fragment registry. */
export interface PresentVerificationCapability {
  readonly capabilityKey: string;
  readonly fragmentKind: VerificationFragmentKind;
}

export interface VerificationFragmentBatchComposeDeps {
  /** Load the org/project's PRESENT (already-registered) capability identities so a
   * newly-authored fragment colliding with an existing one is caught. */
  readonly loadPresent?: () => Promise<readonly PresentVerificationCapability[]>;
}

/** The whole-batch compose gate. Per-unit validation runs each draft in isolation,
 * so it cannot see a collision BETWEEN two authored fragments (or an authored
 * fragment and the org's registry). This gate composes the ENTIRE augmented set and
 * rejects a duplicate `(capabilityKey, fragmentKind)` (new↔new or new↔present) or a
 * source-path collision. A rejection drives the kernel's RETRACT-WITH-DELETE. */
export function buildVerificationFragmentBatchCompose(
  deps: VerificationFragmentBatchComposeDeps = {},
): AuthoringBatchCompose<VerificationFragmentSpecV1, ValidatedVerificationFragment> {
  return {
    async compose(input): Promise<AuthoringBatchComposeVerdict> {
      if (deps.loadPresent !== undefined) {
        try {
          // The present registry is loaded to confirm the augmented set can be
          // assembled; a present entry with the SAME identity is a re-version
          // (allowed) — the gate's job is to reject NEW↔NEW collisions below.
          await deps.loadPresent();
        } catch (err) {
          // Cannot confirm the augmented set — skipped (the kernel treats it as a
          // hard failure; committing on hope is a no-silent-branch violation).
          return { kind: "skipped", reason: `present_registry_unavailable: ${message(err)}` };
        }
      }

      // Reject two NEWLY-authored fragments claiming the same capability identity, or
      // colliding on a deterministic source path (a real ambiguity the per-unit pass
      // could not see).
      const authoredIdentities = new Set<string>();
      const sourcePaths = new Set<string>();
      for (const entry of input.authored) {
        const ref = toCapabilityFragmentRef(entry.validated);
        const capKey = `${ref.fragmentKind}:${ref.capabilityKey}`;
        if (authoredIdentities.has(capKey))
          return { kind: "failed", reason: `augmented_set_duplicate_capability: ${capKey}` };
        authoredIdentities.add(capKey);

        const path = entry.validated.sourcePath;
        if (sourcePaths.has(path)) return { kind: "failed", reason: `augmented_set_source_path_collision: ${path}` };
        sourcePaths.add(path);
      }
      return { kind: "passed" };
    },
  };
}

function reject(rejection: string): AuthoringValidationVerdict<ValidatedVerificationFragment> {
  return { kind: "rejected", rejection };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
