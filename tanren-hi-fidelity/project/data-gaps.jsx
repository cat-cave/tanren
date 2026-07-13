// data-gaps.jsx — mock data for the gap-closing surfaces:
//   • FORGE_ANSWERS  — canned chat replies for the ⌘K chat morph
//   • SPECS          — spec detail behind every DAG node (drawer + full page)
//   • AUDITS         — scheduled / cron audits library
//   • INBOX          — configurable issue-source candidate inbox
//   • CONFIG_PR      — the tanren-config audit-gate PR review
// Grounded in PROJECT_BRIEF §2 (the loop), §3 (writers/answerers),
// §4 (cost models), §9 (specs/runs schema), §2.2 (scheduled / cron audits).

// =====================================================================
// FORGE · canned chat answers (the ⌘K palette → chat morph)
// Keyed by the palette item's `ask` payload, or a topic slug.
// =====================================================================
const FORGE_ANSWERS = {
  blocking_m5: {
    q: "why is this blocked?",
    text: "<b>M5 · edi</b> is gated on one decision, not code. <code>edi-mapping-ui</code> waits on <code>edi-parser-ts</code>, which waits on <code>workato-adapter</code> — and that can't start until you raise the M5 budget (the org openai key won't cover the cluster's audit passes). <b>One budget call unblocks 3 specs.</b>",
    chips: ["raise budget for M5", "show the dependency chain", "what does the cluster cost?"],
    card: { lbl: "auto-navigate", title: "edi-mapping-ui · spec drawer", route: "spec", payload: "edi mapping ui" },
  },
  costs_week: {
    q: "how are my costs trending?",
    text: "This week: <b>$12.84</b> of $50, ↘ 18% under projected. Driver: more <code>writer</code> calls routed to <code>opencode · glm-5.1</code> (cheap, per-token). Your <code>chatgpt</code> subscription window sits at 12% — comfortably under cap, but the <b>overnight windows are &lt; 30% filled</b>. Scheduled audits could use what you're already paying for.",
    chips: ["schedule overnight audits", "where's the waste?", "forecast end of month"],
    card: { lbl: "auto-navigate", title: "history & costs", route: "costs" },
  },
  m7_eta: {
    q: "when does m7 perf ship?",
    text: "<b>M7 · perf</b> · 5 specs · current velocity <b>5.2 specs/day</b> on this project. Projected: <b>june 18</b> ± 3 days. Two specs in the path (<code>multi-region</code>, <code>perf-budget</code>) depend on M5 shipping first — if M5 slips, M7 slips one-for-one.",
    chips: ["show the critical path", "what de-risks M7?"],
    card: { lbl: "auto-navigate", title: "the roadmap", route: "roadmap" },
  },
  triage: {
    q: "triage open issues across projects",
    text: "Scanning your configured issue sources across <b>3 projects</b>. I found <b>11 open candidates</b> — <b>3</b> already match acceptance criteria on existing specs (I'll dedupe), <b>2</b> are scheduled-audit findings I can route automatically, and <b>6</b> need your call on DAG placement.",
    chips: ["open the candidate inbox", "just the auto-routable ones"],
    card: { lbl: "auto-navigate", title: "candidate inbox", route: "inbox" },
  },
  new_spec: {
    q: "shape a new spec",
    text: "Describe the work in plain language — the persona it serves and what \"done\" looks like. I'll draft acceptance criteria as BDD behaviors, dependency-rank it against the live DAG, and show you the placement before I write anything.",
    chips: ["it's for the line-worker persona", "start from a github issue"],
    card: { lbl: "auto-navigate", title: "discover a spec", route: "discovery" },
  },
  // Org Overview answers mirror the command deck's portfolio mock.
  org_budget_risk: {
    q: "which project will hit budget first?",
    text: "<b>tanren-fixture-easy</b> is the closest portfolio budget risk: <b>$12.84 of $50</b> spent this week (26%). Org month-to-date is <b>$84.20 of $275</b>, with a <b>$152</b> end-of-month forecast (55% of cap), so no cap is projected to be breached. <code>supply-chain-os</code> is at $0 of $200 and <code>cat-cave-www</code> is at $2.18 of $25.",
    chips: ["show the cost drivers", "compare project burn rates", "forecast next month"],
    card: { lbl: "auto-navigate", title: "history & costs", route: "costs" },
  },
  org_halted_runs: {
    q: "any halted runs older than 2h?",
    text: "<b>Yes — one.</b> <code>edi-mapping</code> has been halted for <b>4h 12m</b>, which is 2h 12m past your threshold. It belongs to <b>tanren-fixture-easy</b>; the portfolio shows no other halted runs.",
    chips: ["why is edi-mapping halted?", "show its dependency chain", "what decision clears it?"],
  },
  org_loop_speed: {
    q: "where is the loop slowest?",
    text: "<b>cat-cave-www</b> is slowest among projects with observed throughput at <b>0.4 loops/day</b>, versus <b>5.2/day</b> for <code>tanren-fixture-easy</code>. <code>supply-chain-os</code> has no loop velocity yet because it is still in interview. Portfolio speed is <b>5.6 loops/day</b> on the rolling 7-day view.",
    chips: ["inspect cat-cave-www activity", "compare the last 7 days", "what is slowing it down?"],
  },
  generic: {
    q: "tell me about this",
    text: "Working on it. I read the whole portfolio — the DAG, the last 30 days of runs, your cost windows, and the open candidates. Ask me to navigate somewhere, forge something, or explain what I see.",
    chips: ["what needs me right now?", "where's the loop slowest?", "how are costs trending?"],
  },
};

// =====================================================================
// SPECS · the unit of work (PROJECT_BRIEF §9 specs schema)
// Keyed by DAG node title so any node click resolves. Nodes without an
// explicit entry are synthesized by specForNode() from their status.
// =====================================================================
const SPECS = {
  "supplier scorecard": {
    id: "spec_a4f", status: "review", milestone: "M3 · ops dash",
    persona: "ops manager", behavior: "b2 · review supplier scorecard",
    title: "supplier scorecard",
    desc: "Render a per-supplier scorecard with on-time %, defect rate, and a 90-day trend. Drives the ops manager's reorder decisions; feeds the reorder approval flow downstream.",
    acceptance: [
      { kw: "given", t: "an ops manager on the suppliers list" },
      { kw: "when", t: "they open a supplier" },
      { kw: "then", t: "they see on-time %, defect rate, and a 90-day sparkline, each with the source run" },
    ],
    dependsOn: ["supplier model"],
    blocks: ["reorder approval", "cfo · cost variance"],
    runs: [
      { id: "run_a347d4", outcome: "pr_opened", note: "PR #142 · auditor pass · ci green", cost: "$0.41", when: "2h ago", live: false, route: "review" },
      { id: "run_a341b0", outcome: "failed", note: "auditor: trend chart not verifiable · replanned", cost: "$0.18", when: "5h ago" },
    ],
    cost: "$0.59", cli: "codex · gpt-5.5",
  },
  "orders ui list": {
    id: "spec_b21", status: "live", milestone: "M3 · ops dash",
    persona: "ops manager", behavior: "b1 · place a purchase order",
    title: "orders ui list",
    desc: "Paginated orders list with status filters and inline reorder. The writer is mid-flight on subtask 1 of 4 (the table shell).",
    acceptance: [
      { kw: "given", t: "an authenticated ops manager" },
      { kw: "when", t: "they open orders" },
      { kw: "then", t: "they see a filterable, paginated list with live status" },
    ],
    dependsOn: ["orders schema"],
    blocks: ["orders create form"],
    runs: [
      { id: "run_a347", outcome: "live", note: "writer · subtask 1/4 · table shell", cost: "$0.12", when: "now", live: true, route: "run" },
    ],
    cost: "$0.12", cli: "opencode · glm-5.1",
  },
  "clock-in barcode": {
    id: "spec_c08", status: "live", milestone: "M4 · handheld",
    persona: "line worker", behavior: "b1 · clock in with badge",
    title: "clock-in barcode",
    desc: "Handheld badge scan to clock in. Camera-based barcode capture with a manual-entry fallback. The hot path for the line-worker persona.",
    acceptance: [
      { kw: "given", t: "a line worker at a handheld station" },
      { kw: "when", t: "they scan their badge barcode" },
      { kw: "then", t: "they are clocked in within 400ms, with a manual fallback if the camera fails" },
    ],
    dependsOn: ["expo scaffold", "auth schema"],
    blocks: ["pick list ui", "scan item to tote"],
    runs: [
      { id: "run_5fa8", outcome: "live", note: "writer · subtask 2/3 · localStorage persistence", cost: "$0.34", when: "now", live: true, route: "run" },
    ],
    cost: "$0.34", cli: "codex · gpt-5-high",
  },
  "edi mapping ui": {
    id: "spec_e14", status: "blocked", milestone: "M5 · edi",
    persona: "cfo", behavior: "b2 · reconcile edi documents",
    title: "edi mapping ui",
    desc: "Visual field-mapper from partner EDI schemas to the internal orders model. Blocked: the parser it consumes can't start until the M5 budget is raised.",
    acceptance: [
      { kw: "given", t: "a cfo with an unmapped partner feed" },
      { kw: "when", t: "they drag partner fields onto internal fields" },
      { kw: "then", t: "the mapping persists and validates a sample document" },
    ],
    dependsOn: ["edi parser ts", "workato adapter"],
    blocks: ["edi monitoring"],
    blockedReason: "edi-parser-ts is queued behind workato-adapter, which can't start until the M5 budget question is settled. 3 specs stack behind one decision.",
    runs: [],
    cost: "$0.00", cli: "—",
  },
  "session middleware": {
    id: "spec_a12", status: "done", milestone: "M2 · auth",
    persona: "developer · fixture operator", behavior: "b3 · authenticate a session",
    title: "session middleware",
    desc: "Cookie-based session middleware with rolling expiry. Merged after a retry — the second attempt produced a larger diff, which forge flagged as an underspecified-acceptance signal.",
    acceptance: [
      { kw: "given", t: "a request with a valid session cookie" },
      { kw: "when", t: "it hits a protected route" },
      { kw: "then", t: "the session is refreshed and the user resolved, else 401" },
    ],
    dependsOn: ["auth schema"],
    blocks: ["role rbac", "login screens"],
    runs: [
      { id: "run_99c2", outcome: "pr_merged", note: "merged · attempt 2/3 · 47-line diff", cost: "$0.22", when: "4h ago" },
      { id: "run_99b8", outcome: "failed", note: "attempt 1 · check failed on edge case", cost: "$0.09", when: "4h ago" },
    ],
    cost: "$0.31", cli: "opencode · glm-5.1",
  },
};

// Synthesize a spec for any DAG node without an explicit SPECS entry.
const STATUS_DESC = {
  done: "Merged and verified. Part of a completed milestone cluster.",
  live: "A writer is mid-flight on this spec right now.",
  review: "Forged and CI-green — waiting on your sign-off.",
  blocked: "Cannot start until an upstream dependency or decision clears.",
  queued: "Planned and dependency-ranked. Waiting its turn in the DAG.",
};
const specForNode = (node) => {
  if (SPECS[node.t]) return SPECS[node.t];
  return {
    id: "spec_" + node.t.replace(/[^a-z]/gi, "").slice(0, 6).toLowerCase(),
    status: node.s, milestone: "—", persona: "—", behavior: "—",
    title: node.t,
    desc: STATUS_DESC[node.s] || STATUS_DESC.queued,
    acceptance: [
      { kw: "given", t: "the persona this spec serves" },
      { kw: "when", t: "they perform the behavior" },
      { kw: "then", t: "the acceptance criteria forge wrote are demonstrated" },
    ],
    dependsOn: [], blocks: [],
    blockedReason: node.s === "blocked" ? "Upstream dependency not yet satisfied." : null,
    runs: node.s === "done"
      ? [{ id: "run_" + node.t.slice(0, 3), outcome: "pr_merged", note: "merged", cost: "$0.20", when: "—" }]
      : [],
    cost: node.s === "done" ? "$0.20" : "$0.00", cli: node.s === "queued" ? "—" : "codex · gpt-5.5",
  };
};

// =====================================================================
// SCHEDULED AUDITS (PROJECT_BRIEF §2.2 — finished audits library mock)
// Recurring read-only Answerer passes that fill idle subscription windows.
// Consumed by view-audits.jsx (scheduled audits surface).
// =====================================================================
const AUDIT_JOBS = [
  {
    name: "dependency freshness", kind: "deps", status: "on",
    schedule: "nightly · 02:00", window: "chatgpt · night (00–05)",
    cli: "codex · gpt-5.5-low", lastRun: "6h ago",
    findings: { n: 2, sev: "warn", note: "2 minor + 0 major · both auto-spec-able" },
  },
  {
    name: "security scan", kind: "security", status: "on",
    schedule: "nightly · 03:30", window: "chatgpt · night (00–05)",
    cli: "claude · haiku-4.5", lastRun: "5h ago",
    findings: { n: 0, sev: "ok", note: "no new advisories since last run" },
  },
  {
    name: "accessibility (a11y)", kind: "a11y", status: "on",
    schedule: "weekly · sun 04:00", window: "chatgpt · night (00–05)",
    cli: "claude · haiku-4.5", lastRun: "2d ago",
    findings: { n: 2, sev: "warn", note: "cat-cave-www · 2 contrast issues → candidates" },
  },
  {
    name: "mutation tests", kind: "mutation", status: "paused",
    schedule: "weekly · sat 01:00", window: "self-host gpu (idle)",
    cli: "opencode · glm-5.1", lastRun: "9d ago",
    findings: { n: 0, sev: "off", note: "paused · gpu was reallocated to writers" },
  },
];

// Forge-recommended audits to add (coverage gaps it noticed).
const AUDIT_RECOMMENDED = [
  { name: "performance budget", why: "M7 · perf depends on a baseline you're not yet measuring nightly.", window: "evening (20–00) · 9% filled" },
  { name: "license compliance", why: "3 transitive deps changed license class last month — currently unaudited.", window: "night (00–05) · 22% filled" },
];

// =====================================================================
// CANDIDATE INBOX (PROJECT_BRIEF runs.trigger = 'webhook', §8 sources)
// Sources are CONFIGURABLE connectors — not hardcoded. Scheduled-audit
// findings auto-promote; external issues get full triage.
// =====================================================================
const INBOX_SOURCES = [
  { name: "github · cat-cave", kind: "issues", on: true, auto: false, detail: "issues labeled `spec-candidate` · 6 open" },
  { name: "linear · cat-cave", kind: "issues", on: true, auto: false, detail: "triage view · synced 4m ago" },
  { name: "sentry · prod", kind: "errors", on: true, auto: false, detail: "unresolved · ≥ 50 events/24h" },
  { name: "scheduled audits", kind: "system", on: true, auto: true, detail: "auto-routes findings · no manual triage" },
  { name: "manual · paste", kind: "manual", on: true, auto: false, detail: "sales-call notes, slack, anywhere" },
  { name: "+ connect a source", kind: "add", on: false, auto: false, detail: "any webhook or polled endpoint" },
];

const CANDIDATES = [
  {
    id: "cand_01", source: "scheduled audits", kind: "system", auto: true, sev: "warn",
    title: "a11y · 2 contrast failures on marketing nav",
    body: "Weekly a11y audit found nav links at 3.1:1 against ash. Below WCAG AA.",
    age: "3h", project: "cat-cave-www",
    triage: { dedupe: "no match", match: "fits existing behavior · marketing-reader b1", placement: "auto → cat-cave-www · queued", verdict: "auto-routable" },
  },
  {
    id: "cand_02", source: "github · cat-cave", kind: "issues", auto: false, sev: "info",
    title: "feature · CSV export for monthly close",
    body: "Issue #88 from a sales call. CFO wants a one-click CSV of the monthly close. Acme asked for the same on a call 2h ago.",
    age: "2h", project: "tanren-fixture-easy",
    triage: { dedupe: "merges with acme sales-call note", match: "new behavior · cfo b3", placement: "forge proposes M6 · cfo · P1", verdict: "needs your call" },
  },
  {
    id: "cand_03", source: "sentry · prod", kind: "errors", auto: false, sev: "fail",
    title: "bug · intermittent 500 on /orders pagination",
    body: "342 events / 24h. Stack points at the cursor encoder added in spec_b21 (orders ui list, in flight).",
    age: "40m", project: "tanren-fixture-easy",
    triage: { dedupe: "no match", match: "touches in-flight spec_b21", placement: "forge suggests folding into the live run", verdict: "needs your call" },
  },
  {
    id: "cand_04", source: "linear · cat-cave", kind: "issues", auto: false, sev: "info",
    title: "TIK-204 · dark mode toggle (duplicate)",
    body: "Linear issue requesting a theme toggle.",
    age: "1d", project: "tanren-fixture-easy",
    triage: { dedupe: "duplicate of spec_a4f (shipped)", match: "already merged · PR #131", placement: "forge recommends closing as done", verdict: "dedupe → close" },
  },
];

// =====================================================================
// TANREN-CONFIG · audit-gate PR (config-as-code review)
// When the audit gate is ON, forge's config edits land as a PR in
// cat-cave/tanren-config and run through review before merge.
// =====================================================================
const CONFIG_PR = {
  pr: "PR #7", repo: "cat-cave/tanren-config", file: "tanren.yaml", branch: "forge/route-audit-to-opus",
  proposedBy: "forge", ci: "green", checks: ["schema valid", "no dangling cred refs", "fallback chain ≥ 1"],
  summary: "You asked: \"swap the audit primary to claude opus 4.7.\" This re-routes the auditor role and keeps codex as the fallback. It raises audit quality on high-stakes specs and shifts ~$6/mo from the chatgpt window to the org claude key.",
  reviewers: [{ who: "TW", role: "you", state: "pending" }],
  diff: [
    { t: "comment", s: "# tanren.yaml · role routing" },
    { t: "ctx", s: "[providers.audit]" },
    { t: "rem", s: "  primary = \"codex/gpt-5.5\"        # org openai key" },
    { t: "add", s: "  primary = \"claude/opus-4.7\"      # org claude key · high-stakes reasoning" },
    { t: "add", s: "  fallback = [\"codex/gpt-5.5\"]     # keep codex as the cheaper backstop" },
    { t: "ctx", s: "" },
    { t: "ctx", s: "[limits]" },
    { t: "ctx", s: "  max_planner_reruns = 3" },
  ],
  impact: [
    { l: "audit quality", v: "↑ opus reasoning", k: "high-stakes specs" },
    { l: "cost shift", v: "+$6/mo claude", k: "−$6/mo chatgpt window" },
    { l: "blast radius", v: "audit role only", k: "plan/write/check unchanged" },
  ],
  history: [
    { v: "PR #6", t: "raise max writer iter 5 → 8", who: "forge", when: "3d ago", state: "merged" },
    { v: "PR #5", t: "add gemini-2.5-pro as write fallback", who: "forge", when: "8d ago", state: "merged" },
    { v: "PR #4", t: "rotate openai org key reference", who: "TW", when: "12d ago", state: "merged" },
  ],
};

Object.assign(window, {
  FORGE_ANSWERS, SPECS, specForNode,
  AUDIT_JOBS, AUDIT_RECOMMENDED,
  INBOX_SOURCES, CANDIDATES,
  CONFIG_PR,
});
