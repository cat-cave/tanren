// P1c: the brownfield-recon prompt builder.
//
// Renders the prompt handed to a provider Answerer to read a repo index (the
// files the `RepoReader` indexed READ-ONLY) and infer the project's chapters —
// identity, personas, behaviors, architecture, risks, gaps. The grounding read
// (the index) feeds the model as context; the model produces the `ReconReport`.
// Asks for exactly one report; the strict output schema enforces the rest.

import type { ReconIndex } from "./types.js";

const PREVIEW_MAX = 1200;

export function buildReconPrompt(index: ReconIndex): string {
  const files = index.files
    .map((file) => `### ${file.path} (${file.size} bytes)\n${file.preview.slice(0, PREVIEW_MAX)}`)
    .join("\n\n");
  return [
    "You are Forge, running a READ-ONLY reconnaissance of an existing (brownfield)",
    "repository to reconstruct its product chapters before tanren onboards it.",
    `Repository: ${index.repoUrl} (${index.filesIndexed} files indexed)`,
    "",
    "Indexed files (path + preview):",
    files === "" ? "(no files indexed)" : files,
    "",
    "Return exactly one ReconReport: infer `identity` (slug + purpose, with",
    "`inferredFrom` naming the evidence), `personas`, `behaviors`, `architecture`,",
    "`risks`, and `gaps` (what's missing / under-tested). Ground every chapter in",
    "the files above — this is reconstruction from evidence, not invention.",
  ].join("\n");
}
