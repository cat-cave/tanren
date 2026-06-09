// Brownfield workflow-INTENT classifier.
//
// Brownfield onboarding must migrate the *intent* of a repo's existing
// automation, not its YAML. A repo arrives with GitHub Actions workflows,
// package scripts, Dockerfiles, branch-protection / required-checks, CODEOWNERS,
// and deploy scripts. Re-running that YAML verbatim under Tanren would just
// re-implement GitHub Actions; the point is the opposite — read what each piece
// of automation is *for* (the intent), classify it, and emit the native Tanren
// replacement (a gate / plan / scheduled-operation / external integration), then
// hand the operator a migration-risk report so nothing security/compliance/
// production-shaped is silently dropped.
//
// This module is the CLASSIFIER: PURE functions over the already-fetched recon
// `ReconIndex` (the read surface owned by `recon.ts` + `githubRepoReader.ts`).
// It performs NO ingestion and NO network I/O — it only reasons over the indexed
// file paths + decoded previews. That keeps it unit-testable without a provider
// or GitHub. The shared vocabulary (categories / replacements / severities /
// keyword rules) lives in `workflowIntentTaxonomy.ts`; the report-builder
// (`migrationReport.ts`) consumes the `WorkflowIntent[]` this produces.

import { z } from "zod";
import type { ReconIndex, ReconIndexedFile } from "./types.js";
import {
  WorkflowIntent,
  classifyText,
  replacementFor,
  severityFor,
  type WorkflowIntentSource,
} from "./workflowIntentTaxonomy.js";

export {
  WorkflowIntent,
  WorkflowIntentCategory,
  WorkflowIntentSource,
  NativeReplacementKind,
  DispositionSeverity,
  replacementFor,
  severityFor,
} from "./workflowIntentTaxonomy.js";

function intentFrom(
  source: WorkflowIntentSource,
  sourcePath: string,
  name: string,
  haystack: string,
  evidencePrefix: string,
): WorkflowIntent {
  const hit = classifyText(haystack);
  return WorkflowIntent.parse({
    id: `${source}:${sourcePath}:${slug(name)}`,
    source,
    sourcePath,
    name: name.slice(0, 200),
    category: hit.category,
    replacement: replacementFor(hit.category),
    severity: severityFor(hit.category),
    confidence: hit.confidence,
    evidence: `${evidencePrefix} matched "${hit.token}"`.slice(0, 400),
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/(^-|-$)/gu, "")
    .slice(0, 60);
}

// ── File-shape predicates over the recon index ─────────────────────────────

function isWorkflowFile(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes(".github/workflows/") && (lower.endsWith(".yml") || lower.endsWith(".yaml"));
}

function isPackageJson(path: string): boolean {
  return path.toLowerCase().endsWith("package.json");
}

function isDockerfile(path: string): boolean {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  return base === "dockerfile" || base.startsWith("dockerfile.");
}

function isCodeowners(path: string): boolean {
  return path.toLowerCase().endsWith("codeowners");
}

function isDeployScript(path: string): boolean {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  return /^deploy.*\.(sh|ts|js|mjs|py)$/u.test(base) || base === "fly.toml" || base === "vercel.json";
}

// ── Per-source extractors ──────────────────────────────────────────────────

// A workflow file: extract each cron schedule, manual-approval `environment`
// gate, and every `run:`/`uses:` line as a candidate intent. We do NOT parse
// YAML into an AST (a brittle dependency for prompt-economy previews) — we read
// the high-signal lines. Order matters: scheduled + approval are structural and
// take precedence over a line-level classification.
function extractFromWorkflow(file: ReconIndexedFile): WorkflowIntent[] {
  const out: WorkflowIntent[] = [];
  const preview = file.preview;
  const lower = preview.toLowerCase();

  if (lower.includes("schedule:") && lower.includes("cron")) {
    const cron = /cron:\s*["']?([^"'\n]+)["']?/iu.exec(preview)?.[1]?.trim() ?? "cron";
    out.push(
      WorkflowIntent.parse({
        id: `workflow:${file.path}:schedule`,
        source: "workflow",
        sourcePath: file.path,
        name: `scheduled trigger (${cron})`,
        category: "scheduled",
        replacement: replacementFor("scheduled"),
        severity: severityFor("scheduled"),
        confidence: 0.85,
        evidence: `${file.path} on.schedule.cron "${cron}"`.slice(0, 400),
      }),
    );
  }

  // GitHub `environment:` (with required reviewers) is the strongest portable
  // signal for a manual-approval gate in the preview.
  if (/^\s*environment\s*:/imu.test(preview) || lower.includes("required reviewers")) {
    out.push(
      WorkflowIntent.parse({
        id: `workflow:${file.path}:approval`,
        source: "workflow",
        sourcePath: file.path,
        name: "protected environment (manual approval)",
        category: "manual_approval",
        replacement: replacementFor("manual_approval"),
        severity: severityFor("manual_approval"),
        confidence: 0.7,
        evidence: `${file.path} job environment gate`.slice(0, 400),
      }),
    );
  }

  // `uses:` external marketplace actions → classify the action ref; anything we
  // can't bucket becomes an unsupported_automation.
  for (const m of preview.matchAll(/uses:\s*([^\s#]+)/giu)) {
    const ref = m[1]?.trim();
    if (ref === undefined || ref === "" || ref.startsWith("./") || ref.startsWith("actions/checkout")) continue;
    out.push(intentFrom("workflow", file.path, `uses ${ref}`, ref, `${file.path} uses: ${ref}`));
  }

  // `run:` step shell lines → classify the command.
  for (const m of preview.matchAll(/run:\s*([^\n]+)/giu)) {
    const cmd = m[1]?.trim();
    if (cmd === undefined || cmd === "") continue;
    out.push(intentFrom("workflow", file.path, `run ${cmd}`, cmd, `${file.path} run: ${cmd}`));
  }

  return out;
}

// package.json "scripts": each script value is a candidate intent.
function extractFromPackageJson(file: ReconIndexedFile): WorkflowIntent[] {
  const out: WorkflowIntent[] = [];
  // An EMPTY preview is the benign "nothing indexed" state (the `preview` default) —
  // there is no package.json content to read, so no intents. NOT a corruption.
  if (file.preview === "") return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.preview);
  } catch (error) {
    // no_silent_fallbacks: a present-but-unparseable package.json is NOT a benign
    // skip. Silently returning `[]` would DROP the repo's package-script automation
    // intent from the migration-risk report — exactly the "nothing is silently
    // dropped" guarantee this classifier exists to uphold. Log LOUD and PROPAGATE so
    // the unreadable package.json surfaces (the fix is a larger preview, never a
    // silent drop).
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[brownfield] unparseable package.json at ${file.path}; cannot classify its scripts: ${reason}`);
    throw new Error(`unparseable package.json at ${file.path}: ${reason}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) return out;
  const scripts = (parsed as Record<string, unknown>)["scripts"];
  if (typeof scripts !== "object" || scripts === null) return out;
  for (const [scriptName, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== "string" || command === "") continue;
    out.push(
      intentFrom(
        "package_script",
        file.path,
        scriptName,
        `${scriptName} ${command}`,
        `${file.path} scripts.${scriptName}`,
      ),
    );
  }
  return out;
}

// Dockerfile → a build intent (the image build), surfaced so it isn't silently
// dropped on the cutover off Actions.
function extractFromDockerfile(file: ReconIndexedFile): WorkflowIntent[] {
  return [
    WorkflowIntent.parse({
      id: `dockerfile:${file.path}:build`,
      source: "dockerfile",
      sourcePath: file.path,
      name: "container image build",
      category: "build",
      replacement: replacementFor("build"),
      severity: severityFor("build"),
      confidence: 0.7,
      evidence: `${file.path} container build`.slice(0, 400),
    }),
  ];
}

// CODEOWNERS → a compliance review gate (owners must approve). Non-empty owner
// lines are the signal.
function extractFromCodeowners(file: ReconIndexedFile): WorkflowIntent[] {
  const hasOwners = file.preview
    .split("\n")
    .some((line) => line.trim() !== "" && !line.trim().startsWith("#") && line.includes("@"));
  if (!hasOwners) return [];
  return [
    WorkflowIntent.parse({
      id: `codeowners:${file.path}:review`,
      source: "codeowners",
      sourcePath: file.path,
      name: "code owner review requirement",
      category: "manual_approval",
      replacement: replacementFor("manual_approval"),
      severity: severityFor("manual_approval"),
      confidence: 0.8,
      evidence: `${file.path} owner-mapped review gate`.slice(0, 400),
    }),
  ];
}

// A deploy script (deploy.sh, fly.toml, vercel.json, …) → classify its body; an
// unrecognized deploy script still classifies via its filename as a deploy.
function extractFromDeployScript(file: ReconIndexedFile): WorkflowIntent[] {
  const haystack = `${file.path} ${file.preview}`;
  return [
    intentFrom(
      "deploy_script",
      file.path,
      file.path.split("/").pop() ?? file.path,
      haystack,
      `${file.path} deploy script`,
    ),
  ];
}

// ── Branch protection (separate signal, not a file in the tree) ────────────

// Branch protection / required checks arrive as structured data (not a repo
// file), so the classifier accepts them explicitly. Each required status check
// is an intent whose category is inferred from the check name; the
// "require N approvals" rule is a compliance manual-approval intent.
export const BranchProtectionInput = z
  .object({
    branch: z.string().min(1).max(200).default("main"),
    requiredStatusChecks: z.array(z.string().min(1).max(200)).default([]),
    requiredApprovingReviewCount: z.number().int().min(0).default(0),
    requireCodeOwnerReviews: z.boolean().default(false),
    enforceAdmins: z.boolean().default(false),
  })
  .strict();
export type BranchProtectionInput = z.infer<typeof BranchProtectionInput>;

function extractFromBranchProtection(bp: BranchProtectionInput): WorkflowIntent[] {
  const out: WorkflowIntent[] = [];
  for (const check of bp.requiredStatusChecks) {
    out.push(
      intentFrom(
        "branch_protection",
        `branch:${bp.branch}`,
        `required check ${check}`,
        check,
        `${bp.branch} required status check "${check}"`,
      ),
    );
  }
  if (bp.requiredApprovingReviewCount > 0 || bp.requireCodeOwnerReviews) {
    out.push(
      WorkflowIntent.parse({
        id: `branch_protection:${bp.branch}:approvals`,
        source: "branch_protection",
        sourcePath: `branch:${bp.branch}`,
        name: `require ${bp.requiredApprovingReviewCount} approval(s)${bp.requireCodeOwnerReviews ? " + code owners" : ""}`,
        category: "manual_approval",
        replacement: replacementFor("manual_approval"),
        severity: severityFor("manual_approval"),
        confidence: 0.85,
        evidence: `${bp.branch} required approvals=${bp.requiredApprovingReviewCount}`.slice(0, 400),
      }),
    );
  }
  return out;
}

// ── Public entry point ─────────────────────────────────────────────────────

export interface ClassifyWorkflowIntentInput {
  index: ReconIndex;
  // Branch protection arrives separately (it is not a tree file). Optional —
  // absent ⇒ no protection intents (and the report-builder treats a repo with
  // production deploys but no protection as a risk, not a silent pass).
  branchProtection?: BranchProtectionInput[];
}

/**
 * Classify every discovered automation in the recon index (plus any supplied
 * branch-protection rules) into typed `WorkflowIntent` records. PURE: no I/O.
 * De-dupes by intent id (the same logical check can appear in multiple places).
 */
export function classifyWorkflowIntents(input: ClassifyWorkflowIntentInput): WorkflowIntent[] {
  const collected: WorkflowIntent[] = [];
  for (const file of input.index.files) {
    if (isWorkflowFile(file.path)) collected.push(...extractFromWorkflow(file));
    else if (isPackageJson(file.path)) collected.push(...extractFromPackageJson(file));
    else if (isDockerfile(file.path)) collected.push(...extractFromDockerfile(file));
    else if (isCodeowners(file.path)) collected.push(...extractFromCodeowners(file));
    else if (isDeployScript(file.path)) collected.push(...extractFromDeployScript(file));
  }
  for (const bp of input.branchProtection ?? []) {
    collected.push(...extractFromBranchProtection(bp));
  }
  const seen = new Set<string>();
  const deduped: WorkflowIntent[] = [];
  for (const intent of collected) {
    if (seen.has(intent.id)) continue;
    seen.add(intent.id);
    deduped.push(intent);
  }
  return deduped;
}
