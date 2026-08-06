import type { EventStore, AppendEventInput } from "../eventStore.js";
import { repoPath, type GitHubHttpClient, type GitHubRepository } from "../providers/github.js";

type PushedEvent = AppendEventInput<"github.branch.pushed">;

/** Append the remote branch witness, reconciling an ambiguous event-store response safely. */
export async function appendPushedWitnessWithReconciliation(input: {
  eventStore: EventStore;
  event: PushedEvent;
  http: GitHubHttpClient;
  repo: GitHubRepository;
  branch: string;
  token: string;
  publishedHeadSha: string;
  idempotencyKey: string;
}): Promise<void> {
  if (input.event.runId === undefined) throw new Error("github.branch.pushed witness requires runId");
  const runId = input.event.runId;
  const append = async () => {
    if (input.eventStore.appendPriorIfAbsent !== undefined) {
      return await input.eventStore.appendPriorIfAbsent({
        ...input.event,
        idempotencyKey: input.idempotencyKey,
        runId,
      });
    }
    await input.eventStore.append(input.event);
    return true;
  };
  try {
    await append();
  } catch (appendError) {
    const ref = await input.http.request({
      method: "GET",
      path: repoPath(input.repo, `/git/ref/heads/${encodeURIComponent(input.branch)}`),
      token: input.token,
    });
    const remoteSha = (ref.body as { object?: { sha?: unknown } } | undefined)?.object?.sha;
    if (ref.status !== 200 || remoteSha !== input.publishedHeadSha) throw appendError;
    if (input.eventStore.appendPriorIfAbsent === undefined) throw appendError;
    await append();
  }
}
