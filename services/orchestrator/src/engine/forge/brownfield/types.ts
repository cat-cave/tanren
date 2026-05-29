// P3-0016 brownfield onboarding (full track): typed contracts for the
// read-only recon step.
//
// The brownfield "full track" goes beyond the minimal repo-link (P2B-0002):
//   1. read-only RECON — a read-only Answerer indexes the linked repo and
//      pre-fills the onboarding chapters (identity / personas / behaviors /
//      architecture / risks) plus the gap questions the operator must answer.
//   2. config-injection PR — propose 6 integration files, let the operator
//      exclude any, then open ONE PR in the target repo (no runs until merge).
//   3. DAG seed — turn recon gaps + GitHub issues into seed specs.
//   4. governance picker — wire the P3-0023 posture modes into onboarding.
//
// The recon Answerer is INJECTABLE/MOCKABLE — the same seam shape as the
// P3-0010 conversation + P3-0015 interview answerers: production wraps a
// provider read-only Answerer, tests inject a fake, and a deterministic
// fallback keeps the step live without provider infra. NOTHING here is
// persisted as a new entity-shape: the recon report is transient (carried on
// the request, like the greenfield capture) so there is NO migration.

import { z } from "zod";

// ── Repo index (what the read-only Answerer reads) ─────────────────────────

// A single indexed file the recon pass observed (path + size + a short head
// snippet for the Answerer to reason over). Read-only — recon never writes.
export const ReconIndexedFile = z
  .object({
    path: z.string().min(1).max(400),
    size: z.number().int().min(0).default(0),
    /** Decoded UTF-8 preview, truncated for prompt economy. */
    preview: z.string().max(8000).default("")
  })
  .strict();
export type ReconIndexedFile = z.infer<typeof ReconIndexedFile>;

// The repo index handed to the Answerer: the files it read + summary counts.
export const ReconIndex = z
  .object({
    repoUrl: z.string().min(1).max(400),
    filesIndexed: z.number().int().min(0).default(0),
    files: z.array(ReconIndexedFile).default([])
  })
  .strict();
export type ReconIndex = z.infer<typeof ReconIndex>;

// ── Recon chapters (the "what the agent extracted" panel) ──────────────────

export const ReconPersona = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(280),
    inferredFrom: z.string().max(200).default("")
  })
  .strict();
export type ReconPersona = z.infer<typeof ReconPersona>;

export const ReconBehavior = z
  .object({
    persona: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    inferredFrom: z.string().max(200).default("")
  })
  .strict();
export type ReconBehavior = z.infer<typeof ReconBehavior>;

export const ReconArchitectureLine = z
  .object({
    layer: z.string().min(1).max(40),
    detail: z.string().min(1).max(200)
  })
  .strict();
export type ReconArchitectureLine = z.infer<typeof ReconArchitectureLine>;

// A flagged risk. `severity` mirrors the inbox/notification levels so the UI
// can render it with the shared status glyphs.
export const ReconRisk = z
  .object({
    severity: z.enum(["info", "warn", "fail"]).default("warn"),
    note: z.string().min(1).max(280)
  })
  .strict();
export type ReconRisk = z.infer<typeof ReconRisk>;

// A gap the Answerer could not decide on its own — surfaced as a question the
// operator answers (the hi-fi "3 things I couldn't decide" cards). It also
// feeds the DAG-seed step (each unresolved gap can become a seed spec).
export const ReconGap = z
  .object({
    id: z.string().min(1).max(80),
    chapter: z.string().min(1).max(80),
    question: z.string().min(1).max(400),
    options: z.array(z.string().min(1).max(80)).max(4).default([])
  })
  .strict();
export type ReconGap = z.infer<typeof ReconGap>;

// The full recon report the Answerer returns for a linked repo.
export const ReconReport = z
  .object({
    identity: z
      .object({
        slug: z.string().min(1).max(80),
        purpose: z.string().min(1).max(280),
        inferredFrom: z.string().max(200).default("")
      })
      .strict(),
    personas: z.array(ReconPersona).default([]),
    behaviors: z.array(ReconBehavior).default([]),
    architecture: z.array(ReconArchitectureLine).default([]),
    risks: z.array(ReconRisk).default([]),
    gaps: z.array(ReconGap).default([])
  })
  .strict();
export type ReconReport = z.infer<typeof ReconReport>;

// ── The injectable recon Answerer + repo reader seams ──────────────────────

// The read-only Answerer: given the repo index, infer the chapters + gaps.
// Mirrors the P3-0010/0015 answerer shape so it slots into the same seam.
export interface ReconAnswerer {
  read(index: ReconIndex): Promise<ReconReport>;
}

// Injectable repo reader — production resolves an App token + reads the repo
// over the `GitHubHttpClient`; tests inject a fake index. Kept as a port so the
// recon engine never reaches into the provider HTTP surface directly.
export interface RepoReader {
  index(repoUrl: string): Promise<ReconIndex>;
}
