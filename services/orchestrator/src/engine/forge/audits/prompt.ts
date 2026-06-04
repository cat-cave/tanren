// The scheduled-audit prompt builder.
//
// Renders the prompt handed to a read-only audit Answerer to inspect the indexed
// repo (the files the `RepoReader` indexed READ-ONLY) and surface the kinds of
// issues the owner wants found on a cadence: real bugs, weak spots, missing
// tests, slow/fragile areas. Each issue must be CONCRETE enough to become a unit
// of work — the scheduler routes every finding into the DAG as a spec. The job's
// `kind` focuses the lens (security / deps / a11y / mutation / perf / license /
// stale_specs). The strict output schema enforces the rest.

import type { AuditAnswererContext } from "./types.js";

const PREVIEW_MAX = 1200;

// Per-kind focusing line so a job's kind narrows what the audit hunts for. Each
// is a concrete lens, not a vibe — the model still surfaces only real, fixable
// issues grounded in the indexed evidence.
const KIND_LENS: Record<string, string> = {
  security: "injection, secret leakage, missing authz checks, unsafe deserialization, SSRF.",
  deps: "outdated/abandoned/vulnerable dependencies and risky version pins.",
  a11y: "missing labels/roles, contrast issues, keyboard traps, non-semantic markup.",
  mutation: "weak or missing tests — logic paths no test would catch if mutated.",
  perf: "N+1 queries, unbounded loops, blocking I/O on hot paths, missing indexes.",
  license: "dependencies whose license class is incompatible or unaudited.",
  stale_specs: "code that has drifted from its spec/docs, dead code, abandoned TODOs.",
};

export function buildAuditPrompt(context: AuditAnswererContext): string {
  const { job, index } = context;
  const files = index.files
    .map((file) => `### ${file.path} (${file.size} bytes)\n${file.preview.slice(0, PREVIEW_MAX)}`)
    .join("\n\n");
  const lens = KIND_LENS[job.kind] ?? "bugs, weak spots, missing tests, and slow/fragile areas.";
  return [
    `You are Forge, running a READ-ONLY '${job.kind}' AUDIT of an existing repository`,
    "on a recurring cadence. Find the real, fixable issues the owner would want",
    "surfaced — do not invent problems and do not rubber-stamp a clean pass when",
    "evidence shows real issues.",
    `Repository: ${index.repoUrl} (${index.filesIndexed} files indexed)`,
    `Audit focus (kind = ${job.kind}): ${lens}`,
    "",
    "Indexed files (path + preview):",
    files === "" ? "(no files indexed)" : files,
    "",
    "Return an AuditPassReport. For EACH genuine issue, emit one finding with:",
    "- `externalId`: a STABLE slug for the issue (e.g. `n-plus-1-listUsers`). Pick",
    "  it deterministically from the issue itself so a re-run of this audit reuses",
    "  the same id (the scheduler keys idempotency on it — never invent a new id",
    "  for the same underlying issue).",
    "- `title`: a short, specific description of the issue.",
    "- `body`: enough context to become a unit of work — what the issue is, WHERE",
    "  it lives (file/symbol), WHY it matters, and what fixing it would entail.",
    "- `severity`: `info` | `warn` | `fail` by impact.",
    "",
    "If the indexed evidence shows NO real issue of this kind, return an empty",
    "`findings` array — a clean pass is the honest answer, not a fabricated finding.",
  ].join("\n");
}
