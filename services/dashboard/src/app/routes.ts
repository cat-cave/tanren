/**
 * The shell's standing navigation model: the three sidenav groups (org /
 * projects / system) and, for each row, the route it points at plus the phase
 * it ships in. One-time onboarding routes mount separately; they are not
 * permanent product nav rows.
 *
 * This is the single source of truth that both `SideNav` (chrome) and
 * `mountShell` (route registration) read from. Child screens
 * extend the shell by registering their handler at a row's `path` — see the
 * "mount your route here" convention documented in `mountShell.tsx`. Rows whose
 * `phase` is not `"2b"` render as documented placeholders until their owning
 * spec lands.
 */

/** Which Tanren phase a sidenav surface ships in. `"2b"` = implementable now. */
export type SurfacePhase = "2b" | "3+";

export interface NavRow {
  /** Stable id (also the active-state key). */
  id: string;
  /** Single-char glyph from the hi-fi sidenav. */
  glyph: string;
  /** Whether the glyph renders in the JP/kanji face (ember). */
  kanji?: boolean;
  label: string;
  /** In-shell route the row navigates to. */
  path: string;
  /** Phase the underlying surface ships in. */
  phase: SurfacePhase;
  /** Owning spec id for the surface (for placeholder copy + briefing). */
  spec?: string;
}

export interface NavGroup {
  /** Group label, e.g. "org". */
  label: string;
  rows: NavRow[];
}

/**
 * The three groups, exactly per the acceptance criteria. Project-scoped rows use
 * a `:projectId` placeholder; `SideNav` substitutes the active project. Rows
 * without an implementation yet are marked `phase: "3+"` and render as
 * placeholders carrying that label.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "org",
    rows: [
      { id: "overview", glyph: "▤", label: "overview", path: "/overview", phase: "2b" },
      { id: "roadmap", glyph: "⌥", label: "roadmap", path: "/roadmap", phase: "3+" },
      { id: "personas", glyph: "◍", label: "personas", path: "/personas", phase: "3+" },
      {
        id: "costs",
        glyph: "$",
        label: "history & costs",
        path: "/costs",
        phase: "2b",
        spec: "P2B-0005",
      },
      { id: "dora", glyph: "↗", label: "DORA", path: "/dora", phase: "2b", spec: "P3-0019" },
      { id: "mergeQueue", glyph: "⇄", label: "merge queue", path: "/merge-queue", phase: "2b" },
      { id: "budget", glyph: "◎", label: "budget", path: "/budget", phase: "2b" },
    ],
  },
  {
    label: "projects",
    rows: [
      {
        id: "projects",
        glyph: "◇",
        label: "project list",
        path: "/projects",
        phase: "2b",
        spec: "P2B-0003",
      },
      {
        id: "discovery",
        glyph: "+",
        label: "discover spec",
        path: "/discovery",
        phase: "2b",
        spec: "P3-0014",
      },
      {
        id: "inbox",
        glyph: "◍",
        label: "candidate inbox",
        path: "/inbox",
        phase: "2b",
        spec: "P3-0022",
      },
      {
        id: "failure",
        glyph: "×",
        label: "halted runs",
        path: "/runs/halted",
        phase: "2b",
        spec: "P2B-0008",
      },
      // bh-14b: the Self-Healing surface (funnel + loop-detail causal graph +
      // six separate truth badges) mounts its real route from the screens seam.
      {
        id: "selfHealing",
        glyph: "✦",
        label: "Self-Healing",
        path: "/self-healing",
        phase: "2b",
        spec: "bh-14b",
      },
    ],
  },
  {
    label: "system",
    rows: [
      {
        id: "audits",
        glyph: "⌬",
        label: "scheduled audits",
        path: "/audits",
        phase: "2b",
        spec: "P3-0021",
      },
      {
        id: "settings",
        glyph: "⚙",
        label: "routing & limits",
        path: "/settings/routing",
        phase: "2b",
        spec: "P2B-0003",
      },
      {
        id: "config",
        glyph: "▮",
        label: "tanren-config",
        path: "/settings/config",
        phase: "2b",
        spec: "P3-0017",
      },
      {
        id: "notifications",
        glyph: "✉",
        label: "notifications",
        path: "/notifications",
        phase: "2b",
        spec: "P2B-0002",
      },
      {
        id: "integrations",
        glyph: "⬡",
        label: "integrations",
        path: "/integrations",
        phase: "2b",
      },
    ],
  },
];

/** Flatten all rows (handy for route registration + lookups). */
export function allNavRows(): NavRow[] {
  return NAV_GROUPS.flatMap((group) => group.rows);
}
