import { dirname, relative, resolve } from "node:path";

// Structural architecture checks (Track B wave 3). These are heuristic,
// AST-light scanners that mirror the style of check-architecture.mjs: regex +
// brace matching, no parser. Each rule is a non-regressing RATCHET — the
// thresholds are pinned at (or just above) the current repo maximum so existing
// code passes today, and are meant to be tightened in later waves as the
// flagged hotspots are refactored. See docs/contracts/architecture-checks.md.

// The two critical paths these structural caps guard. Keep in sync with the
// directory list documented in the architecture-checks contract.
const criticalDirs = ["services/orchestrator/src/engine/workflow/", "services/orchestrator/src/engine/answerers/"];

// --- thresholds (ratchets) ---------------------------------------------------
// Cyclomatic complexity: measured current max is 23 (the runPlannerLoopWorkflow
// orchestration entrypoint in engine/workflow/plannerRun.ts). The cap sits just
// above it so the repo passes; tighten toward ~15 as plannerRun is decomposed.
export const COMPLEXITY_CAP = 25;
// Max params: measured current max is 6 (a step helper in engine/workflow/
// helloRun.ts). The cap is pinned at the current max — anything that would push
// a new function past 6 params must thread an options object instead.
export const MAX_PARAMS_CAP = 6;

// Workspace package roots (mirrors pnpm-workspace.yaml). A relative import that
// resolves into a DIFFERENT package's tree is a deep cross-package import and
// must go through that package's public entry instead.
const packageRoots = ["cli", "db", "services/allocator", "services/dashboard", "services/orchestrator"];

// Deep cross-package imports that are knowingly tolerated. Empty today: the two
// historical violations (orchestrator state tests reaching db/src/stateEnums)
// were fixed by re-exporting stateEnumLists from the @tanren/db entry. Add an
// entry here only with a matching note in the architecture-checks contract.
const deepImportAllowlist = new Set();

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

function inCriticalDir(file) {
  return criticalDirs.some((dir) => file.startsWith(dir));
}

function isTestFile(file) {
  return file.endsWith(".test.ts") || file.endsWith(".test.tsx");
}

// Find the index of the `}` that closes the block whose opening `{` is at
// `openIndex`, by simple brace matching. Returns -1 if unbalanced.
function matchBrace(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

// Locate function bodies heuristically: arrow functions with a block body and
// `function` declarations/expressions. Each head captures its parameter list
// and the index of the opening brace of the body.
function findFunctions(text) {
  const heads = [];
  const arrowPattern = /\(([^()]*)\)\s*(?::\s*[^=>{;]+)?=>\s*\{/gu;
  const funcPattern = /\bfunction\b\s*[A-Za-z0-9_$]*\s*\(([^()]*)\)\s*(?::\s*[^{]+)?\{/gu;
  for (const pattern of [arrowPattern, funcPattern]) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const open = pattern.lastIndex - 1;
      const end = matchBrace(text, open);
      if (end === -1) {
        continue;
      }
      heads.push({ params: match[1] ?? "", open, end, index: match.index });
    }
  }
  return heads;
}

// Heuristic cyclomatic complexity: 1 + one per branching token. The token set
// matches the contract: if, case (covers switch arms + else-if chains via the
// `if`), &&, ||, ternary ?, catch, for, while. `??`, `?.`, and `?:` are NOT
// branches and are excluded from the ternary match.
function complexityOf(body) {
  let score = 1;
  for (const pattern of [
    /\bif\b/gu,
    /\bcase\b/gu,
    /\bcatch\b/gu,
    /\bfor\b/gu,
    /\bwhile\b/gu,
    /&&/gu,
    /\|\|/gu,
    /\?(?![?.:])/gu,
  ]) {
    score += (body.match(pattern) ?? []).length;
  }
  return score;
}

// Count top-level parameters in a parameter-list string by splitting on commas
// at bracket depth zero (so object/array/generic params count once).
function paramCount(params) {
  const trimmed = params.trim().replace(/,\s*$/u, "");
  if (trimmed === "") {
    return 0;
  }
  let depth = 0;
  let count = 1;
  for (const char of trimmed) {
    if ("([{<".includes(char)) {
      depth += 1;
    } else if (")]}>".includes(char)) {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      count += 1;
    }
  }
  return count;
}

export function checkCyclomaticComplexity(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!inCriticalDir(file) || isTestFile(file)) {
      continue;
    }
    for (const head of findFunctions(text)) {
      const score = complexityOf(text.slice(head.open, head.end + 1));
      if (score > COMPLEXITY_CAP) {
        diagnostics.push(
          diagnostic(
            "cyclomatic-complexity-cap",
            file,
            `function complexity ${score} exceeds the ${COMPLEXITY_CAP} cap (ratchet: decompose toward simpler branches)`,
            lineFor(text, head.index),
          ),
        );
      }
    }
  }
  return diagnostics;
}

export function checkMaxParams(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!inCriticalDir(file) || isTestFile(file)) {
      continue;
    }
    for (const head of findFunctions(text)) {
      const count = paramCount(head.params);
      if (count > MAX_PARAMS_CAP) {
        diagnostics.push(
          diagnostic(
            "max-params-cap",
            file,
            `function takes ${count} params exceeding the ${MAX_PARAMS_CAP} cap (ratchet: pass an options object instead)`,
            lineFor(text, head.index),
          ),
        );
      }
    }
  }
  return diagnostics;
}

// --- behavior-based tests (no implementationy tests) -------------------------
// A test block that ONLY checks how a collaborator was called (spy call counts:
// toHaveBeenCalled*, .mock.calls) — with no co-located assertion on an
// observable outcome (returned/printed value, HTTP status/body, persisted
// state) — is coupled to the implementation, not the behavior. Require every
// block that contains a mock-call assertion to ALSO contain at least one
// outcome assertion. Separately, freeze module mocking (`vi.mock(`) at the
// current count of zero. See docs/contracts/architecture-checks.md
// (Behavior-based tests). Heuristic, brace-matched, line-scanner — no parser.

// Assertions that observe a real outcome (value / state / response / render),
// the opposite of a spy-call assertion. Match the matcher token broadly so new
// outcome matchers don't need to be enumerated one-by-one.
const outcomeAssertionPatterns = [
  /\.toBe\b/u,
  /\.toEqual\b/u,
  /\.toStrictEqual\b/u,
  /\.toMatch\b/u,
  /\.toMatchObject\b/u,
  /\.toMatchInlineSnapshot\b/u,
  /\.toMatchSnapshot\b/u,
  /\.toContain\b/u,
  /\.toContainEqual\b/u,
  /\.toThrow\b/u,
  /\.toBeDefined\b/u,
  /\.toBeUndefined\b/u,
  /\.toBeNull\b/u,
  /\.toBeTruthy\b/u,
  /\.toBeFalsy\b/u,
  /\.toBeGreaterThan/u,
  /\.toBeLessThan/u,
  /\.toBeInstanceOf\b/u,
  /\.toHaveProperty\b/u,
  /\.toHaveLength\b/u,
  /\.resolves\b/u,
  /\.rejects\b/u,
  /\.status\b/u,
  /\.json\(/u,
];

// Spy-call ("implementationy") assertions: how a collaborator was invoked.
const mockCallAssertionPatterns = [/\.toHaveBeenCalled/u, /\.mock\.calls\b/u];

// Files permitted to use `vi.mock(` module mocking. Currently empty — module
// mocking is frozen. Adding an entry requires a matching note in the
// architecture-checks contract.
const moduleMockAllowlist = new Set();

// Find `it(`/`test(` block bodies: locate the call, then the first `{` that
// opens its callback body (after a `=> {` or `function (...) {`), and brace
// match it. Returns the head index (for line reporting) and body text.
function findTestBlocks(text) {
  const blocks = [];
  const blockStart = /\b(?:it|test)\s*(?:\.\s*(?:each|skip|only|todo|concurrent|fails)\b[^(]*)?\(/gu;
  let match;
  while ((match = blockStart.exec(text)) !== null) {
    const bodyOpen = text.indexOf("=> {", match.index);
    const funcOpen = text.slice(match.index).search(/function\b[^(]*\([^)]*\)\s*\{/u);
    let open = -1;
    if (bodyOpen !== -1) {
      open = text.indexOf("{", bodyOpen);
    }
    if (funcOpen !== -1) {
      const absolute = match.index + funcOpen;
      const braceAfterFunc = text.indexOf("{", absolute);
      if (open === -1 || (braceAfterFunc !== -1 && braceAfterFunc < open)) {
        open = braceAfterFunc;
      }
    }
    if (open === -1) {
      continue;
    }
    const end = matchBrace(text, open);
    if (end === -1) {
      continue;
    }
    blocks.push({ index: match.index, body: text.slice(open, end + 1) });
  }
  return blocks;
}

export function checkNoMockOnlyTests(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!isTestFile(file) || file === "scripts/check-architecture.test.ts") {
      continue;
    }
    if (!moduleMockAllowlist.has(file)) {
      const viMock = /\bvi\s*\.\s*mock\s*\(/gu;
      let mockMatch;
      while ((mockMatch = viMock.exec(text)) !== null) {
        diagnostics.push(
          diagnostic(
            "no-mock-only-tests",
            file,
            "module mocking via vi.mock(...) is frozen (allowlist is empty); test the behavior through a seam/stub instead",
            lineFor(text, mockMatch.index),
          ),
        );
      }
    }
    for (const block of findTestBlocks(text)) {
      const hasMockCall = mockCallAssertionPatterns.some((pattern) => pattern.test(block.body));
      if (!hasMockCall) {
        continue;
      }
      const hasOutcome = outcomeAssertionPatterns.some((pattern) => pattern.test(block.body));
      if (!hasOutcome) {
        diagnostics.push(
          diagnostic(
            "no-mock-only-tests",
            file,
            "test asserts only on mock-call expectations; add an observable-outcome assertion (returned/printed value, HTTP status/body, persisted state)",
            lineFor(text, block.index),
          ),
        );
      }
    }
  }
  return diagnostics;
}

function packageOf(file) {
  return packageRoots.find((root) => file === root || file.startsWith(`${root}/`));
}

// Flag imports that reach into another workspace package's internals rather
// than its public entry: bare `@tanren/<pkg>/src/...` specifiers, and relative
// specifiers that resolve into a DIFFERENT package's tree.
export function checkCrossPackageDeepImports(projectFiles) {
  const diagnostics = [];
  const importPattern = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/gu;
  for (const { file, text } of projectFiles) {
    if (!(file.endsWith(".ts") || file.endsWith(".tsx")) || file.includes("/dist/")) {
      continue;
    }
    // The scripts/ checker carries its own unit tests, whose fixtures embed
    // deep-import specifier strings as test data; skip the checker's tests so
    // those fixtures aren't mistaken for real imports.
    if (file === "scripts/check-architecture.test.ts") {
      continue;
    }
    const ownPackage = packageOf(file);
    let match;
    while ((match = importPattern.exec(text)) !== null) {
      const specifier = match[1];
      const line = lineFor(text, match.index);
      if (deepImportAllowlist.has(`${file} -> ${specifier}`)) {
        continue;
      }
      if (/^@tanren\/[a-z-]+\/src\//u.test(specifier)) {
        diagnostics.push(
          diagnostic(
            "cross-package-deep-import",
            file,
            `deep import "${specifier}" must go through the package's public entry`,
            line,
          ),
        );
        continue;
      }
      if (specifier.startsWith(".") && ownPackage !== undefined) {
        const target = relative(".", resolve(dirname(file), specifier))
          .split("\\")
          .join("/");
        const targetPackage = packageOf(target);
        if (targetPackage !== undefined && targetPackage !== ownPackage) {
          diagnostics.push(
            diagnostic(
              "cross-package-deep-import",
              file,
              `relative import "${specifier}" reaches into ${targetPackage}; import via its package entry instead`,
              line,
            ),
          );
        }
      }
    }
  }
  return diagnostics;
}

export function runStructureChecks(projectFiles) {
  return [
    ...checkCyclomaticComplexity(projectFiles),
    ...checkMaxParams(projectFiles),
    ...checkCrossPackageDeepImports(projectFiles),
    ...checkNoMockOnlyTests(projectFiles),
  ];
}
