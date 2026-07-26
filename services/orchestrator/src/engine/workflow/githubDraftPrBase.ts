import type { AncestorStack } from "../dag/ancestorStack.js";

const CommitSha = /^[0-9a-f]{40}$/u;

/** Resolve the immediate ancestor branch for a stacked draft PR. */
export function resolveDraftPrBaseBranch(fallbackBase: string, ancestorStack: AncestorStack | undefined): string {
  if (ancestorStack === undefined || ancestorStack.length === 0) return fallbackBase;
  const immediateAncestor = ancestorStack.at(-1);
  return immediateAncestor !== undefined && immediateAncestor.branch !== "" ? immediateAncestor.branch : fallbackBase;
}

/** Every durable branch effect must name the exact immutable commit it publishes. */
export function requireDraftPrPublishedHead(input: {
  branch: string;
  sourceRef?: string;
  publishedHeadSha?: string;
}): string {
  if (input.sourceRef === undefined || input.publishedHeadSha === undefined) {
    throw new Error(`GitHub draft branch immutable source/head witness is required for ${input.branch}`);
  }
  if (!CommitSha.test(input.sourceRef) || !CommitSha.test(input.publishedHeadSha)) {
    throw new Error(`GitHub draft branch published head is invalid for ${input.branch}`);
  }
  if (input.sourceRef !== input.publishedHeadSha) {
    throw new Error(`GitHub draft branch source ref must equal its published head for ${input.branch}`);
  }
  return input.publishedHeadSha;
}
