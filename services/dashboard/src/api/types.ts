/**
 * Narrow response types for the orchestrator product APIs the shell consumes.
 *
 * These mirror the JSON shapes returned by the orchestrator routes the shell
 * depends on (orgs, projects, forge tools). They are intentionally local and
 * minimal — the shell only reads the fields it renders. Where the orchestrator
 * contract widens, widen these alongside it (they are not auto-derived).
 */

/** An organization the operator is a member of (`GET /orgs`). */
export interface OrgSummary {
  id: string;
  kind: string;
  login: string;
  displayName: string | null;
  role: string;
}

/** A project within an org (`GET /orgs/:orgId/projects`). */
export interface ProjectSummary {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  runnerImage: string | null;
  allocator: string | null;
}

/**
 * A single palette item surfaced from the Forge tool surface (P2A-0019).
 * `kind` distinguishes read actions (route in the shell) from write actions
 * (call the operator-button endpoint) and ask-forge prompts (open a thread).
 */
export interface PaletteItem {
  glyph: string;
  kanji?: boolean;
  title: string;
  desc: string;
  /** Read actions carry an in-shell route to navigate to. */
  route?: string;
  /** Write actions carry a Forge tool id invoked via `POST .../forge/tools`. */
  tool?: string;
  /** Optional pre-filled args for a write tool. */
  args?: Record<string, unknown>;
}

/** A named group of palette items (`quick actions`, `forge this`, `ask forge`). */
export interface PaletteGroup {
  group: string;
  items: PaletteItem[];
}

// ── P2B-0002 onboarding / credentials / notifications additions ──────────
// All additive: read the fields the onboarding/credentials/notifications
// screens render off the P2A-0013 (doctor/credentials/brownfield) and
// P2A-0017 (notifications) contracts. Local + minimal, like the rest.

/** A single `/doctor` check (P2A-0013 DoctorCheck). */
export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  latencyMs: number | null;
}

/** `/doctor` report (P2A-0013 DoctorReport). */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  generatedAt: string;
}

/** A credential reference record (P2A-0013 CredentialRecord). Never a value. */
export interface CredentialRecord {
  ref: string;
  kind: "codex_chatgpt_auth" | "github_token" | "opaque";
  scope: "org" | "me";
  ownerId: string;
  createdAt: string;
}

/** A detected (read-only, never written) target-repo file (P2A-0013). */
export interface BrownfieldDetectedFile {
  path: string;
  present: boolean;
  size?: number;
  preview?: string;
}

/** Result of the brownfield link call (P2A-0013). */
export interface BrownfieldLinkResult {
  projectId: string;
  repoUrl: string;
  orgId: string;
  detectedFiles: BrownfieldDetectedFile[];
  writesPerformed: number;
}

/** A created project (P2A-0013 project create). */
export interface CreatedProject {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  runnerImage: string | null;
  allocator: string | null;
}

/** P2A-0017 notification channel kinds. */
export type ChannelKind =
  | "ntfy"
  | "slack"
  | "github_checks"
  | "teams"
  | "discord"
  | "email"
  | "twilio"
  | "pagerduty"
  | "webhook";

/** P2A-0017 severity taxonomy. */
export type Severity = "ok" | "info" | "warn" | "fail";

/** A configured notification destination (P2A-0017 NotificationTargetRow). */
export interface NotificationTarget {
  id: string;
  orgId: string;
  scope: "org" | "user";
  userId: string | null;
  channelKind: ChannelKind;
  destination: string;
  label: string;
  enabled: boolean;
  weekendMute: boolean;
}

/** A per-(target × event) opt-in (P2A-0017 NotificationRouteRow). */
export interface NotificationRoute {
  id: string;
  targetId: string;
  eventName: string;
  enabled: boolean;
  minSeverity: Severity;
}

/** An event-registry row + its default severity, for the matrix rows. */
export interface NotificationEvent {
  eventName: string;
  defaultSeverity: Severity;
}

/** The full notifications-matrix payload the screen renders against. */
export interface NotificationMatrix {
  targets: NotificationTarget[];
  routes: NotificationRoute[];
  events: NotificationEvent[];
}
