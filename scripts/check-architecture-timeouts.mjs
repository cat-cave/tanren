// no-arbitrary-timeouts (feedback_no_timeouts_progress_based, BINDING): Tanren must
// contain ZERO arbitrary timeouts / retry caps / attempt caps / wall-clock deadlines.
// EVERY safety / hang-detection / robustness mechanism must be a PROGRESS / SIGN-OF-LIFE
// based solution (the convergence-agent / ActivityWatchdog model), NEVER time-based —
// "10 minutes is nothing to an AI agent". Even a no-output-for-N-min watchdog is a
// DISGUISED timeout and forbidden. This lint makes that a mechanical gate so the class
// can never silently reintroduce. Same heuristic line-scanner style as the sibling
// check-architecture-*.mjs modules; extracted to keep each file under the 500-line cap.
//
// ENFORCED (Phase-1 SEAL): the scanner is folded into `runArchitectureChecks` (the exit-1
// set), so a NEW arbitrary timeout / retry-cap / disguised quiet-window / banned identifier
// FAILS `just ci`'s `check:architecture`. Every pre-existing site has migrated to a
// progress/sign-of-life primitive; the report-mode migration checklist is retired.
//
// What it flags in **/src/** non-test files:
//   (a) total-duration KILL timers — `setTimeout(() => { … kill/fail/throw/reject/destroy/
//       abort … }, …)` (a wall-clock budget that terminates work).
//   (b) fixed LOOP CAPS — `for (… < maxAttempts/maxPolls/maxIter …)`, `while (attempt < N)`,
//       and identifiers matching /max.*(attempt|iter|poll|retr|tries|stall)/i used to
//       terminally give up.
//   (c) whole-op DEADLINES — `Date.now() + … (deadline|budget)` style expiries.
//   (d) fixed QUIET-WINDOW / no-output-for-N watchdogs (disguised timeouts).
//   (e) banned IDENTIFIERS — DEFAULT_TIMEOUT_MS, *_TIMEOUT_MS = 600_000, maxWriterIter*,
//       maxRetriesPerTransient*, MAX_*_ATTEMPTS, maxRunHours, DEFAULT_TRIAL_TIMEOUT_MS, etc.
//
// BLESSED (not violations): poll INTERVALS, backoff SPACING, heartbeat cadence,
// connect-establishment timeouts, lease windows, token TTLs, debounce, the
// LivenessProbe/ActivityWatchdog/retryUntilConverged primitives, KEYGEN_MAX_ATTEMPTS,
// MAX_NODE_TIMER_DELAY_MS, the structural maxIterations = batchSize + 1. Two bless
// mechanisms: a per-line `// arch-allow: timeout-class …` annotation (reviewable in-source),
// and a finite enumerated identifier allowlist below.

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

const RULE = "no-arbitrary-timeouts";

// The per-line bless annotation. A flagged line is exempt iff it (or — for a multi-line
// construct — the line itself) carries this marker, so each exemption is reviewable.
const ARCH_ALLOW = "arch-allow: timeout-class";

// Finite, enumerated identifier allowlist — names that LOOK like the banned taxonomy but
// are legitimate (an external bound, a structural constant, or the replacement primitive).
// These are blessed wherever they appear (a name-level bless), independent of the per-line
// annotation. Keep this list short + justified.
export const timeoutIdentifierAllowlist = new Set([
  // A bounded SSH keypair generation retry against a real keyspace collision — a finite
  // external fact (a fresh key per attempt), not a give-up budget on converging work.
  "KEYGEN_MAX_ATTEMPTS",
  // Node's hard ceiling on a single setTimeout delay (2^31-1 ms) — a platform fact used to
  // clamp/split a legitimately-long interval, not a safety budget.
  "MAX_NODE_TIMER_DELAY_MS",
  // The structural batch-assembly bound (batchSize + 1) — provably terminates because each
  // iteration consumes one batch member; it is a loop-shape invariant, not an attempt cap.
  "maxIterations",
  // The replacement primitives themselves — naming the doctrine's progress-based machinery.
  "ActivityWatchdog",
  "LivenessProbe",
  "retryUntilConverged",
]);

// (a) total-duration KILL timer: a setTimeout whose body terminates work. We match the
// `setTimeout(` opener and look for a kill verb in the same statement (the callback body up
// to the delay arg). Captures the opener position for the line number.
const killTimerOpener = /setTimeout\s*\(/gu;
const killVerb = /\b(kill|destroy|abort|reject|throw|fail|timedOut|terminate)\b/u;

// (b) fixed loop caps. A `for`/`while` head that compares an attempt/iteration counter to a
// max bound. The captured group is the BOUND identifier (so an allowlisted structural bound
// like `maxIterations` is blessed). The head match's SPAN suppresses a give-up identifier
// inside it (so a `for (… < maxAttempts …)` counts ONCE as a loop cap, not also as the id).
const loopCapPatterns = [
  /\bfor\s*\([^)]*<\s*(max[A-Za-z]*|[A-Za-z_$][A-Za-z0-9_$]*(?:Attempts|Polls|Iter\w*|Tries|Retries))\b[^)]*\)/gu,
  /\bwhile\s*\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*<\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/gu,
];
// Give-up identifiers used to terminally bound a loop (the /max.*(…)/i family). The CAPTURED
// group is the WHOLE identifier (so the allowlist + dedup see e.g. `maxRetriesPerTransient`,
// not a sub-span).
const giveUpIdentifier = /\b(max[A-Za-z0-9_$]*(?:attempt|iter|poll|retr|tries|stall)[A-Za-z0-9_$]*)/giu;

// (c) whole-op deadline: a `Date.now() + …` (or `performance.now() + …`) stored as a
// deadline/budget/expiry the op checks to give up. Heuristic: the additive now-expression
// with a deadline/budget/expiry word anywhere on the same line (the word may be the LHS
// variable `const deadline = …` or a `…Budget…` term, so no leading word boundary).
const deadlinePattern = /(?:Date\.now\(\)|performance\.now\(\))\s*\+[^;\n]*(deadline|budget|expir)/giu;

// (d) fixed quiet-window / no-output-for-N watchdog — a disguised timeout. Catches the
// "quiet"/"idle"/"noOutput"/"lastOutput" + a duration-ms identifier on one line.
const quietWindowPattern =
  /\b(quiet|idle|noOutput|lastOutput|sinceOutput|stallMs|inactivity)[A-Za-z0-9_$]*\s*(?:[<>]=?|=)\s*[A-Za-z0-9_$]*(?:Ms|MS|Millis|Timeout)\b/gu;

// (e) banned identifier DECLARATIONS — the 600_000 timeout family + the attempt-cap family.
// Matches a const/let/field declaration of a name in the banned taxonomy.
const bannedIdentifierPatterns = [
  // *_TIMEOUT_MS constants (DEFAULT_TIMEOUT_MS, BASE_SHIFT_TIMEOUT_MS, DEFAULT_TRIAL_TIMEOUT_MS …)
  /\b([A-Z][A-Z0-9_]*_TIMEOUT_MS|DEFAULT_TIMEOUT_MS)\b/gu,
  // MAX_*_ATTEMPTS / *_MAX_ATTEMPTS screaming-case attempt caps.
  /\b(MAX_[A-Z0-9_]*_ATTEMPTS|[A-Z0-9_]*_MAX_ATTEMPTS)\b/gu,
  // camelCase max-iteration / retries-per / run-hours give-up knobs.
  /\b(maxWriterIter[A-Za-z0-9_$]*|maxRetriesPerTransient[A-Za-z0-9_$]*|maxRunHours[A-Za-z0-9_$]*|DEFAULT_[A-Z0-9_]*_MAX_ATTEMPTS)\b/gu,
];

function isProductionSource(file) {
  return file.includes("/src/") && !file.includes("/tests/") && !/\.test\.[tj]sx?$/u.test(file);
}

// Strip `//` line comments and `*`-prefixed block-comment bodies so a taxonomy word in
// prose/JSDoc (this file's own header, a design comment) is never mistaken for code. We
// keep the per-line `arch-allow: timeout-class` decision separate (it reads the RAW line).
function stripCommentary(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return "";
  }
  const commentIndex = line.indexOf("//");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

// Is this matched identifier blessed by the enumerated name allowlist? (substring of any
// allowlisted name's stem so MAX_NODE_TIMER_DELAY_MS etc. are honored when captured).
function isAllowlistedIdentifier(captured) {
  return timeoutIdentifierAllowlist.has(captured);
}

// Does the callback body of a `setTimeout(` at `openerIndex` contain a kill verb before its
// closing — i.e. is it a total-duration KILL timer (vs a benign deferred tick)? We scan the
// remainder of the line(s) up to the next `;` or newline-after-delay heuristically: the
// common forms are single-line `setTimeout(() => fail(...), ms)` and the multi-line
// `setTimeout(\n () => fail(...),\n ms,\n)`. We take a bounded window after the opener.
function timerBodyKills(code, openerIndex) {
  const window = code.slice(openerIndex, openerIndex + 240);
  return killVerb.test(window);
}

// The character spans (start..end) of every loop-cap head on a line. A give-up identifier
// whose match falls INSIDE one of these is the loop's bound — reported once as the loop cap,
// not also as a bare identifier.
function loopCapSpans(code) {
  const spans = [];
  for (const pattern of loopCapPatterns) {
    for (const match of code.matchAll(pattern)) {
      // The captured bound identifier (when allowlisted — e.g. the structural `maxIterations`
      // = batchSize + 1 — this is NOT a violation; record the span to suppress nested
      // identifier hits but do not flag the loop head).
      const blessed = match[1] !== undefined && isAllowlistedIdentifier(match[1]);
      spans.push({ start: match.index, end: match.index + match[0].length, blessed });
    }
  }
  return spans;
}

function withinAnySpan(index, spans) {
  return spans.some((span) => index >= span.start && index < span.end);
}

// Collect every timeout-class violation in one production-source line. A line may trip
// several; each DISTINCT construct is reported once (identifier-family matches dedupe by the
// captured identifier so overlapping patterns don't double-count). The per-line bless is
// applied by the caller.
function violationsInLine(code) {
  const found = [];
  for (const match of code.matchAll(killTimerOpener)) {
    if (timerBodyKills(code, match.index)) {
      found.push("total-duration kill timer (setTimeout that kills/fails/destroys/aborts) — use an ActivityWatchdog");
    }
  }
  const loopSpans = loopCapSpans(code);
  for (const span of loopSpans) {
    if (span.blessed) continue;
    found.push("fixed loop cap (attempt/poll/iteration max) — use retryUntilConverged (progress-based, unbounded)");
  }
  for (let i = [...code.matchAll(deadlinePattern)].length; i > 0; i -= 1) {
    found.push("whole-op wall-clock deadline (Date.now()+budget/deadline) — bound on progress, not elapsed time");
  }
  for (let i = [...code.matchAll(quietWindowPattern)].length; i > 0; i -= 1) {
    found.push("fixed quiet-window / no-output-for-N watchdog (a DISGUISED timeout) — use a LivenessProbe");
  }
  // Identifier families (banned declarations + give-up counters). Dedupe by the captured
  // identifier; a banned-family hit wins over a give-up hit for the same identifier; skip
  // allowlisted names and any identifier that is a loop-cap head's bound (counted above).
  found.push(...identifierViolations(code, loopSpans));
  return found;
}

// One pass over the identifier families: each distinct identifier yields at most one finding.
function identifierViolations(code, loopSpans) {
  // Map of identifier → detail, so each distinct identifier yields at most one finding.
  const seen = new Map();
  for (const pattern of bannedIdentifierPatterns) {
    for (const match of code.matchAll(pattern)) {
      const id = match[1];
      if (isAllowlistedIdentifier(id) || withinAnySpan(match.index, loopSpans)) continue;
      seen.set(id, `banned timeout/attempt-cap identifier '${id}' — replace with a progress-based primitive`);
    }
  }
  for (const match of code.matchAll(giveUpIdentifier)) {
    const id = match[1];
    if (isAllowlistedIdentifier(id) || withinAnySpan(match.index, loopSpans) || seen.has(id)) continue;
    seen.set(id, `give-up counter '${id}' — escalate on intelligent non-convergence, not a count`);
  }
  return [...seen.values()];
}

// The scanner. Returns one diagnostic per (line, violation). A line carrying the
// `// arch-allow: timeout-class …` annotation is exempt (its exemption is reviewable
// in-source — the annotation must justify why the construct is a legitimate
// cadence/interval/external bound and not a safety budget).
export function checkNoArbitraryTimeouts(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!isProductionSource(file)) {
      continue;
    }
    const lines = text.split("\n");
    for (const [index, rawLine] of lines.entries()) {
      if (rawLine.includes(ARCH_ALLOW)) {
        continue;
      }
      const code = stripCommentary(rawLine);
      for (const detail of violationsInLine(code)) {
        diagnostics.push(diagnostic(RULE, file, detail, index + 1));
      }
    }
  }
  return diagnostics;
}
