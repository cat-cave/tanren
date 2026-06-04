// Brownfield workflow-INTENT taxonomy + keyword signal table.
//
// The typed vocabulary the classifier (`workflowIntent.ts`) and the report
// builder (`migrationReport.ts`) share: the intent categories, the native
// replacement primitives, the disposition severities, the per-category
// replacement/severity mappings, and the ordered keyword rules + `classifyText`.
// Split out of `workflowIntent.ts` purely to keep each file under the 500-line
// cap; nothing here does I/O.

import { z } from "zod";

// ── Intent taxonomy ────────────────────────────────────────────────────────

// What a discovered automation is *for*. Spans the CI gate ladder, the deploy /
// release lanes, supply-chain checks, scheduling, notifications, and the human
// controls (approval / freeze). `unknown` is reserved for evidence we saw but
// could not confidently bucket — it is NOT a silent drop, it surfaces in the
// report as low-confidence.
export const WorkflowIntentCategory = z.enum([
  "lint",
  "format",
  "typecheck",
  "unit_test",
  "integration_test",
  "e2e_test",
  "build",
  "dependency_scan",
  "secret_scan",
  "sast",
  "preview_deploy",
  "staging_deploy",
  "prod_deploy",
  "artifact_publish",
  "release_tag",
  "scheduled",
  "notification",
  "manual_approval",
  "freeze",
  "unknown",
]);
export type WorkflowIntentCategory = z.infer<typeof WorkflowIntentCategory>;

// The native Tanren primitive a category maps onto. These are the replacement
// surfaces the rest of the engine already exposes (gates on the CI ladder, the
// deploy/release plans, scheduled operations, and the external-integration seam
// for things Tanren observes but does not itself run). `unsupported_automation`
// is the honest "we have no native home for this yet" bucket.
export const NativeReplacementKind = z.enum([
  "quick_gate",
  "task_gate",
  "spec_gate",
  "merge_gate",
  "deploy_plan",
  "release_plan",
  "scheduled_operation",
  "external_check",
  "external_integration",
  "manual_gate",
  "unsupported_automation",
]);
export type NativeReplacementKind = z.infer<typeof NativeReplacementKind>;

// Where the intent was discovered. Drives the per-item `owner` and lets the
// report group by surface.
// Sources, in order: a .github/workflows/*.yml job/step; a package.json
// "scripts" entry; a Dockerfile build; branch protection / required checks; a
// CODEOWNERS file; a deploy script (deploy.sh / fly / vercel / etc.).
export const WorkflowIntentSource = z.enum([
  "workflow",
  "package_script",
  "dockerfile",
  "branch_protection",
  "codeowners",
  "deploy_script",
]);
export type WorkflowIntentSource = z.infer<typeof WorkflowIntentSource>;

// Disposition severity — how much it MATTERS if this intent is dropped rather
// than migrated. The report's not-ready rule keys off the top three: a repo is
// not Tanren-native-ready while any security/compliance/production-severity
// intent is merely dropped (never migrated/replaced/handed-off).
// Severity, low → high: harmless (cosmetic / dev-ergonomics); quality
// (lint/test/build gates); security (dependency/secret/SAST scans); compliance
// (manual approval / freeze / CODEOWNERS review gates); production (anything
// that ships — prod deploy, release, publish).
export const DispositionSeverity = z.enum(["harmless", "quality", "security", "compliance", "production"]);
export type DispositionSeverity = z.infer<typeof DispositionSeverity>;

// A single classified intent. `evidence` is the human-readable "why" (the path +
// the matched token) so the report is auditable. `confidence` is 0..1.
export const WorkflowIntent = z
  .object({
    id: z.string().min(1).max(120),
    source: WorkflowIntentSource,
    sourcePath: z.string().min(1).max(400),
    name: z.string().min(1).max(200),
    category: WorkflowIntentCategory,
    replacement: NativeReplacementKind,
    severity: DispositionSeverity,
    confidence: z.number().min(0).max(1),
    evidence: z.string().min(1).max(400),
  })
  .strict();
export type WorkflowIntent = z.infer<typeof WorkflowIntent>;

// ── Category → native-replacement + severity mapping ───────────────────────

// The CI gate ladder: cheap checks land on the quick gate, the heavier
// test/build checks on the spec/merge gates. This is the opinionated mapping —
// there is no per-repo override here (governance posture handles policy, not the
// intent→primitive shape).
const CATEGORY_REPLACEMENT: Record<WorkflowIntentCategory, NativeReplacementKind> = {
  lint: "quick_gate",
  format: "quick_gate",
  typecheck: "quick_gate",
  unit_test: "spec_gate",
  integration_test: "spec_gate",
  e2e_test: "merge_gate",
  build: "task_gate",
  dependency_scan: "external_check",
  secret_scan: "external_check",
  sast: "external_check",
  preview_deploy: "deploy_plan",
  staging_deploy: "deploy_plan",
  prod_deploy: "deploy_plan",
  artifact_publish: "release_plan",
  release_tag: "release_plan",
  scheduled: "scheduled_operation",
  notification: "external_integration",
  manual_approval: "manual_gate",
  freeze: "manual_gate",
  unknown: "unsupported_automation",
};

const CATEGORY_SEVERITY: Record<WorkflowIntentCategory, DispositionSeverity> = {
  lint: "quality",
  format: "harmless",
  typecheck: "quality",
  unit_test: "quality",
  integration_test: "quality",
  e2e_test: "quality",
  build: "quality",
  dependency_scan: "security",
  secret_scan: "security",
  sast: "security",
  preview_deploy: "quality",
  staging_deploy: "production",
  prod_deploy: "production",
  artifact_publish: "production",
  release_tag: "production",
  scheduled: "quality",
  notification: "harmless",
  manual_approval: "compliance",
  freeze: "compliance",
  unknown: "quality",
};

export function replacementFor(category: WorkflowIntentCategory): NativeReplacementKind {
  return CATEGORY_REPLACEMENT[category];
}

export function severityFor(category: WorkflowIntentCategory): DispositionSeverity {
  return CATEGORY_SEVERITY[category];
}

// ── Keyword evidence (the intent signal table) ─────────────────────────────

// Ordered most-specific → least. The first matching rule wins per line/script so
// e.g. "deploy to production" classifies as prod_deploy, not a bare "deploy".
// Each token is matched case-insensitively against the lowered haystack.
interface CategoryRule {
  category: WorkflowIntentCategory;
  tokens: string[];
  confidence: number;
}

const CATEGORY_RULES: CategoryRule[] = [
  // Security / supply-chain (named actions + common script names).
  { category: "secret_scan", tokens: ["gitleaks", "trufflehog", "secret-scan", "detect-secrets"], confidence: 0.9 },
  { category: "sast", tokens: ["codeql", "semgrep", "snyk code", "sast", "sonarqube", "sonarcloud"], confidence: 0.9 },
  {
    category: "dependency_scan",
    tokens: ["dependabot", "npm audit", "pnpm audit", "yarn audit", "snyk test", "osv-scanner", "trivy"],
    confidence: 0.85,
  },
  // Production / release lanes (most specific deploy phrasing first).
  {
    category: "prod_deploy",
    tokens: ["deploy to prod", "deploy production", "production deploy", "deploy:prod", "--prod", "prod-deploy"],
    confidence: 0.85,
  },
  {
    category: "staging_deploy",
    tokens: ["deploy to staging", "staging deploy", "deploy:staging", "deploy-staging"],
    confidence: 0.85,
  },
  {
    category: "preview_deploy",
    tokens: ["preview deploy", "deploy preview", "deploy:preview", "vercel deploy", "netlify deploy"],
    confidence: 0.8,
  },
  {
    category: "release_tag",
    tokens: ["semantic-release", "release-please", "changesets", "git tag", "gh release", "create release"],
    confidence: 0.8,
  },
  {
    category: "artifact_publish",
    tokens: ["npm publish", "pnpm publish", "docker push", "publish package", "upload-artifact", "twine upload"],
    confidence: 0.8,
  },
  // CI ladder.
  { category: "e2e_test", tokens: ["playwright", "cypress", "e2e", "end-to-end"], confidence: 0.8 },
  {
    category: "integration_test",
    tokens: ["integration test", "integration:test", "test:integration", "integration-test"],
    confidence: 0.8,
  },
  { category: "typecheck", tokens: ["tsc --noemit", "tsc -p", "typecheck", "type-check", "mypy"], confidence: 0.8 },
  {
    category: "format",
    tokens: ["prettier", "format:check", "format-check", "gofmt", "black --check"],
    confidence: 0.8,
  },
  { category: "lint", tokens: ["eslint", "oxlint", "lint", "ruff", "flake8", "golangci"], confidence: 0.8 },
  { category: "build", tokens: ["build", "compile", "bundle", "vite build", "webpack"], confidence: 0.7 },
  // Catch-all test bucket (after the more-specific test categories).
  { category: "unit_test", tokens: ["vitest", "jest", "pytest", "go test", "test", "spec"], confidence: 0.7 },
  // Generic deploy (after the env-specific lanes) — treated as production-grade
  // because an unqualified "deploy" that ships is the dangerous case.
  { category: "prod_deploy", tokens: ["deploy", "fly deploy", "kubectl apply", "helm upgrade"], confidence: 0.6 },
  // Notifications.
  { category: "notification", tokens: ["slack", "notify", "discord", "pagerduty", "webhook notify"], confidence: 0.7 },
];

/**
 * Match a haystack against the ordered rules; first hit wins. Returns the
 * matched category, the confidence, and the matched token (for the evidence
 * string), or the low-confidence `unknown` fallback when nothing matches.
 */
export function classifyText(haystack: string): {
  category: WorkflowIntentCategory;
  confidence: number;
  token: string;
} {
  const lower = haystack.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    const token = rule.tokens.find((t) => lower.includes(t));
    if (token !== undefined) return { category: rule.category, confidence: rule.confidence, token };
  }
  return { category: "unknown", confidence: 0.2, token: "no recognized automation token" };
}
