// FUNCTIONAL-TEST RECOGNIZER — the compose-time smoke check that the load-bearing
// "strong behavior tie-ins to tests" constraint (docs/roadmap/templating-system.md
// §PR-B NB-1) is honored. Split out of `compose.ts` (apex v72 fix — task #144) so
// the recognizer can grow language coverage without pushing compose.ts past the
// 500-line architecture cap.
//
// A composed VFS is ACCEPTED when either:
//   (Pass A) at least one `features/**.feature` contains a `Scenario:` block, OR
//   (Pass B) at least one candidate test file contains a meaningful assertion.
//
// Recognized test-file forms (Pass B). The location + extension shape declares
// the flavor; the content check enforces the assertion.
//   - TypeScript/JavaScript (vitest/jest): `tests/**.test.ts(x)` with
//     `expect(...).toBe|toEqual|toContain|toMatch|…` — truthy-only matchers
//     (`toBe(true)`, `.toBeTruthy()`, `.toBeDefined()`) do NOT count on their own.
//   - Ruby (RSpec): `spec/**_spec.rb` with `expect(...).to <matcher>`.
//   - Go (`*_test.go` at ANY depth — Go idiom co-locates tests with source):
//     requires the `func TestXxx(t *testing.T)` signature AND one of
//     `t.Errorf/Error/Fatal/Fatalf/Fail/FailNow`, testify `assert.*`/`require.*`,
//     or the `if got != want { t.Errorf(...) }` bare-compare pattern.
//   - Python (`test_*.py` OR `*_test.py` at any depth): requires a `def test_`
//     marker AND either a bare `assert <expr>` statement (pytest) or a
//     `self.assertXxx(…)` call (unittest).
//   - Rust (`tests/**.rs`): requires a `#[test]` (or `#[tokio::test]`/`#[async_std::test]`)
//     attribute AND an `assert!` / `assert_eq!` / `assert_ne!` / `assert_matches!` macro.
//
// A path that matches the base's skeleton set (`tests/mutation-baseline.test.ts`,
// `tests/functional-demo.test.ts`, `tests/.gitkeep`) is EXCLUDED from the count —
// those are structural surface, not behavioral evidence.
//
// The paired fail-fast in `fragmentAuthoringRun.ts` (`deriveRuntimeLanguage`)
// refuses to KICK OFF authoring for a runtime whose target language has no
// entry above (Kotlin, Haskell, etc). Otherwise the LLM would burn attempts on
// the same "no meaningful test" rejection until the writer-rework fixed point.

// Base skeleton paths — the recognizer must NOT count these. Overwriting these
// is caught elsewhere (assertBaseInvariantsHeld); here we only guard the count.
export const BASE_SKELETON_TEST_PATHS: ReadonlySet<string> = new Set([
  "tests/.gitkeep",
  "tests/mutation-baseline.test.ts",
  "tests/functional-demo.test.ts",
]);

// ── Cucumber (Pass A) ───────────────────────────────────────────────────────

export const SCENARIO_HEADER = /^\s*Scenario(?:\s+Outline)?\s*:\s*\S/mu;

// ── TS/JS matchers ──────────────────────────────────────────────────────────

const MEANINGFUL_MATCHER =
  /\.(?:toBe|toEqual|toStrictEqual|toContain|toContainEqual|toMatch|toMatchObject|toHaveLength|toHaveProperty|toThrow|toThrowError|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual|toBeCloseTo|toBeInstanceOf|toHaveBeenCalled|toHaveBeenCalledWith|toHaveBeenCalledTimes|resolves|rejects)\b/u;
const EXPECT_CALL = /\bexpect\s*\(/u;
const RSPEC_EXPECT = /\bexpect\([\s\S]*?\)\.to(?:_not)?\s+/u;

// ── Go markers (apex v72 fix) ───────────────────────────────────────────────

const GO_TEST_FUNC_SIGNATURE = /\bfunc\s+Test\w+\s*\(\s*\w+\s*\*testing\.T\s*\)/u;
const GO_T_ERROR_FAMILY = /\bt\s*\.\s*(?:Errorf|Error|Fatal|Fatalf|Fail|FailNow)\s*\(/u;
const GO_BARE_COMPARE =
  /\bif\s+\w+\s*(?:!=|==|<|<=|>|>=)\s*\w+\s*(?:\{|\|\||&&|\n)[\s\S]{0,400}?\bt\s*\.\s*(?:Errorf|Error|Fatal|Fatalf|Fail|FailNow)\b/u;
const GO_TESTIFY_ASSERT =
  /\b(?:assert|require)\s*\.\s*(?:Equal|EqualValues|NotEqual|True|False|Nil|NotNil|Contains|NotContains|Len|Empty|NotEmpty|Error|NoError|ErrorIs|ErrorAs|Panics|NotPanics|Same|NotSame|ElementsMatch|Regexp|Greater|GreaterOrEqual|Less|LessOrEqual)\s*\(/u;

// ── Python markers (apex v72 fix) ───────────────────────────────────────────

const PY_TEST_FUNC_MARKER = /\bdef\s+test_\w*\s*\(/u;
const PY_BARE_ASSERT = /^\s*assert\s+\S/mu;
const PY_UNITTEST_ASSERT =
  /\bself\s*\.\s*(?:assertEqual|assertNotEqual|assertTrue|assertFalse|assertIs|assertIsNot|assertIsNone|assertIsNotNone|assertIn|assertNotIn|assertIsInstance|assertNotIsInstance|assertRaises|assertRaisesRegex|assertWarns|assertAlmostEqual|assertNotAlmostEqual|assertGreater|assertGreaterEqual|assertLess|assertLessEqual|assertRegex|assertNotRegex|assertCountEqual|assertListEqual|assertTupleEqual|assertSetEqual|assertDictEqual|assertMultiLineEqual|assertSequenceEqual)\s*\(/u;

// ── Rust markers (apex v72 fix) ─────────────────────────────────────────────

const RS_TEST_ATTR = /#\[(?:tokio::test|async_std::test|test)\b/u;
const RS_ASSERT_MACRO = /\bassert(?:_eq|_ne|_matches)?\s*!\s*\(/u;

// ── Public API ──────────────────────────────────────────────────────────────

/** True when the path is a candidate test file the recognizer inspects (Pass B).
 * Language-agnostic on the location shape; the caller runs `hasMeaningfulAssertion`
 * to enforce the content check. */
export function isCandidateTestPath(path: string): boolean {
  if (BASE_SKELETON_TEST_PATHS.has(path)) return false;
  // TypeScript/JavaScript — vitest/jest convention: tests/*.test.ts(x).
  if (path.startsWith("tests/") && (path.endsWith(".test.ts") || path.endsWith(".test.tsx"))) return true;
  // Ruby — RSpec convention: spec/*_spec.rb.
  if (path.startsWith("spec/") && path.endsWith("_spec.rb")) return true;
  // Go — Go idiom co-locates `*_test.go` with source at ANY depth. `foo_test.go`,
  // `pkg/foo_test.go`, `internal/bar/bar_test.go` all count.
  if (path.endsWith("_test.go")) return true;
  // Python — pytest + unittest conventions: `test_*.py` OR `*_test.py`, at any
  // depth. `tests/test_foo.py`, `test/test_foo.py`, `pkg/foo_test.py` all count.
  if (path.endsWith(".py")) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base.startsWith("test_") || base.endsWith("_test.py")) return true;
  }
  // Rust — integration tests under `tests/` (crate root or nested crate).
  if (path.endsWith(".rs") && (path.startsWith("tests/") || path.includes("/tests/"))) return true;
  return false;
}

/** True when the file's content carries a meaningful assertion for at least one
 * recognized language. Content flavor is dispatched off the file's own markers
 * (Go `func TestXxx(t *testing.T)`, Python `def test_`, Rust `#[test]`) so a
 * test file whose extension misleads still gets the right check. */
export function hasMeaningfulAssertion(content: string): boolean {
  // Ruby (RSpec) flavor: `expect(...).to ...`. The `.to ...` form already requires
  // a matcher (a bare `.to` parses as `.to_eq`, `.to include`, etc.), so we accept
  // any `expect(...).to(_not)?` followed by whitespace + a matcher token.
  if (RSPEC_EXPECT.test(content)) return true;
  // Go — see file docblock for the required signature + assertion families.
  if (GO_TEST_FUNC_SIGNATURE.test(content)) {
    if (GO_T_ERROR_FAMILY.test(content)) return true;
    if (GO_TESTIFY_ASSERT.test(content)) return true;
    if (GO_BARE_COMPARE.test(content)) return true;
    return false;
  }
  // Python — requires a `def test_` marker AND either a bare `assert` or unittest assertX.
  if (PY_TEST_FUNC_MARKER.test(content)) {
    if (PY_BARE_ASSERT.test(content)) return true;
    if (PY_UNITTEST_ASSERT.test(content)) return true;
    return false;
  }
  // Rust — requires a `#[test]`/`#[tokio::test]` attribute AND an assertN macro.
  if (RS_TEST_ATTR.test(content)) {
    if (RS_ASSERT_MACRO.test(content)) return true;
    return false;
  }
  // TS/JS — `expect(...)<matcher>`. Require at least one meaningful matcher
  // that is NOT a truthy-only stand-alone (the .toBe(true)/.toBeTruthy()/etc.
  // pattern the skeleton uses to satisfy structural-only writers).
  if (!EXPECT_CALL.test(content)) return false;
  if (!MEANINGFUL_MATCHER.test(content)) return false;
  // Reject the all-truthy-only-matcher case: every meaningful match also matches
  // TRUTHY_ONLY (`.toBe(true)`), so we additionally require at least one matcher
  // that is NOT a truthy-only one.
  return hasNonTruthyOnlyMatcher(content);
}

function hasNonTruthyOnlyMatcher(content: string): boolean {
  // Strip every truthy-only matcher, then re-check for the meaningful pattern. A
  // file whose ONLY matchers are `.toBe(true)`/`.toBeTruthy()`/etc. yields an empty
  // residue post-strip; a file with even one real matcher leaves a residue match.
  const stripper = /\.(?:toBe\(true\)|toBeTruthy\(\)|toBeDefined\(\)|toBeFalsy\(\)|toBeNull\(\))/gu;
  const residue = content.replaceAll(stripper, "");
  return MEANINGFUL_MATCHER.test(residue);
}
