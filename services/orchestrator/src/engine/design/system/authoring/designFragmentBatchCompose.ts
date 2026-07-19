// ds-3 (F2D) — the POST-AUTHORING WHOLE-BATCH COMPOSE gate.
//
// The design analog of `batchComposeAfterAuthoring.ts`. Per-fragment validation
// runs each draft on a FRESH `DesignVfs`, so it cannot see a collision BETWEEN two
// authored fragments (or between an authored fragment and the org's existing
// registry). This gate composes the ENTIRE augmented set — the org's present
// fragment files plus every newly-authored fragment — onto ONE `DesignVfs` (which
// fails loud on a case-insensitive path collision) and re-checks adapter
// composability over the union. A rejection here drives the kernel's
// RETRACT-WITH-DELETE: every persisted row is removed before the terminal `failed`.
//
// A `loadPresentFiles` throw returns `skipped` (the augmented set could not be
// confirmed) — the kernel treats skipped as a hard failure (no silent commit).

import { DesignVfs } from "../designVfs.js";
import type { DesignArtifactFileV1, DesignFragmentSpecV1 } from "../designArtifactSchemas.js";
import type { DesignTargetAdapter } from "../designTargetAdapter.js";
import type { AuthoringBatchCompose, AuthoringBatchComposeVerdict } from "../../../contracts/authoringKernel.js";
import { parseDesignFragmentAuthoringContext } from "./designFragmentContext.js";
import type { ValidatedDesignFragment } from "./designFragmentDraft.js";

export interface DesignFragmentBatchComposeDeps {
  /** The target adapter the union of authored capabilities is re-checked against. */
  readonly adapter: DesignTargetAdapter;
  /** Load the org's PRESENT (already-registered) fragment file descriptors so a new
   * fragment colliding with an existing one is caught. Default: none present. */
  readonly loadPresentFiles?: (orgId: string) => Promise<readonly DesignArtifactFileV1[]>;
}

export function buildDesignFragmentBatchCompose(
  deps: DesignFragmentBatchComposeDeps,
): AuthoringBatchCompose<DesignFragmentSpecV1, ValidatedDesignFragment> {
  return {
    async compose(input): Promise<AuthoringBatchComposeVerdict> {
      const context = parseDesignFragmentAuthoringContext(input.request.context);

      // Load the present registry (skipped-on-throw — cannot confirm the set).
      let presentFiles: readonly DesignArtifactFileV1[] = [];
      if (deps.loadPresentFiles !== undefined) {
        try {
          presentFiles = await deps.loadPresentFiles(context.orgId);
        } catch (err) {
          return { kind: "skipped", reason: `present_registry_unavailable: ${message(err)}` };
        }
      }

      const authoredFiles = input.authored.flatMap((entry) => entry.validated.files.map((file) => ({ ...file })));

      // ONE VFS over the whole augmented set — a case-insensitive path collision
      // between any two fragments (new↔new or new↔present) fails loud here.
      const expectedFileCount = presentFiles.length + authoredFiles.length;
      let composed: DesignVfs;
      try {
        composed = new DesignVfs([...presentFiles, ...authoredFiles]);
      } catch (err) {
        return { kind: "failed", reason: `augmented_set_collision: ${message(err)}` };
      }
      // Defense: no file may vanish silently — a drop means an undetected clash.
      if (composed.files.length !== expectedFileCount) {
        return {
          kind: "failed",
          reason: `augmented_set_file_dropped: composed ${composed.files.length} of ${expectedFileCount}`,
        };
      }

      // Re-check adapter composability over the union of authored capabilities
      // AGAINST THE COMPOSED VFS (the present + authored file bodies already
      // assembled above) — NOT a fresh empty VFS. Materializing onto `composed`
      // means the capability re-check actually sees the authored content (a union
      // incompatibility the per-fragment pass could not — e.g. a capability another
      // fragment `conflicts` with, or a merge conflict on the real file set).
      const specs = input.authored.map((entry) => entry.validated.spec);
      try {
        await deps.adapter.materialize(specs, composed);
      } catch (err) {
        return { kind: "failed", reason: `augmented_set_not_composable: ${message(err)}` };
      }

      return { kind: "passed" };
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
