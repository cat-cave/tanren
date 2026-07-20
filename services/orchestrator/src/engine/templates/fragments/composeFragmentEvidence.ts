// Deterministic projection of one selected F2 evidence declaration into the repo.

import { TemplateComposeError } from "./composeError.js";
import {
  FragmentEvidenceContractV1Schema,
  FRAGMENT_EVIDENCE_MANIFEST_PATH,
  serializeFragmentEvidenceManifest,
} from "./fragmentEvidenceContract.js";
import type { Fragment, VirtualFileSystem } from "./types.js";

/**
 * Emit metadata only. The artifact names no command and cannot alter execution:
 * batch selection merely binds it to an existing native pre-merge proof.
 */
export function processFragmentEvidenceContract(vfs: VirtualFileSystem, applied: readonly Fragment[]): void {
  const declaring = applied.filter((fragment) => fragment.contract.evidence !== undefined);
  if (declaring.length === 0) return;
  if (declaring.length !== 1) {
    throw new TemplateComposeError(
      "post_process",
      "processFragmentEvidenceContract: exactly one selected fragment must declare evidence",
    );
  }
  const fragment = declaring[0];
  if (fragment === undefined || fragment.contract.evidence === undefined) {
    throw new TemplateComposeError("post_process", "processFragmentEvidenceContract: evidence declaration disappeared");
  }
  const evidence = FragmentEvidenceContractV1Schema.parse(fragment.contract.evidence);
  if (fragment.contract.reportPath === undefined || fragment.contract.reportPath !== evidence.junitReportPath) {
    throw new TemplateComposeError(
      "post_process",
      "processFragmentEvidenceContract: evidence junitReportPath must exactly match the fragment reportPath",
      fragment.id,
    );
  }
  vfs.overwrite(
    FRAGMENT_EVIDENCE_MANIFEST_PATH,
    serializeFragmentEvidenceManifest({
      schemaVersion: "fragment_evidence_manifest.v1",
      fragment: { id: fragment.id, kind: fragment.kind, version: fragment.version },
      evidence,
    }),
  );
}
