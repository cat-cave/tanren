// pure helpers to derive the distinct author + committer logins from a
// GitHub PR commits response. Extracted from mergeDispatch.ts to keep that file
// under the 500-line architecture cap; the merge stage's contributor probe uses
// these to feed the external-change posture gate.

/** Collect the author + committer logins from a PR commits response body. */
export function parseCommitLogins(body: unknown): string[] {
  if (!Array.isArray(body)) {
    throw new TypeError("GitHub PR commits response was not an array");
  }
  const logins: string[] = [];
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    logins.push(loginFrom(record["author"]), loginFrom(record["committer"]));
  }
  return logins;
}

function loginFrom(user: unknown): string {
  if (typeof user !== "object" || user === null || Array.isArray(user)) {
    return "";
  }
  const login = (user as Record<string, unknown>)["login"];
  return typeof login === "string" ? login : "";
}
