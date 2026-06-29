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
//   (c) whole-op DEADLINES — `Date.now() + … (deadline|budget)` style expiries; also
//       LHS-name deadline ASSIGNMENTS (`const deadline = Date.now() + readyTimeoutMs;`)
//       and wall-clock kill COMPARISONS (`Date.now() >= deadline`) on their own lines.
//       The LHS-name binding + the comparison-only line are the disguised survivor task #31
//       (critic-arc R1 #2 / R2): the 5 cloud allocators wore the shape for 7 months
//       because the original same-line `Date.now()+…(deadline|budget)` heuristic scanned
//       past the keyword-before-`=` form.
//   (d) fixed QUIET-WINDOW / no-output-for-N watchdogs (disguised timeouts).
//   (e) banned IDENTIFIERS — DEFAULT_TIMEOUT_MS, *_TIMEOUT_MS = 600_000, maxWriterIter*,
//       maxRetriesPerTransient*, MAX_*_ATTEMPTS, maxRunHours, DEFAULT_TRIAL_TIMEOUT_MS, plus
//       the BARE retry-cap family (MAX_ATTEMPTS, RETRY_LIMIT, ATTEMPT_LIMIT, MAX_TRIES,
//       RETRY_CAP, ATTEMPT_CAP, RETRY_COUNT, MAX_RETRY_COUNT) — added task #41 / audit #672
//       because the prior suffix-only patterns required a leading qualifier.
//   (f) ssh2 connect-config `timeout:` (the apex v44 socket-LIFETIME idle bound).
//   (g) `AbortSignal.timeout(N)` — the standard-library wall-clock-kill primitive feeding
//       fetch / any abort-aware API (audit #672 evasion path). Aborts at exactly N ms
//       regardless of progress; the same doctrine status as a setTimeout-kill.
//   (h) `Promise.race(` against a wall-clock-kill timer — flagged when the multi-line
//       lookahead window contains a kill verb (`reject` / `throw` / `abort` / `destroy` /
//       `fail` / `terminate` / `timedOut`) (audit #672 evasion path). The legitimate
//       poll-with-wakeup shape (`Promise.race([sleep(ms), wakeSignal])`) has no kill verb
//       and is untouched.
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

// (c2) Deadline-shape ASSIGNMENT (task #31, critic-arc R1 #2 / R2 — the survivor the
// 5 cloud allocators wore for 7 months): a `const deadline = Date.now() + readyTimeoutMs;`
// where the deadline-class identifier is the LHS NAME of the assignment and the kill-verb
// comparison rides on a SEPARATE line `if (Date.now() >= deadline) throw …`. The original
// `deadlinePattern` above only matched when the deadline word was on the same line as the
// `Date.now() +` RHS — and the LHS-name form (`const deadline = ` keyword + name) scanned
// past it. Same blind-spot class as #638 (ssh2 `timeout:`) and #32 (multi-line setTimeout):
// a legitimate-looking opener line on its own, but the doctrine violation is the deadline
// binding itself. Catches any deadline-class LHS (deadline, budget, expir*, expiresAt,
// deadlineMs) bound to a `Date.now()`/`performance.now()` + ms expression — the construct
// itself is the violation, regardless of whether the kill verb is same-line or on a
// continuation line the scanner never reaches.
const deadlineAssignmentPattern =
  /\b(?:const|let|var)\s+(?:[A-Za-z_$][A-Za-z0-9_$]*)?(deadline|budget|expir|expiresAt|deadlineMs)[A-Za-z0-9_$]*\s*=\s*(?:Date\.now\(\)|performance\.now\(\))\s*\+/giu;

// (c3) `Date.now() >= X` (or `<=` / `<` / `>`) COMPARISON — the kill-verb companion to
// the deadline binding (the `if (Date.now() >= deadline) throw …` line). This catches
// the comparison even on its own line, so a stripped-down deadline construct cannot
// reintroduce itself just by separating the binding from the check. The KEEP-list bless
// (`// arch-allow: timeout-class …`) is honored on the comparison line — a handful of
// legitimate comparisons exist (token-TTL refresh-before-expiry windows where the wall
// clock IS the authoritative external bound, lease-expiry windows) and bless themselves
// at the call site via the per-line annotation.
const deadlineComparisonPattern = /(?:Date\.now\(\)|performance\.now\(\))\s*[<>]=?\s*[A-Za-z_$]/gu;

// (d) fixed quiet-window / no-output-for-N watchdog — a disguised timeout. Catches the
// "quiet"/"idle"/"noOutput"/"lastOutput" + a duration-ms identifier on one line.
const quietWindowPattern =
  /\b(quiet|idle|noOutput|lastOutput|sinceOutput|stallMs|inactivity)[A-Za-z0-9_$]*\s*(?:[<>]=?|=)\s*[A-Za-z0-9_$]*(?:Ms|MS|Millis|Timeout)\b/gu;

// (f) ssh2 connect-config socket idle-timeout — a DISGUISED wall-clock deadline on the
// running command. In ssh2 1.17.0, the `timeout` field in the connect config is forwarded
// to the underlying socket as socket.setTimeout (a connection-LIFETIME idle timeout), NOT
// a handshake-only bound. A `timeout:` in what looks like an object literal is therefore a
// banned wall-clock timer on a running command (apex v44 root cause, fixed in this PR).
// The pattern catches `timeout:` as an object-property assignment (with optional leading
// whitespace, a bare word `timeout` followed by `:`) — the shape of the ssh2 connect config
// field. The ONLY allowed option is `readyTimeout:` (handshake bound); use `keepaliveInterval`
// + `keepaliveCountMax` to detect a dead connection without killing a quiet-but-alive command.
const ssh2SocketIdleTimeoutPattern = /^\s*timeout\s*:/u;

// (g) `AbortSignal.timeout(N)` — the standard-library primitive that produces a
// wall-clock-kill AbortSignal (audit #672 evasion path). It is unambiguously a
// total-duration kill on a running operation: the signal aborts at exactly N ms regardless
// of progress. Same doctrine status as a setTimeout-kill — replace with an ActivityWatchdog
// over a progress signal, or for a discrete one-shot HTTP probe (the shape blessed at
// `fetchDeployTransport` / `fetchUrlReachabilityProbe`) document the bless at the call
// site via `// arch-allow: timeout-class`. The pattern catches the call expression
// directly so an inline `fetch(url, { signal: AbortSignal.timeout(5000) })` trips even
// when the `signal:` keyword and the abort site span a single line.
const abortSignalTimeoutPattern = /\bAbortSignal\s*\.\s*timeout\s*\(/gu;

// (h) `Promise.race(` with a kill-verb companion in the multi-line lookahead — the
// disguised wall-clock wait audit #672 surfaced. The KILL shape races a real op against a
// `setTimeout(...reject)` / `setTimeout(...throw)` so the wall-clock branch terminates
// the work (a total-duration kill on whichever side loses); the LEGITIMATE shape races a
// `sleep(intervalMs)` against a wake signal (poll-with-wakeup, both branches just resolve).
// We flag only when the opener line OR its lookahead window contains a kill verb —
// `reject`, `throw`, `abort`, `destroy`, `fail`, `terminate`, `timedOut`. The wakeup
// pattern has no kill verb and stays untouched. The per-line `// arch-allow: timeout-class`
// annotation on the opener OR within the lookahead window blesses the construct (the same
// multi-line bless the kill-timer scanner honors for oxfmt-shaped layouts).
const promiseRaceOpener = /\bPromise\s*\.\s*race\s*\(/gu;
const raceKillVerb = /\b(reject|throw|abort|destroy|fail|terminate|timedOut)\b/u;

// (e) banned identifier DECLARATIONS — the 600_000 timeout family + the attempt-cap family.
// Matches a const/let/field declaration of a name in the banned taxonomy.
const bannedIdentifierPatterns = [
  // *_TIMEOUT_MS constants (DEFAULT_TIMEOUT_MS, BASE_SHIFT_TIMEOUT_MS, DEFAULT_TRIAL_TIMEOUT_MS …)
  /\b([A-Z][A-Z0-9_]*_TIMEOUT_MS|DEFAULT_TIMEOUT_MS)\b/gu,
  // MAX_*_ATTEMPTS / *_MAX_ATTEMPTS screaming-case attempt caps.
  /\b(MAX_[A-Z0-9_]*_ATTEMPTS|[A-Z0-9_]*_MAX_ATTEMPTS)\b/gu,
  // Suffix-only attempt/retry caps the prior taxonomy missed (critic-arc R3 #3 caught
  // `TURN_INDEX_RETRY_ATTEMPTS` slipping through because it ends in `_RETRY_ATTEMPTS`,
  // not `_MAX_ATTEMPTS`). Also catch `*_RETRIES` for symmetry with the Slack/SSH families.
  /\b([A-Z][A-Z0-9_]*_RETRY_ATTEMPTS|[A-Z][A-Z0-9_]*_RETRIES)\b/gu,
  // camelCase max-iteration / retries-per / run-hours give-up knobs.
  /\b(maxWriterIter[A-Za-z0-9_$]*|maxRetriesPerTransient[A-Za-z0-9_$]*|maxRunHours[A-Za-z0-9_$]*|DEFAULT_[A-Z0-9_]*_MAX_ATTEMPTS)\b/gu,
  // BARE retry-cap identifiers the suffix-only patterns above don't catch (audit #672
  // evasion path). The prior taxonomy required a leading family qualifier (`MAX_X_ATTEMPTS`,
  // `FOO_RETRIES`), so a fresh module reintroducing `MAX_ATTEMPTS` / `RETRY_LIMIT` /
  // `MAX_TRIES` / `ATTEMPT_LIMIT` / `RETRY_CAP` / `ATTEMPT_CAP` / `RETRY_COUNT` scanned past
  // the gate. Enumerated to keep the surface explicit + reviewable (additions are loud).
  /\b(MAX_ATTEMPTS|RETRY_LIMIT|ATTEMPT_LIMIT|MAX_TRIES|RETRY_CAP|ATTEMPT_CAP|RETRY_COUNT|MAX_RETRY_COUNT)\b/gu,
];

function isProductionSource(file) {
  // Production source under any service's src/, plus the smoke/acceptance harnesses
  // under scripts/ (critic-arc R3 #4 caught a wall-clock deadline in
  // `scripts/smoke/plane-split-worker.ts` that the prior `/src/` filter excluded;
  // `just smoke` IS a required handoff gate so its timing primitives are doctrine
  // territory, not test-only fixture territory). Tests under either tree are still
  // excluded.
  const isUnderSrc = file.includes("/src/");
  const isHarness = file.includes("/scripts/smoke/") || file.includes("/scripts/acceptance/");
  if (!isUnderSrc && !isHarness) return false;
  return !file.includes("/tests/") && !/\.test\.[tj]sx?$/u.test(file);
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
//
// MULTI-LINE EXTENSION (task #32 — the disguised survivor `staticRunnerAllocator.ts`
// scanned past): when the opener's same-line window has NO kill verb, fall back to a
// SECOND scan over a small window of FOLLOWING source lines (the multi-line shape
// `setTimeout(\n () => reject(new Error(...)),\n timeoutMs,\n)`). Same blind spot as
// #638 (ssh2 connect-config `timeout:`) — a benign opener line on its own, but the kill
// verb landed on a continuation line the original single-line scan never read.
//
// MULTI-LINE BLESS: if the following-lines window itself carries the per-line
// `arch-allow: timeout-class` annotation, the multi-line kill-timer is treated as blessed
// (the annotation is reviewable in-source on a line the formatter respects). This lets a
// legitimate single-request fetch abort (a discrete one-shot whose only outcomes are
// `response | abort`) document its bless inside the callback body where oxfmt won't move it.
function timerBodyKills(code, openerIndex, rawFollowingLines = "", followingLines = "") {
  const sameLineWindow = code.slice(openerIndex, openerIndex + 240);
  if (killVerb.test(sameLineWindow)) {
    return true;
  }
  // Cap the multi-line window: a setTimeout callback that spans more than a handful of
  // following lines is exotic enough that we'd rather miss it than spuriously flag a
  // benign deferred tick whose callback unrelated text mentions one of the kill verbs.
  if (!killVerb.test(followingLines)) {
    return false;
  }
  // A multi-line kill timer carrying the per-line bless annotation on a body line is
  // blessed (the multi-line equivalent of the same-line `// arch-allow: timeout-class`).
  return !rawFollowingLines.includes(ARCH_ALLOW);
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
// applied by the caller. `followingLines` is the small look-ahead window the multi-line
// `setTimeout(\n …\n)` scan reads — passed through from the file scanner; `rawFollowingLines`
// is the same window UNSTRIPPED so the multi-line bless annotation is honored.
function violationsInLine(code, rawFollowingLines = "", followingLines = "") {
  const found = [];
  for (const match of code.matchAll(killTimerOpener)) {
    if (timerBodyKills(code, match.index, rawFollowingLines, followingLines)) {
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
  // (c2) LHS-name deadline ASSIGNMENT — `const deadline = Date.now() + readyTimeoutMs;`
  // (task #31, critic-arc R1 #2 / R2). The original (c) above misses the keyword-before-`=`
  // form because the deadline word is the LHS NAME, not on the RHS of `Date.now() +`.
  for (let i = [...code.matchAll(deadlineAssignmentPattern)].length; i > 0; i -= 1) {
    found.push(
      "deadline-shape assignment (const/let deadline|budget|expir* = Date.now()+ms) — " +
        "bind on progress (a STRUCTURAL signature that ADVANCES while work is happening), not on elapsed time",
    );
  }
  // (c3) `Date.now() >= X` style COMPARISON — the kill-verb companion to the deadline
  // binding, often on its own line `if (Date.now() >= deadline) throw …`. A separate
  // pattern so a stripped-down deadline construct cannot reintroduce itself by separating
  // the binding from the check.
  for (let i = [...code.matchAll(deadlineComparisonPattern)].length; i > 0; i -= 1) {
    found.push(
      "wall-clock kill comparison (Date.now() >=/</> X) — the kill-verb companion to a deadline " +
        "binding; bound on progress (a STRUCTURAL signature) rather than the wall clock",
    );
  }
  for (let i = [...code.matchAll(quietWindowPattern)].length; i > 0; i -= 1) {
    found.push("fixed quiet-window / no-output-for-N watchdog (a DISGUISED timeout) — use a LivenessProbe");
  }
  if (ssh2SocketIdleTimeoutPattern.test(code)) {
    found.push(
      "ssh2 connect-config `timeout:` is a socket-LIFETIME idle timeout (NOT a handshake bound) — a DISGUISED" +
        " wall-clock deadline on the running command (apex v44 root cause); remove it and use `keepaliveInterval`" +
        " + `keepaliveCountMax` to detect a dead connection without killing a quiet-but-alive command",
    );
  }
  // (g) `AbortSignal.timeout(N)` — a primitive wall-clock kill (audit #672 evasion path).
  // Each occurrence is its own finding; bless at the call site via `// arch-allow:
  // timeout-class` for a documented discrete one-shot (the per-line annotation overrides).
  for (let i = [...code.matchAll(abortSignalTimeoutPattern)].length; i > 0; i -= 1) {
    found.push(
      "AbortSignal.timeout(N) is a wall-clock kill primitive — it aborts at exactly N ms regardless of progress;" +
        " use an ActivityWatchdog (progress-based) instead, or bless a discrete one-shot HTTP probe with" +
        " `// arch-allow: timeout-class` at the call site",
    );
  }
  // (h) `Promise.race(` with a kill verb in the multi-line lookahead — the disguised
  // wall-clock wait (audit #672 evasion path). The legitimate poll-with-wakeup shape
  // (a sleep raced with a wake signal — both branches just resolve) has no kill verb in
  // its window and stays untouched.
  for (const match of code.matchAll(promiseRaceOpener)) {
    if (!isRaceWallClockKill(code, match.index, rawFollowingLines, followingLines)) continue;
    found.push(
      "Promise.race against a wall-clock timer (a setTimeout that rejects/throws/aborts) — a disguised" +
        " total-duration kill on the racing op; use an ActivityWatchdog over a progress signal, or, for a" +
        " documented discrete one-shot, bless the construct with `// arch-allow: timeout-class`",
    );
  }
  // Identifier families (banned declarations + give-up counters). Dedupe by the captured
  // identifier; a banned-family hit wins over a give-up hit for the same identifier; skip
  // allowlisted names and any identifier that is a loop-cap head's bound (counted above).
  found.push(...identifierViolations(code, loopSpans));
  return found;
}

// Does the `Promise.race(` at `openerIndex` race against a wall-clock-kill timer? We
// check the opener line's same-statement window AND the multi-line lookahead window for
// a kill verb (`reject`/`throw`/`abort`/`destroy`/`fail`/`terminate`/`timedOut`). The
// legitimate poll-with-wakeup shape has neither side throwing, so its window matches no
// kill verb. A multi-line construct whose body line carries the per-line bless annotation
// is honored — same mechanism as the kill-timer scanner's multi-line bless.
function isRaceWallClockKill(code, openerIndex, rawFollowingLines = "", followingLines = "") {
  const sameLineWindow = code.slice(openerIndex, openerIndex + 240);
  if (raceKillVerb.test(sameLineWindow)) {
    return true;
  }
  if (!raceKillVerb.test(followingLines)) {
    return false;
  }
  return !rawFollowingLines.includes(ARCH_ALLOW);
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

// How many lines after a `setTimeout(` opener the multi-line kill-body scan reads. Small
// enough that we don't false-flag on a benign deferred tick whose distant continuation
// happens to mention a kill verb, large enough to catch the realistic multi-line shape
// (the disguised survivor in `staticRunnerAllocator.ts` had the reject on the line
// IMMEDIATELY after the opener; 4 is comfortable headroom).
const MULTI_LINE_TIMER_LOOKAHEAD = 4;

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
      // The small lookahead window the multi-line setTimeout kill-body scan reads.
      // We strip commentary on each window line so a kill verb in prose (a JSDoc on a
      // following line) cannot trip the multi-line fallback. We also keep the RAW window
      // so the multi-line bless annotation (an `// arch-allow: timeout-class` on a body
      // line the formatter respects) is honored.
      const rawWindow = lines.slice(index + 1, index + 1 + MULTI_LINE_TIMER_LOOKAHEAD);
      const rawFollowingLines = rawWindow.join("\n");
      const followingLines = rawWindow.map((nextLine) => stripCommentary(nextLine)).join("\n");
      for (const detail of violationsInLine(code, rawFollowingLines, followingLines)) {
        diagnostics.push(diagnostic(RULE, file, detail, index + 1));
      }
    }
  }
  return diagnostics;
}
