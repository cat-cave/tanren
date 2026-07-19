// ds-3 (F2D) — the invocation context the family binding stamps onto every unit.
//
// The generalized kernel treats `AuthoringKernelInput.context` as opaque; the ds-3
// binding parses it (fail-closed) to recover the org scope + optional run/project
// linkage the persistence, validator, and event sink need.

import { z } from "zod";

export const DesignFragmentAuthoringContext = z
  .object({
    orgId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256).optional(),
    projectId: z.string().min(1).max(256).optional(),
    specId: z.string().min(1).max(256).optional(),
    createdBy: z.string().min(1).max(256).default("tanren.f2d"),
  })
  .strict();
export type DesignFragmentAuthoringContext = z.infer<typeof DesignFragmentAuthoringContext>;

/** Thrown when the F2D invocation envelope is missing its org scope. Fail-closed —
 * an unscoped design-fragment authoring run must NEVER persist off-tenant rows. */
export class DesignFragmentAuthoringContextError extends Error {
  constructor(readonly issues: string) {
    super(`design fragment authoring context is invalid: ${issues}`);
    this.name = "DesignFragmentAuthoringContextError";
  }
}

export function parseDesignFragmentAuthoringContext(value: unknown): DesignFragmentAuthoringContext {
  const result = DesignFragmentAuthoringContext.safeParse(value);
  if (!result.success) {
    throw new DesignFragmentAuthoringContextError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; "),
    );
  }
  return result.data;
}
