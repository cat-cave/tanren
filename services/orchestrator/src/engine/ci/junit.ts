// CI-intelligence ingestion (foundation): the JUnit XML report parser. CI today
// is read only at the check-run CONCLUSION level (per job, pass/fail) via the CI
// poller. To act on CI as a first-class signal — per-test flakiness, duration,
// retry hotspots — Tanren needs PER-TEST detail. The industry-standard mechanism
// is a JUnit XML report emitted by the test runner and uploaded from CI; this
// module parses that report into per-test rows.
//
// It is intentionally a SMALL, dependency-free parser scoped to the JUnit subset
// the major runners emit (vitest `--reporter=junit`, pytest `--junitxml`, go
// `gotestsum --junitfile`, Surefire). The orchestrator has no XML dependency in
// the lockfile; the supported shape is `<testsuites>/<testsuite>/<testcase>` with
// child `<failure>`/`<error>`/`<skipped>` and the Surefire intra-run-retry
// children (`<rerunFailure>`/`<flakyFailure>`). Anything malformed raises
// `JunitParseError` so the ingest endpoint fails LOUDLY (a 4xx) rather than
// silently dropping or mis-recording results — a runner that crashed after
// writing a clean-looking report must NOT be read as "all green".

/** A test outcome, normalized across runners. A bare `<testcase>` is a pass. */
export type JunitOutcome = "passed" | "failed" | "error" | "skipped";

/** One parsed test result (one `<testcase>`), keyed by a stable test id. */
export interface JunitTestResult {
  /**
   * Stable per-test identity: `classname` + "." + `name` when a classname is
   * present, else the bare `name`. This is the join key for per-test history
   * across runs/SHAs, so it must be deterministic from the report alone.
   */
  testId: string;
  /** The test source file when the runner reports it (`file=` attr), else null. */
  file: string | null;
  /** The owning `<testsuite name=>`, else null when the case has no suite. */
  suite: string | null;
  /** Normalized outcome (child failure/error/skipped sets it; bare = passed). */
  outcome: JunitOutcome;
  /** Wall-clock duration in ms, from the `time=` seconds attr (rounded), or null. */
  durationMs: number | null;
  /**
   * Intra-run retries observed for this case in THIS report — the Surefire
   * `<rerunFailure>`/`<rerunError>`/`<flakyFailure>`/`<flakyError>` children
   * count (a fail-then-pass / fail-then-fail recorded within one run). 0 when the
   * runner reported no reruns.
   */
  retries: number;
  /**
   * True when the case demonstrated a fail-then-pass WITHIN this run — Surefire
   * emits a passing `<testcase>` carrying `<flakyFailure>`/`<flakyError>`
   * children. This is single-run flakiness (distinct from cross-run flakiness,
   * which a later PR derives from the persisted history).
   */
  flakyFailure: boolean;
}

/** The whole parsed report: the per-test rows plus a few report-level totals. */
export interface JunitReport {
  results: JunitTestResult[];
  /** Total `<testcase>` count parsed (== `results.length`; surfaced for callers). */
  total: number;
  /** Count of cases whose normalized outcome is `failed` or `error`. */
  failures: number;
}

/** Raised on any malformed / unsupported report. The ingest path maps this to a 4xx. */
export class JunitParseError extends Error {
  constructor(message: string) {
    super(`JUnit report parse error: ${message}`);
    this.name = "JunitParseError";
  }
}

// ── Tiny XML tokenizer ──────────────────────────────────────────────────────
// A minimal, well-formedness-checking tokenizer for the element/attribute subset
// JUnit uses. It does NOT support namespaces, DOCTYPE, CDATA-as-markup, or
// processing beyond a leading `<?xml?>` declaration — anything outside the subset
// is rejected loudly. Text content between tags is ignored (failure detail lives
// in child-element presence, not text, for our needs).

type XmlNode = {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
};

interface Token {
  readonly kind: "open" | "close" | "selfclose";
  readonly name: string;
  readonly attrs: Record<string, string>;
}

const NAME_RE = /^[A-Za-z_][\w.-]*$/u;

function decodeEntities(raw: string): string {
  return raw.replaceAll(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named[body] ?? match;
  });
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/gu;
  let consumed = 0;
  let match: RegExpExecArray | null;
  for (match = re.exec(raw); match !== null; match = re.exec(raw)) {
    // Reject stray non-whitespace between attributes (malformed tag).
    const gap = raw.slice(consumed, match.index);
    if (gap.trim().length > 0) {
      throw new JunitParseError(`malformed attributes near ${JSON.stringify(gap.trim())}`);
    }
    const key = match[1] as string;
    const value = match[3] ?? match[4] ?? "";
    attrs[key] = decodeEntities(value);
    consumed = match.index + match[0].length;
  }
  if (raw.slice(consumed).trim().length > 0) {
    throw new JunitParseError(`malformed attributes near ${JSON.stringify(raw.slice(consumed).trim())}`);
  }
  return attrs;
}

function tokenize(xml: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    // Skip XML declaration and comments.
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt);
      if (end === -1) throw new JunitParseError("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt);
      if (end === -1) throw new JunitParseError("unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      throw new JunitParseError("DOCTYPE / declarations are not supported");
    }
    const gt = xml.indexOf(">", lt);
    if (gt === -1) throw new JunitParseError("unterminated tag");
    let body = xml.slice(lt + 1, gt).trim();
    if (body.length === 0) throw new JunitParseError("empty tag");
    const isClose = body.startsWith("/");
    const isSelfClose = !isClose && body.endsWith("/");
    if (isClose) body = body.slice(1).trim();
    if (isSelfClose) body = body.slice(0, -1).trim();
    const spaceIdx = firstWhitespace(body);
    const name = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    if (!NAME_RE.test(name)) throw new JunitParseError(`invalid element name ${JSON.stringify(name)}`);
    const attrText = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1);
    const attrs = isClose ? {} : parseAttributes(attrText);
    if (isClose && attrText.trim().length > 0) {
      throw new JunitParseError(`closing tag ${JSON.stringify(name)} must not carry attributes`);
    }
    tokens.push({ kind: isClose ? "close" : isSelfClose ? "selfclose" : "open", name, attrs });
    i = gt + 1;
  }
  return tokens;
}

function firstWhitespace(s: string): number {
  const m = /\s/u.exec(s);
  return m === null ? -1 : m.index;
}

function buildTree(tokens: Token[]): XmlNode {
  const roots: XmlNode[] = [];
  const stack: XmlNode[] = [];
  for (const token of tokens) {
    if (token.kind === "close") {
      const top = stack.pop();
      if (top === undefined || top.name !== token.name) {
        throw new JunitParseError(`mismatched closing tag ${JSON.stringify(token.name)}`);
      }
      continue;
    }
    const node: XmlNode = { name: token.name, attrs: token.attrs, children: [] };
    const parent = stack.at(-1);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    if (token.kind === "open") stack.push(node);
  }
  if (stack.length > 0) throw new JunitParseError(`unclosed tag ${JSON.stringify(stack.at(-1)?.name)}`);
  if (roots.length !== 1) throw new JunitParseError(`expected exactly one root element, found ${roots.length}`);
  return roots[0] as XmlNode;
}

// ── JUnit semantics ─────────────────────────────────────────────────────────

const RERUN_CHILDREN = new Set(["rerunFailure", "rerunError", "flakyFailure", "flakyError"]);
const FLAKY_CHILDREN = new Set(["flakyFailure", "flakyError"]);

function collectSuites(root: XmlNode): XmlNode[] {
  if (root.name === "testsuite") return [root];
  if (root.name !== "testsuites") {
    throw new JunitParseError(`root element must be <testsuites> or <testsuite>, got <${root.name}>`);
  }
  // <testsuites> may nest <testsuite> directly or under nested <testsuites>.
  const suites: XmlNode[] = [];
  const walk = (node: XmlNode): void => {
    for (const child of node.children) {
      if (child.name === "testsuite") suites.push(child);
      else if (child.name === "testsuites") walk(child);
    }
  };
  walk(root);
  return suites;
}

function parseDurationMs(timeAttr: string | undefined): number | null {
  if (timeAttr === undefined || timeAttr.trim() === "") return null;
  const seconds = Number.parseFloat(timeAttr);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new JunitParseError(`invalid testcase time ${JSON.stringify(timeAttr)}`);
  }
  return Math.round(seconds * 1000);
}

function outcomeFromChildren(testcase: XmlNode): JunitOutcome {
  // First non-rerun status child wins; a bare testcase (no status child) is a
  // pass. `<failure>` and `<error>` are distinct outcomes; `<skipped>` is skip.
  for (const child of testcase.children) {
    if (child.name === "failure") return "failed";
    if (child.name === "error") return "error";
    if (child.name === "skipped") return "skipped";
  }
  return "passed";
}

function buildTestId(classname: string | undefined, name: string): string {
  const cn = (classname ?? "").trim();
  return cn.length === 0 ? name : `${cn}.${name}`;
}

function parseTestcase(testcase: XmlNode, suiteName: string | null): JunitTestResult {
  const name = testcase.attrs["name"];
  if (name === undefined || name.trim().length === 0) {
    throw new JunitParseError("<testcase> is missing a non-empty name attribute");
  }
  const fileAttr = testcase.attrs["file"];
  const retries = testcase.children.filter((c) => RERUN_CHILDREN.has(c.name)).length;
  const flakyFailure = testcase.children.some((c) => FLAKY_CHILDREN.has(c.name));
  return {
    testId: buildTestId(testcase.attrs["classname"], name),
    file: fileAttr !== undefined && fileAttr.trim().length > 0 ? fileAttr : null,
    suite: suiteName,
    outcome: outcomeFromChildren(testcase),
    durationMs: parseDurationMs(testcase.attrs["time"]),
    retries,
    flakyFailure,
  };
}

/**
 * Parse a JUnit XML report string into per-test results. Throws `JunitParseError`
 * on any malformed or unsupported input (the LOUD-reject contract — the ingest
 * endpoint turns this into a 4xx so a broken report is never silently accepted).
 */
export function parseJunitReport(xml: string): JunitReport {
  if (typeof xml !== "string" || xml.trim().length === 0) {
    throw new JunitParseError("report body is empty");
  }
  const root = buildTree(tokenize(xml));
  const suites = collectSuites(root);
  const results: JunitTestResult[] = [];
  for (const suite of suites) {
    const suiteNameAttr = suite.attrs["name"];
    const suiteName = suiteNameAttr !== undefined && suiteNameAttr.trim().length > 0 ? suiteNameAttr : null;
    for (const child of suite.children) {
      if (child.name !== "testcase") continue;
      results.push(parseTestcase(child, suiteName));
    }
  }
  const failures = results.filter((r) => r.outcome === "failed" || r.outcome === "error").length;
  return { results, total: results.length, failures };
}
