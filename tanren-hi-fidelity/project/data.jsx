// data.jsx — Tanren hi-fi mock data.
// This is the centerpiece per the user's open question:
// • What does Forge actually SAY, in what order?
// • How does a suboptimal workflow become readily visible?
// • What action does the user take to fix it?
//
// Three flows worth of data; each Forge narration is structured as:
//   state    — the one-sentence project pulse
//   attention — ranked queue of things needing the human
//   subopt    — workflow-quality findings (the "something's off" callouts)
//   prompts   — suggested next questions

// ----- PROJECT VIEW ---------------------------------------------------

const PROJECT_FORGE = {
  state: {
    label: "▮ project pulse",
    headline: (
      <>M3 <em>ahead</em> by 2.1d · M4 in flight · M7 ETA <b>june 18</b></>
    ),
    sub: "PR #142 supplier scorecard is review-ready (auditor pass · CI green). Clock-in barcode mid-write (subtask 2/3). $12.84 of $50 spent this week.",
  },
  attention: [
    {
      id: "review-142",
      priority: "review",
      title: "PR #142 · supplier scorecard",
      sub: "auditor: pass · ci: green · 2h since verdict",
      action: "open review",
      route: "review",
      hot: true,
    },
    {
      id: "decide-csv",
      priority: "decide",
      title: "acme's csv export · where in the dag",
      sub: "from sales call · forge proposed P1 placement",
      action: "open discovery",
      route: "discovery",
    },
    {
      id: "budget-m5",
      priority: "budget",
      title: "M5 edi cluster will need claude credits",
      sub: "forecast · in ~9 days · org openai key not enough",
      action: "raise budget",
      route: "budget",
    },
  ],
  subopt: [
    {
      id: "retry-hotspot",
      lbl: "retry hotspot",
      symbol: "↻",
      title: "session middleware retried 2× this week",
      body: "Same writer, same spec, second attempt produced a 47-line diff vs. first attempt's 23. Usually means the BDD acceptance is underspecified. Most teams tighten the persona's stated behavior before the third retry; otherwise the loop wastes credits.",
      actions: [
        { label: "open bdd · refine", primary: true },
        { label: "compare both attempts" },
        { label: "snooze · 24h", ghost: true },
      ],
    },
    {
      id: "model-mismatch",
      lbl: "model mismatch",
      symbol: "$",
      title: "supplier model spec is over-paying by ~7×",
      body: "Five completed runs averaged $0.34 on gpt-5-high. Same persona's behavior tests passed at $0.04 on haiku-4.5 in audits 11 days ago. Switching the writer for this spec class would save ~$22/mo at current cadence.",
      actions: [
        { label: "switch writer · this spec class", primary: true },
        { label: "see audit comparison" },
        { label: "dismiss · we want gpt-5", ghost: true },
      ],
    },
    {
      id: "blocked-spec",
      lbl: "stuck",
      symbol: "⏳",
      title: "edi-mapping-ui has been queued 4h 12m",
      body: "Dependency edi-parser-ts is queued behind workato-adapter, which can't start until the M5 budget question (above) is settled. Three things are stacked behind one decision. Tap to resolve in order.",
      actions: [
        { label: "see dependency chain", primary: true },
        { label: "ask forge · why blocked?" },
      ],
    },
  ],
  prompts: [
    "where will we be at end of month?",
    "what's the riskiest spec in flight?",
    "show m5 cost forecast vs budget",
    "any contributors blocked?",
  ],
};

// KPI strip data
const PROJECT_KPIS = [
  { l: "in flight", v: "2", k: "$0.34 burning · 12m elapsed" },
  { l: "needs you", v: "3", k: "1 review · 2 decisions", hot: true },
  { l: "week · spend", v: "$12.84", k: "of $50 · 26%" },
  { l: "velocity", v: "5.2/d", k: "+2.1d ahead" },
  { l: "blocked", v: "1", k: "edi-mapping · 4h 12m", warn: true },
];

// Activity feed
const ACTIVITY = [
  { t: "now",  k: "run",    ev: "writer.subtask.started", det: "clock-in · 2/3" },
  { t: "12m",  k: "warn",   ev: "PR #142 ready",          det: "scorecard · pass · green" },
  { t: "47m",  k: "ok",     ev: "run.merged",             det: "supplier model · $0.41" },
  { t: "1h",   k: "run",    ev: "writer.subtask.started", det: "orders ui · 1/4" },
  { t: "2h",   k: "info",   ev: "spec discovered",        det: "csv export · acme" },
  { t: "3h",   k: "ok",     ev: "run.merged",             det: "magic link · $0.62" },
  { t: "4h",   k: "warn",   ev: "writer.retried",         det: "session middleware · 2/3" },
  { t: "5h",   k: "ok",     ev: "run.merged",             det: "role rbac · $0.34" },
  { t: "6h",   k: "ok",     ev: "audit.pass",             det: "session middleware" },
  { t: "8h",   k: "run",    ev: "ci.poll",                det: "scorecard · checks queued" },
];

// ----- RUN DETAIL -----------------------------------------------------

const RUN = {
  id: "run_a347d4",
  spec: "spec_a4f",
  branch: "tanren/spec_a4f",
  startedAgo: "4m 12s ago",
  cli: "codex · gpt-5-high",
  attempt: "1 / 3",
  elapsed: "3m 22s",
  retries: 0,
};

const RUN_COSTS = {
  perToken:  { v: "$0.34", pct: 11, cap: "$3.00" },
  window:    { v: "12%", sub: "chatgpt monthly · resets 12d" },
  tokens:    { in: "14.3k", out: "6.8k", cached: "2,140 · 15% hit" },
  spendRate: "$0.18/min",
};

const TRAJECTORY = [
  { ph: "plan",  t: "decomposed spec → 3 subtasks",                dt: "0:12", st: "done",   io: "1.4k → 0.8k" },
  { ph: "write", t: "subtask 1 · theme dropdown",                  dt: "1:04", st: "done",   io: "4.1k → 2.6k" },
  { ph: "check", t: "verified renders & applies",                  dt: "0:18", st: "done",   io: "2.1k → 0.4k" },
  { ph: "write", t: "subtask 2 · localStorage persistence",        dt: "1:08", st: "live",   io: "3.2k → 2.8k", sel: true },
  { ph: "check", t: "queued",                                      dt: "—",    st: "queued" },
  { ph: "write", t: "subtask 3 · profile sync (deferred)",         dt: "—",    st: "queued" },
  { ph: "audit", t: "audit ⊢ acceptance",                          dt: "—",    st: "queued" },
  { ph: "pr",    t: "open draft pr",                               dt: "—",    st: "queued" },
  { ph: "ci",    t: "github actions",                              dt: "—",    st: "queued" },
  { ph: "merge", t: "merge",                                       dt: "—",    st: "queued" },
];

const RUN_TOOLS = [
  { g: "▸", t: "read_file",  arg: "src/pages/settings.tsx",  state: "ok",   out: "found Settings component · 142 lines" },
  { g: "▸", t: "read_file",  arg: "src/lib/theme.ts",        state: "ok",   out: "useTheme hook · client-only" },
  { g: "▸", t: "apply_diff", arg: "src/pages/settings.tsx (+12 −2)", state: "live", out: "streaming · 8 lines applied so far" },
];

const RUN_DECISIONS = [
  { t: "chose ", code: "useEffect", rest: " over event listener — simpler invalidation" },
  { t: "localStorage key: ", code: "tanren.theme", rest: " (namespaced to avoid collisions)" },
  { t: "deferred profile sync to subtask 3 to keep this commit atomic" },
  { t: "added a small SSR script — costs ≈210 bytes but prevents the flash" },
];

// Run-detail suboptimal: the writer is taking longer than average for this spec class
const RUN_SUBOPT = {
  lbl: "pace anomaly",
  symbol: "⏱",
  title: "subtask 2 is 2.1× slower than this spec class's average",
  body: "Similar persistence subtasks complete in 1m 48s on average. This one's at 3m 22s and still streaming. Could be honest difficulty (small file with SSR concerns) — or the writer is over-deliberating. If it crosses 5m, audit will retry automatically.",
  actions: [
    { label: "tail logs", primary: true },
    { label: "ask forge · why slow?" },
  ],
};

// ----- REVIEW HANDOFF -------------------------------------------------

const REVIEW = {
  pr: "PR #142",
  repo: "cat-cave/tanren-fixture-easy",
  spec: "spec_a4f",
  title: "add dark mode toggle",
  forgedBy: "codex",
  cost: "$0.41",
  ciStatus: "green",
};

const REVIEW_BEHAVIORS = [
  { n: 1, t: "theme dropdown renders",                ci: "14ms",  done: true },
  { n: 2, t: "instant apply, no flash",                ci: "38ms",  done: true },
  { n: 3, t: "persists across reloads",                ci: "240ms", done: true },
  { n: 4, t: "syncs to profile when logged in",        ci: "410ms", done: false },
  { n: 5, t: "no SSR theme flash",                     ci: "120ms", done: false },
];

const REVIEW_DEFERRALS = [
  {
    tag: "P2 · security",
    title: "inline SSR script avoids CSP-strict nonces",
    det: "The script tag added for no-flash doesn't carry a nonce. On CSP-strict envs this would be blocked. Acceptable for current deploy target.",
    actions: [
      { label: "handle now · replan + subtasks", primary: true },
      { label: "defer · spawn follow-up spec" },
      { label: "dismiss · won't fix", ghost: true },
    ],
  },
  {
    tag: "P3 · bundle",
    title: "+210 bytes to first paint",
    det: "Within your project's bundle budget. Could be ~50b smaller if we inline a minified loop instead.",
    actions: [
      { label: "handle now · replan + subtasks", primary: true },
      { label: "defer · spawn follow-up spec" },
      { label: "dismiss · won't fix", ghost: true },
    ],
  },
];

// Review suboptimal: the reviewer has been stalled
const REVIEW_SUBOPT = {
  lbl: "review stall",
  symbol: "⏸",
  title: "B4 hasn't been touched in 8 minutes",
  body: "B4 says 'syncs to profile when logged in'. Reviewers usually pause here when the acceptance isn't testable from the preview alone. Want a 10-second walkthrough of where the sync happens in the diff, or the BDD scenario re-stated in plainer language?",
  actions: [
    { label: "walk me through the diff", primary: true },
    { label: "restate the bdd" },
    { label: "i'll figure it out", ghost: true },
  ],
};

const REVIEW_PROMPTS = [
  "open preview · log in & flip the toggle",
  "show me the diff",
  "is the SSR script CSP-safe in prod?",
  "what changed since v1.4.1?",
];

// ----- FORGE PALETTE (⌘K) ---------------------------------------------

const FORGE_PALETTE = [
  { group: "quick actions", items: [
    { glyph: "+", title: "new spec", desc: "describe work · tanren plans & forges", ask: "new_spec" },
    { glyph: "↗", title: "open run_a347 · localStorage persistence", desc: "live · subtask 2/3 streaming", route: "run" },
    { glyph: "→", title: "review PR #142 · supplier scorecard",     desc: "auditor pass · ci green",       route: "review" },
    { glyph: "▤", title: "candidate inbox · triage open issues",     desc: "11 candidates · 2 auto-routable", route: "inbox" },
    { glyph: "⟳", title: "scheduled audits",                         desc: "4 jobs · fills idle windows",   route: "audits" },
  ]},
  { group: "forge this", items: [
    { glyph: "鍛", kanji: true, title: "shape a new user behavior",        desc: "agentic crafter · cross-project persona", ask: "new_spec" },
    { glyph: "鍛", kanji: true, title: "draft a milestone from rough notes", desc: "i'll dependency-rank against the DAG", ask: "m7_eta" },
    { glyph: "鍛", kanji: true, title: "switch audit primary to claude opus", desc: "lands as a config pr · review before merge", route: "config" },
    { glyph: "鍛", kanji: true, title: "triage open issues across projects",  desc: "linear · github · sentry · summarize", ask: "triage" },
  ]},
  { group: "ask forge", items: [
    { glyph: "?", title: "what's blocking M5?",            desc: "natural-language query",     ask: "blocking_m5" },
    { glyph: "?", title: "how are my costs trending?",     desc: "this week vs last",          ask: "costs_week" },
    { glyph: "?", title: "estimate when M7 perf ships",    desc: "velocity-projected ETA",     ask: "m7_eta" },
  ]},
];

// ----- DAG NODES -------------------------------------------------------
// Used by the SVG DAG renderer in view-project.jsx
const DAG_MILESTONES = [
  { x: 80,  label: "M1", n: "scaffold", done: true },
  { x: 230, label: "M2", n: "auth",     done: true },
  { x: 380, label: "M3", n: "ops dash", live: true },
  { x: 530, label: "M4", n: "handheld", live: true },
  { x: 680, label: "M5", n: "edi" },
  { x: 830, label: "M6", n: "cfo" },
  { x: 970, label: "M7", n: "perf" },
];

const DAG_NODES = [
  { x: 80, y: 80, t: "monorepo scaffold", s: "done" },
  { x: 80, y: 115, t: "build · turbo", s: "done" },
  { x: 80, y: 150, t: "ci · gh actions", s: "done" },
  { x: 80, y: 185, t: "shared types", s: "done" },
  { x: 230, y: 80, t: "auth schema", s: "done" },
  { x: 230, y: 115, t: "session middleware", s: "done", retried: true },
  { x: 230, y: 150, t: "role rbac", s: "done" },
  { x: 230, y: 185, t: "login screens", s: "done" },
  { x: 230, y: 220, t: "magic link email", s: "done" },
  { x: 380, y: 80, t: "orders schema", s: "done" },
  { x: 380, y: 115, t: "orders ui list", s: "live", run: "run_a347" },
  { x: 380, y: 150, t: "orders create form", s: "queued" },
  { x: 380, y: 185, t: "supplier model", s: "done" },
  { x: 380, y: 220, t: "supplier scorecard", s: "review" },
  { x: 530, y: 80, t: "expo scaffold", s: "queued" },
  { x: 530, y: 115, t: "clock-in barcode", s: "live", run: "run_5fa8" },
  { x: 530, y: 150, t: "pick list ui", s: "queued" },
  { x: 530, y: 185, t: "scan item to tote", s: "queued" },
  { x: 530, y: 220, t: "confirm scan", s: "queued" },
  { x: 530, y: 255, t: "push tote · staging", s: "queued" },
  { x: 680, y: 80, t: "workato adapter", s: "queued" },
  { x: 680, y: 115, t: "edi parser ts", s: "queued" },
  { x: 680, y: 150, t: "edi mapping ui", s: "blocked" },
  { x: 680, y: 185, t: "edi monitoring", s: "queued" },
  { x: 830, y: 80, t: "cost variance", s: "queued" },
  { x: 830, y: 115, t: "monthly close", s: "queued" },
  { x: 830, y: 150, t: "exports csv", s: "queued" },
  { x: 970, y: 80, t: "perf budget", s: "queued" },
  { x: 970, y: 115, t: "multi-region", s: "queued" },
];

const DAG_EDGES = [
  ["130,91", "180,91"],
  ["180,91", "230,91"],
  ["330,91", "380,91"],
  ["480,91", "530,91", true],
  ["480,230", "530,160"],
  ["630,230", "680,91"],
  ["780,91", "830,91"],
  ["930,91", "970,91"],
];

Object.assign(window, {
  PROJECT_FORGE, PROJECT_KPIS, ACTIVITY,
  RUN, RUN_COSTS, TRAJECTORY, RUN_TOOLS, RUN_DECISIONS, RUN_SUBOPT,
  REVIEW, REVIEW_BEHAVIORS, REVIEW_DEFERRALS, REVIEW_SUBOPT, REVIEW_PROMPTS,
  FORGE_PALETTE,
  DAG_MILESTONES, DAG_NODES, DAG_EDGES,
});
