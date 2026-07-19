// ds-3 (F2D) — the REAL design-fragment VALIDATOR (checker/auditor).
//
// The design analog of `validateFragmentBody.ts`. It is a deterministic,
// no-network verdict function that exercises the ACTUAL ds-0/1/2 substrate — never
// a mock or always-succeeds stub. An absent / unparseable / not_composable / wrong-slot
// draft FAILS the verdict (fail-closed); it can NEVER satisfy composition. The
// verdict object is returned (the contract forbids throwing from a validator).
//
// The checks, in order (each REAL against a shipped ds-0/1/2 module):
//   1. schema-valid draft            (`parseDesignFragmentDraft`, ds-3)
//   2. authored the REQUESTED slot   (kind/label/phase coherence vs the spec)
//   3. apply plan materializes        (ds-1 `DesignVfs` — path safety, op-kind
//      onto a fresh VFS               compatibility, case-insensitive collision)
//   4. token files resolve            (ds-1 DTCG resolver — parse + alias graph)
//   5. capabilities are composable    (ds-2 adapter `materialize` → assertCapability;
//      by the target adapter          an unsupported capability is a real gap ⇒ reject)

import {
  parseDesignFragmentSpec,
  type DesignArtifactFileV1,
  type DesignFragmentSpecV1,
} from "../designArtifactSchemas.js";
import { sha256Digest } from "../artifactStore.js";
import { DesignVfs, type DesignVfsFileInput } from "../designVfs.js";
import { validateDtcgDocument } from "../dtcgValidator.js";
import type { DesignTargetAdapter } from "../designTargetAdapter.js";
import type {
  AuthoringValidationVerdict,
  AuthoringValidator,
  AuthoringKernelInput,
} from "../../../contracts/authoringKernel.js";
import { parseDesignFragmentAuthoringContext } from "./designFragmentContext.js";
import {
  canonicalDesignFragmentDraftJson,
  designFragmentDraftDigest,
  designFragmentReleaseId,
  parseDesignFragmentDraft,
  type DesignFragmentDraftOperation,
  type DesignFragmentDraftV1,
  type ValidatedDesignFragment,
} from "./designFragmentDraft.js";

/** The VFS-add method each typed operation drives on the design VFS. */
const OPERATION_METHODS: Readonly<Record<DesignFragmentDraftOperation["operation"], keyof DesignVfs>> = {
  addTokenSet: "addTokenSet",
  addMode: "addMode",
  addAlias: "addAlias",
  addComponent: "addComponent",
  addScenario: "addScenario",
  addAsset: "addAsset",
  addExporter: "addExporter",
  addCatalogRoute: "addCatalogRoute",
};

/** Build the deterministic design-fragment validator. `adapterFor` resolves the
 * target adapter a draft's capabilities are checked against (production wires the
 * ds-2 web adapter registry); a draft that declares an unsupported capability is a
 * real F2D gap and REJECTS — it never degrades to a partial projection. */
export function buildDesignFragmentValidator(
  adapterFor: (draft: DesignFragmentDraftV1) => DesignTargetAdapter,
): AuthoringValidator<DesignFragmentSpecV1, DesignFragmentDraftV1, ValidatedDesignFragment> {
  return {
    async validate(input): Promise<AuthoringValidationVerdict<ValidatedDesignFragment>> {
      try {
        return await validateOne(input.request, input.spec, input.draft, adapterFor);
      } catch (err) {
        // Defense-in-depth: the contract forbids a validator throw. Any unexpected
        // error becomes a rejection (fail-closed), never an escape.
        return { kind: "rejected", rejection: `validator_error: ${message(err)}` };
      }
    },
  };
}

async function validateOne(
  request: AuthoringKernelInput<DesignFragmentSpecV1>,
  spec: DesignFragmentSpecV1,
  rawDraft: DesignFragmentDraftV1,
  adapterFor: (draft: DesignFragmentDraftV1) => DesignTargetAdapter,
): Promise<AuthoringValidationVerdict<ValidatedDesignFragment>> {
  const context = parseDesignFragmentAuthoringContext(request.context);

  // 1. schema-valid draft.
  let draft: DesignFragmentDraftV1;
  try {
    draft = parseDesignFragmentDraft(rawDraft);
  } catch (err) {
    return reject(`draft_schema_invalid: ${message(err)}`);
  }

  // 2. authored the REQUESTED slot (no bait-and-switch onto a different fragment).
  if (draft.kind !== spec.kind) return reject(`wrong_slot_kind: authored '${draft.kind}', requested '${spec.kind}'`);
  if (draft.label !== spec.label)
    return reject(`wrong_slot_label: authored '${draft.label}', requested '${spec.label}'`);
  if (draft.phase !== spec.phase)
    return reject(`wrong_slot_phase: authored '${draft.phase}', requested '${spec.phase}'`);

  // 3. apply plan materializes onto a fresh DesignVfs (ds-1 — path safety +
  //    op-kind compatibility + case-insensitive collision all fail loud here).
  const files: DesignArtifactFileV1[] = [];
  const vfs = new DesignVfs();
  for (const op of draft.operations) {
    const file = descriptorFor(op);
    try {
      (vfs[OPERATION_METHODS[op.operation]] as (input: DesignVfsFileInput) => void)(file);
    } catch (err) {
      return reject(`apply_plan_rejected: ${message(err)}`);
    }
    files.push({ ...file });
  }

  // 4. token files resolve against the DTCG core (parse + full alias graph).
  for (const op of draft.operations) {
    if (op.fileKind !== "tokens") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(op.content);
    } catch (err) {
      return reject(`token_file_not_json: '${op.path}': ${message(err)}`);
    }
    const report = validateDtcgDocument(parsed);
    if (!report.ok) {
      const finding = report.findings[0];
      return reject(`token_file_unresolved: '${op.path}': ${finding?.code ?? "unknown"} — ${finding?.message ?? ""}`);
    }
  }

  // 5. capabilities are composable by the resolved target adapter (ds-2). An
  //    UnsupportedDesignCapabilityError is a real gap ⇒ reject, never a partial.
  const specAsFragment = specFromDraft(draft);
  try {
    await adapterFor(draft).materialize([specAsFragment], vfs);
  } catch (err) {
    return reject(`capability_not_composable: ${message(err)}`);
  }

  const canonicalBody = canonicalDesignFragmentDraftJson(draft);
  const validated: ValidatedDesignFragment = {
    fragmentReleaseId: designFragmentReleaseId(context.orgId, draft.kind, draft.label, draft.version),
    fragmentDigest: designFragmentDraftDigest(draft),
    fragmentVersion: draft.version,
    spec: specAsFragment,
    files,
    canonicalBody,
    draft,
  };
  return { kind: "valid", validated };
}

/** Content-address a draft operation's content into a `DesignArtifactFileV1` descriptor. */
function descriptorFor(op: DesignFragmentDraftOperation): DesignArtifactFileV1 {
  const bytes = new TextEncoder().encode(op.content);
  return {
    path: op.path,
    kind: op.fileKind,
    mediaType: op.mediaType,
    digest: sha256Digest(bytes),
    byteSize: bytes.byteLength,
    executable: op.executable,
  };
}

/** The `DesignFragmentSpecV1` a draft resolves to (for adapter composability + persistence). */
function specFromDraft(draft: DesignFragmentDraftV1): DesignFragmentSpecV1 {
  return parseDesignFragmentSpec({
    kind: draft.kind,
    label: draft.label,
    phase: draft.phase,
    version: draft.version,
    digest: null,
    targetCapabilities: [...draft.targetCapabilities],
    requires: [...draft.requires],
    provides: [...draft.provides],
    dependsOn: [...draft.dependsOn],
    conflicts: [...draft.conflicts],
    replaces: [...draft.replaces],
    personaRefs: [...draft.personaRefs],
    behaviorRefs: [...draft.behaviorRefs],
    conformanceSuiteId: draft.conformanceSuiteId,
  });
}

function reject(rejection: string): AuthoringValidationVerdict<ValidatedDesignFragment> {
  return { kind: "rejected", rejection };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
