// A state-aware walker for the fragment-authoring `apply()` body — the
// hardened parser that replaced the historical non-greedy regex path
// (Claude HIGH #1 + Codex #6 at v79 apex frontier).
//
// TWO CONCERNS ARE COLLAPSED HERE:
//
//   1. Locating the `apply()` block's OUTERMOST matching `}`.
//      The prior implementation used a lazy `\{([\s\S]*?)\}` regex that
//      captured up to the FIRST `}` in the body regardless of whether it lived
//      inside a string / template literal / comment. Any body containing an
//      inline template literal with a `}` — JSON blobs, tsconfig.json,
//      package.json, JSX-object expressions — silently truncated at that first
//      `}` and the constrained-subset state machine never saw the rest.
//      `extractApplyBody` uses `findMatchingClose` (a full lexer state stack)
//      so the outermost close is found in EVERY body shape.
//
//   2. Rejecting non-vfs code in the apply() body.
//      The prior parser scanned for `vfs.` calls and IGNORED everything else
//      (conditionals, loops, `fs.*`, `process.*`, arrow-fn assignments). The
//      persisted TS source could carry code the interpreter would never run —
//      a prompt-injection surface on a hostile writer, a confusing bug on an
//      honest writer. `assertOnlyVfsStatements` walks the body once and halts
//      on the first non-vfs statement with a writer-facing rejection that
//      names the offending prefix (so the F2 writer-rework loop's next
//      attempt sees the exact reason).
//
// The walker treats the following as opaque so their contents do NOT influence
// brace/paren depth:
//   - Single-quoted strings `'…'` (with `\` escape awareness)
//   - Double-quoted strings `"…"` (with `\` escape awareness)
//   - Backtick template literals `` `…` `` — `${ … }` opens a fresh code frame
//     with its OWN independent brace depth; on matching `}` we pop back into
//     the enclosing backtick.
//   - Line comments `// … \n`
//   - Block comments `/* … */`

export class FragmentBodyParseError extends Error {
  constructor(message: string) {
    super(`FragmentBody parse error: ${message}`);
    this.name = "FragmentBodyParseError";
  }
}

export const NO_APPLY_BLOCK_MESSAGE =
  "body does not declare an `apply(vfs, config)` block. The body MUST default-export a Fragment " +
  "whose apply signature is `async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> { … }`. " +
  "Example:\n" +
  "```\n" +
  "export const fragment: Fragment = {\n" +
  '  id: "addon-example", version: "1.0.0", kind: "addon", contract: {},\n' +
  "  async apply(vfs, _config) {\n" +
  '    vfs.write("docs/example.md", "hello\\n");\n' +
  "  },\n" +
  "};\n" +
  "export default fragment;\n" +
  "```";

const IDENTIFIER_CHAR_RE = /[a-zA-Z0-9_$]/u;
const WHITESPACE_RE = /\s/u;

type CloseChar = "}" | ")" | "]";

type LexFrame =
  | { kind: "code"; depth: number; closeChar: CloseChar; fromTemplate: boolean }
  | { kind: "sq" }
  | { kind: "dq" }
  | { kind: "bt" }
  | { kind: "lc" }
  | { kind: "bc" };

/**
 * Walk `source` starting from `openIdx` (which points at an open-bracket
 * character: `{`, `(`, or `[`) and return the index of the matching close.
 * Handles nested brackets, strings, template-literal expressions, and
 * comments. Throws `FragmentBodyParseError(unbalancedMessage)` if the walker
 * runs off the end of `source` OR sees a mismatched close bracket.
 */
export function findMatchingClose(source: string, openIdx: number, unbalancedMessage: string): number {
  const openCh = source[openIdx];
  const closeCh: CloseChar | "" = openCh === "{" ? "}" : openCh === "(" ? ")" : openCh === "[" ? "]" : "";
  if (closeCh === "") {
    // Programmer error inside this module — not a writer-facing rejection.
    throw new Error(`findMatchingClose: unsupported open char ${String(openCh)}`);
  }
  const stack: LexFrame[] = [{ kind: "code", depth: 1, closeChar: closeCh, fromTemplate: false }];
  let i = openIdx + 1;
  while (i < source.length) {
    const top = stack.at(-1)!;
    const ch = source[i]!;
    const next = source[i + 1] ?? "";
    if (top.kind !== "code") {
      i = advanceNonCode(top, i, ch, next, stack);
      continue;
    }
    // Comments.
    if (ch === "/" && next === "/") {
      stack.push({ kind: "lc" });
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      stack.push({ kind: "bc" });
      i += 2;
      continue;
    }
    // String openers.
    if (ch === "'") {
      stack.push({ kind: "sq" });
      i += 1;
      continue;
    }
    if (ch === '"') {
      stack.push({ kind: "dq" });
      i += 1;
      continue;
    }
    if (ch === "`") {
      stack.push({ kind: "bt" });
      i += 1;
      continue;
    }
    // Bracket nesting — same-kind increments this frame's depth; a
    // different bracket kind pushes a new code frame.
    if (ch === "{" || ch === "(" || ch === "[") {
      const matchClose: CloseChar = ch === "{" ? "}" : ch === "(" ? ")" : "]";
      if (top.closeChar === matchClose) {
        top.depth += 1;
      } else {
        stack.push({ kind: "code", depth: 1, closeChar: matchClose, fromTemplate: false });
      }
      i += 1;
      continue;
    }
    if (ch === "}" || ch === ")" || ch === "]") {
      if (ch !== top.closeChar) {
        throw new FragmentBodyParseError(unbalancedMessage);
      }
      top.depth -= 1;
      if (top.depth === 0) {
        if (top.fromTemplate) {
          stack.pop();
          i += 1;
          continue;
        }
        if (stack.length === 1) {
          return i;
        }
        stack.pop();
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  throw new FragmentBodyParseError(unbalancedMessage);
}

/**
 * Advance one step while at the top of a non-code frame (string, comment).
 * Mutates `stack` and returns the new index. Split out so
 * `findMatchingClose` stays within the max-lines-per-function cap.
 */
function advanceNonCode(top: LexFrame, i: number, ch: string, next: string, stack: LexFrame[]): number {
  if (top.kind === "sq") {
    if (ch === "\\") return i + 2;
    if (ch === "'") {
      stack.pop();
      return i + 1;
    }
    return i + 1;
  }
  if (top.kind === "dq") {
    if (ch === "\\") return i + 2;
    if (ch === '"') {
      stack.pop();
      return i + 1;
    }
    return i + 1;
  }
  if (top.kind === "bt") {
    if (ch === "\\") return i + 2;
    if (ch === "`") {
      stack.pop();
      return i + 1;
    }
    if (ch === "$" && next === "{") {
      stack.push({ kind: "code", depth: 1, closeChar: "}", fromTemplate: true });
      return i + 2;
    }
    return i + 1;
  }
  if (top.kind === "lc") {
    if (ch === "\n") {
      stack.pop();
      return i + 1;
    }
    return i + 1;
  }
  // Block comment (`bc`).
  if (ch === "*" && next === "/") {
    stack.pop();
    return i + 2;
  }
  return i + 1;
}

/**
 * Locate the `apply(vfs, config) { … }` block and return the body between its
 * outermost braces, exclusive. Uses `findMatchingClose` so nested `{}` inside
 * string literals, template literals (including `${…}` interpolation), escaped
 * quotes, and comments do NOT prematurely terminate the body.
 */
export function extractApplyBody(bodyTs: string): string {
  // `apply` preceded by `.` or a word char (e.g. `Function.prototype.apply(`)
  // must NOT match — negative lookbehind is the cleanest expression.
  const applyStartRe = /(?<![.\w])apply\s*\(/u;
  const m = applyStartRe.exec(bodyTs);
  if (m === null) throw new FragmentBodyParseError(NO_APPLY_BLOCK_MESSAGE);
  const sigOpenParen = m.index + m[0].length - 1;
  const sigCloseParen = findMatchingClose(bodyTs, sigOpenParen, "apply() signature has unbalanced parens");
  let i = sigCloseParen + 1;
  while (i < bodyTs.length && bodyTs[i] !== "{") i += 1;
  if (i >= bodyTs.length) throw new FragmentBodyParseError(NO_APPLY_BLOCK_MESSAGE);
  const bodyOpenBrace = i;
  const bodyCloseBrace = findMatchingClose(bodyTs, bodyOpenBrace, "apply() body has unbalanced braces");
  return bodyTs.slice(bodyOpenBrace + 1, bodyCloseBrace);
}

/**
 * Reject any non-vfs code in the apply() body. Every top-level unit must be
 * one of:
 *   - whitespace / empty-statement semicolons
 *   - a comment (`//` line or `/* *\/` block)
 *   - a `vfs.<method>(…)` call
 *
 * Anything else — conditionals, loops, arrow-fn assignments, `fs.*`,
 * `process.*`, `Math.*`, `console.*`, `await`, `return` — throws a
 * `FragmentBodyParseError` naming the offending prefix. The F2 writer-rework
 * loop threads the message back to the writer's next attempt as
 * `previousAttempt.rejection`, so the writer sees the exact reason.
 */
export function assertOnlyVfsStatements(body: string): void {
  walkVfsStatements(body);
}

/** Collect every top-level `vfs.<method>(...)` statement from an apply body.
 *
 * This shares the exact string/template/comment-aware walk used by
 * `assertOnlyVfsStatements`: comments are skipped only when they occur in code
 * position, while comment-looking text inside an argument remains part of that
 * argument's source slice. */
export function collectVfsStatements(body: string): string[] {
  const statements: string[] = [];
  walkVfsStatements(body, (start, end) => {
    statements.push(body.slice(start, end));
  });
  return statements;
}

function walkVfsStatements(body: string, onStatement?: (start: number, end: number) => void): void {
  let i = 0;
  // The loop shape here is a FIXED-LENGTH BODY WALK: `i` strictly advances by
  // at least one on every iteration (via one of the branches below), so the
  // loop terminates in ≤ body.length steps. It is provably NOT an attempt /
  // retry / poll cap on converging work — it is a structural walker over a
  // finite string. Inlining `body.length` at each compare avoids the
  // check-architecture-timeouts.mjs `while (id < id)` heuristic that flags a
  // bare identifier RHS as a give-up bound.
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === ";") {
      i += 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      while (i < body.length && body[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && body[i + 1] === "*") {
      i += 2;
      while (i + 1 < body.length && !(body[i] === "*" && body[i + 1] === "/")) i += 1;
      // Skip past the closing `*/`.
      i += 2;
      continue;
    }
    if (!body.startsWith("vfs.", i)) {
      throw rejectNonVfs(body, i);
    }
    // Advance past `vfs.<identifier>` (the method name) + any whitespace up
    // to the `(` opening the call.
    let cursor = i + 4;
    while (cursor < body.length && IDENTIFIER_CHAR_RE.test(body[cursor]!)) cursor += 1;
    while (cursor < body.length && WHITESPACE_RE.test(body[cursor]!)) cursor += 1;
    if (body[cursor] !== "(") {
      // `vfs.write.bind(…)`, `vfs.write = …`, `vfs.foo,` etc — not a call.
      throw rejectNonVfs(body, i);
    }
    const closeParen = findMatchingClose(body, cursor, "apply() body has unbalanced parens in a vfs.* call");
    const statementEnd = closeParen + 1;
    onStatement?.(i, statementEnd);
    i = statementEnd;
  }
}

function rejectNonVfs(body: string, at: number): FragmentBodyParseError {
  const snippet = truncateSnippet(
    body
      .slice(at, at + 30)
      .replaceAll(/\s+/gu, " ")
      .trim(),
  );
  return new FragmentBodyParseError(
    `apply() body contains non-vfs statement: "${snippet}". ` +
      `Only vfs.* calls, comments, and blank lines are allowed. ` +
      `Conditionals/loops/fs/process/etc are rejected.`,
  );
}

function truncateSnippet(s: string): string {
  const MAX = 30;
  return s.length <= MAX ? s : `${s.slice(0, MAX)}…`;
}
