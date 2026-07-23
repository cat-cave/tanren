import type { DiscoveredCheck, DiscoveredPullRequest } from "./discovery.js";
import { buildAuditInstructions, CRA_RUBRIC, type AuditRubric } from "./auditRubric.js";

// The evidence bundle handed to the cross-model audit worker. Everything here is
// UNTRUSTED evidence except the instructions/rubric envelope. The supervisor
// assembles it from read-only discovery + the verified worktree; the worker never
// reaches GitHub or model credentials itself.

export interface LinkedIssueEvidence {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly acceptance: string;
  readonly requiredNegativeControl: string;
  readonly blockers: readonly { number: number; state: string }[];
}

export interface DeletionStat {
  readonly path: string;
  readonly deletedLines: number;
  readonly isTest: boolean;
}

export interface AuditContextInput {
  readonly pullRequest: DiscoveredPullRequest;
  readonly issue: LinkedIssueEvidence;
  readonly diff: string;
  readonly deletionStats: readonly DeletionStat[];
  readonly checks: readonly DiscoveredCheck[];
  readonly standards: string;
  // Independence inputs. `authorModelFamily` is null when provenance is unknown;
  // for an agent-authored PR that is an unconfirmable independence check.
  readonly authorIsAgent: boolean;
  readonly authorModelFamily: string | null;
}

export interface AuditContext {
  readonly headSha: string;
  readonly baseSha: string;
  readonly rubricVersion: string;
  readonly authorIsAgent: boolean;
  readonly authorModelFamily: string | null;
  readonly instructions: string;
  readonly evidence: {
    readonly pr: {
      readonly number: number;
      readonly title: string;
      readonly body: string;
      readonly headSha: string;
      readonly baseSha: string;
      readonly baseBranch: string;
      readonly author: string | null;
    };
    readonly issue: LinkedIssueEvidence;
    readonly diff: string;
    readonly deletionStats: readonly DeletionStat[];
    readonly checks: readonly DiscoveredCheck[];
    readonly standards: string;
  };
}

export function buildAuditContext(input: AuditContextInput, rubric: AuditRubric = CRA_RUBRIC): AuditContext {
  const pr = input.pullRequest;
  return {
    headSha: pr.headSha,
    baseSha: pr.baseSha,
    rubricVersion: rubric.version,
    authorIsAgent: input.authorIsAgent,
    authorModelFamily: input.authorModelFamily,
    instructions: buildAuditInstructions(rubric),
    evidence: {
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        headSha: pr.headSha,
        baseSha: pr.baseSha,
        baseBranch: pr.baseBranch,
        author: pr.author,
      },
      issue: input.issue,
      diff: input.diff,
      deletionStats: input.deletionStats,
      checks: input.checks,
      standards: input.standards,
    },
  };
}

// The worker's stdin payload: the deterministic instruction envelope plus the
// untrusted evidence, serialized as one JSON document.
export function serializeAuditContext(context: AuditContext): string {
  return `${JSON.stringify(context, null, 2)}\n`;
}
