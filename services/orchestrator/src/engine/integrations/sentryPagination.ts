import { parseLinkHeader, type ParsedLinkValue } from "./linkHeader.js";
import { sameQueryMultiset } from "./pageScope.js";
export interface SentryNextPageInput {
  link: string | undefined;
  baseUrl: string;
  resourcePath: string;
  initialCursor: string | undefined;
  currentCursor: string | undefined;
  seenCursors: ReadonlySet<string>;
}
function malformed(detail: string): never {
  throw new SentryPaginationError(`malformed Sentry Link header: ${detail}`);
}
export class SentryPaginationError extends Error {}
function targetUrl(baseUrl: string, resourcePath: string, target: string): URL {
  const configured = new URL(`${baseUrl.replace(/\/$/u, "")}${resourcePath}`);
  let next: URL;
  try {
    next = new URL(target, configured);
  } catch {
    return malformed("invalid page URL");
  }
  if (next.origin !== configured.origin) malformed("page is outside the selected provider origin");
  if (next.pathname !== configured.pathname || next.hash !== "")
    malformed("page changed the configured issues resource");
  if (!sameQueryMultiset(configured, next, "cursor")) malformed("page changed the configured query multiset");
  return next;
}
function validatedRelation(
  input: SentryNextPageInput,
  link: ParsedLinkValue,
  relation: "previous" | "next",
): { results: boolean; url: URL; cursor: string } {
  if (
    link.parameters.size !== 3 ||
    [...link.parameters.keys()].some((name) => name !== "rel" && name !== "results" && name !== "cursor")
  )
    malformed(`${relation} relation must contain exactly rel, results, and cursor once`);
  const results = link.parameters.get("results")?.toLowerCase();
  if (results !== "true" && results !== "false") malformed(`${relation} relation has no boolean results parameter`);
  const url = targetUrl(input.baseUrl, input.resourcePath, link.target);
  const cursors = url.searchParams.getAll("cursor");
  if (cursors.length !== 1 || cursors[0] === "") malformed(`${relation} relation has no exact cursor`);
  const cursor = cursors[0]!;
  if (link.parameters.get("cursor") !== cursor) malformed("cursor parameter disagrees with target");
  return { results: results === "true", url, cursor };
}
export function sentryNextPage(
  input: SentryNextPageInput,
): { path: string; cursor: string; initialCursor: string } | undefined {
  if (input.link === undefined || input.link.trim() === "") malformed("missing pagination proof");
  let values: ParsedLinkValue[];
  try {
    values = parseLinkHeader(input.link);
  } catch (error) {
    return malformed(error instanceof Error ? error.message : "invalid link syntax");
  }
  const relation = (name: string) =>
    values.filter((value) => value.parameters.get("rel")?.trim().toLowerCase() === name);
  const previous = relation("previous");
  const following = relation("next");
  if (previous.length !== 1 || following.length !== 1 || values.length !== 2)
    malformed("expected exactly one previous and one next relation");
  const prior = validatedRelation(input, previous[0]!, "previous");
  const next = validatedRelation(input, following[0]!, "next");
  const initialCursor = input.initialCursor ?? prior.cursor;
  if (input.currentCursor !== undefined && prior.cursor !== input.initialCursor)
    malformed("previous cursor did not match the initial page");
  if (!next.results) return undefined;
  if (next.cursor === prior.cursor || next.cursor === input.currentCursor || input.seenCursors.has(next.cursor))
    malformed("next cursor did not make progress");
  const requestPath = new URL(input.resourcePath, "https://sentry.invalid").pathname;
  return { path: `${requestPath}${next.url.search}`, cursor: next.cursor, initialCursor };
}
