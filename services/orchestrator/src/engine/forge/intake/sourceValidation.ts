import type pg from "pg";
import {
  InboxSourceDecodeError,
  InboxSourceProjectScopeError,
  InboxSourceUnavailableError,
  InboxStore,
} from "../../repositories/inbox.js";
import type { InboxSource } from "../inbox/types.js";

type QueryClient = Pick<pg.Pool | pg.PoolClient, "query">;

export class InboxSourceNotFoundError extends Error {
  constructor() {
    super("inbox source not found in the addressed organization");
    this.name = "InboxSourceNotFoundError";
  }
}

/** Fresh strict config, tenant/project, enabled, and lifecycle validation. */
export async function loadRunnableInboxSource(
  client: QueryClient,
  input: { sourceId: string; orgId: string },
): Promise<InboxSource> {
  const source = await InboxStore.getSourceForIntake(client, input.sourceId, input.orgId);
  if (source === undefined) throw new InboxSourceNotFoundError();
  return source;
}

/** Errors that are safe to return as source-unavailable rather than provider faults. */
export function isInboxSourceBoundaryError(error: unknown): boolean {
  return (
    error instanceof InboxSourceNotFoundError ||
    error instanceof InboxSourceProjectScopeError ||
    error instanceof InboxSourceUnavailableError
  );
}

export { InboxSourceDecodeError };
