import {
  publishDraftPullRequest,
  type PublishedDraftPullRequest,
  type PublishDraftPullRequestInput,
} from "./githubDraftPr.js";
import { readDurableDraftPrPublishedHead } from "./githubDraftPrLease.js";

export type { PublishedDraftPullRequest } from "./githubDraftPr.js";

/**
 * Publish against the immutable prior head for the stable spec-derived branch.
 * The downstream publisher performs the immediate exact remote-ref read and
 * force-with-lease CAS; this lookup supplies the durable predecessor it must
 * equal, never process-local rework state.
 */
export async function publishDraftPullRequestWithDurableLease(
  input: PublishDraftPullRequestInput,
  durable: { orgId: string; specId: string; branch: string },
): Promise<PublishedDraftPullRequest> {
  const expectedPublishedHeadSha = await readDurableDraftPrPublishedHead(input.pool, durable);
  return await publishDraftPullRequest({
    ...input,
    ...(expectedPublishedHeadSha !== undefined && { expectedPublishedHeadSha }),
  });
}
