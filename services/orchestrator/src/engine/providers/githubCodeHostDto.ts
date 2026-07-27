// Strict read DTOs for GitHubCodeHost. A successful HTTP status is not a domain
// value: every field consumed by the code-host mapper is decoded first.

type GithubObject = Readonly<Record<string, unknown>>;

function object(value: unknown, label: string): GithubObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`GitHub ${label} response was not an object`);
  }
  return value as GithubObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`GitHub ${label} response was missing a non-empty string`);
  }
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`GitHub ${label} response was missing an array`);
  return value;
}

export function decodeDefaultBranch(value: unknown): string {
  return string(object(value, "repository")["default_branch"], "repository default_branch");
}

export function decodeRefSha(value: unknown, expectedRef: string): string {
  const ref = object(value, "ref");
  if (string(ref["ref"], "ref") !== expectedRef) {
    throw new TypeError("GitHub ref response did not bind to the requested ref");
  }
  return string(object(ref["object"], "ref object")["sha"], "ref object sha");
}

export interface DecodedCommit {
  readonly sha: string;
  readonly message: string;
  readonly treeSha: string;
  readonly parents: readonly string[];
}

export function decodeCommit(value: unknown, expectedSha: string): DecodedCommit {
  const commit = object(value, "commit");
  const sha = string(commit["sha"], "commit sha");
  if (sha !== expectedSha) throw new TypeError("GitHub commit response did not bind to the requested sha");
  return {
    sha,
    message: string(commit["message"], "commit message"),
    treeSha: string(object(commit["tree"], "commit tree")["sha"], "commit tree sha"),
    parents: array(commit["parents"], "commit parents").map((parent) =>
      string(object(parent, "commit parent")["sha"], "commit parent sha"),
    ),
  };
}

export interface DecodedCompare {
  readonly status: string;
  readonly commits: readonly { readonly authorLogin: string; readonly committerLogin: string }[];
}

interface DecodedComparePage extends DecodedCompare {
  readonly totalCommits: number;
}

/**
 * GitHub represents a deleted or otherwise unavailable commit identity as
 * `null`, while a missing or malformed identity is not a usable compare DTO.
 * Preserve the former as the code-host contract's existing empty-login marker.
 */
function compareLogin(value: unknown, label: string): string {
  if (value === null) return "";
  return string(object(value, label)["login"], `${label} login`);
}

export function decodeCompare(value: unknown): DecodedCompare {
  const decoded = decodeComparePage(value, true);
  return { status: decoded.status, commits: decoded.commits };
}

/** Status-only compare read: GitHub may paginate commits, but status is complete. */
export function decodeCompareStatus(value: unknown): string {
  return string(object(value, "compare")["status"], "compare status");
}

/** Decode a compare page, optionally requiring all commits to be present. */
export function decodeComparePage(value: unknown, requireComplete = true): DecodedComparePage {
  const compare = object(value, "compare");
  const commits = array(compare["commits"], "compare commits");
  const totalCommits = compare["total_commits"];
  if (!Number.isSafeInteger(totalCommits) || (totalCommits as number) < commits.length) {
    throw new TypeError("GitHub compare response had incomplete total_commits");
  }
  if (requireComplete && totalCommits !== commits.length) {
    throw new TypeError("GitHub compare response had incomplete total_commits");
  }
  return {
    status: string(compare["status"], "compare status"),
    totalCommits: totalCommits as number,
    commits: commits.map((entry) => {
      const commit = object(entry, "compare commit");
      return {
        authorLogin: compareLogin(commit["author"], "compare author"),
        committerLogin: compareLogin(commit["committer"], "compare committer"),
      };
    }),
  };
}

export interface DecodedCompareFile {
  readonly filename: string;
  /** Omitted by GitHub for binary, renamed, or oversized files. */
  readonly patch: string | undefined;
}

export function decodeCompareFiles(value: unknown): readonly DecodedCompareFile[] {
  const files = array(object(value, "compare")["files"], "compare files");
  return files.map((entry) => {
    const file = object(entry, "compare file");
    const patch = file["patch"];
    if (patch !== undefined && typeof patch !== "string") {
      throw new TypeError("GitHub compare patch response was not a string");
    }
    return { filename: string(file["filename"], "compare filename"), patch };
  });
}

function validBase64(value: string): boolean {
  const compact = value.replaceAll("\n", "");
  return compact.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact);
}

export function decodeBase64Content(value: unknown): string {
  const content = object(value, "contents");
  if (string(content["encoding"], "contents encoding") !== "base64") {
    throw new TypeError("GitHub contents response had unsupported encoding");
  }
  const encoded = content["content"];
  if (typeof encoded !== "string" || !validBase64(encoded)) {
    throw new TypeError("GitHub contents response had malformed base64 content");
  }
  return encoded;
}
