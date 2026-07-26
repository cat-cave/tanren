import type { AncestorStack } from "../dag/ancestorStack.js";

/** Resolve the immediate ancestor branch for a stacked draft PR. */
export function resolveDraftPrBaseBranch(fallbackBase: string, ancestorStack: AncestorStack | undefined): string {
  if (ancestorStack === undefined || ancestorStack.length === 0) return fallbackBase;
  const immediateAncestor = ancestorStack.at(-1);
  return immediateAncestor !== undefined && immediateAncestor.branch !== "" ? immediateAncestor.branch : fallbackBase;
}
