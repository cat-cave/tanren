// no-production-stubs (P8a §8a): a stub / mock / deterministic-stand-in / no-op
// policy may exist ONLY under tests/ and may NEVER be the value a production
// src/ path constructs or defaults to. This makes "no stubs in production" a
// mechanical gate rather than a claim. Extracted from check-architecture.mjs to
// keep both files under the 500-line cap; same heuristic line-scanner style as
// the sibling check modules.
//
// The lint flags, in any **/src/** non-test file, the CONSTRUCTION or
// DEFAULT-ASSIGNMENT of an identifier matching the stub taxonomy. A bare type
// *definition* (e.g. `export class FakeAllocator`) is not a construction and is
// not flagged here — what is forbidden is wiring such a value into a production
// code path. The default of an injectable seam must be the real impl (or a hard
// throw when unconfigured); a seam whose real impl exists but is unwired stays
// flagged until wired.
//
// The allowlist is finite, enumerated, and ANNOTATED: an entry is honored ONLY
// when the file also carries an `// arch-allow:` comment, so the exemption is
// reviewable in-source. Two kinds of entry exist:
//   - absence-is-correct: a HARD-THROW default (UnconfiguredAllocator) or an
//     honest "not wired" audit record (StubChannel records 'stubbed').
//   - pending: a TEMPORARY exemption whose real replacement is not yet built
//     (e.g. the audit pass runner → P3). These tighten when the phase lands and
//     the real default is wired. (P2b retired the noopConflictResolver entries:
//     the intent-preserving resolver is now the production default.)
// The OSS quota no-op is intentionally NOT on this list — P1·0 deleted it.

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

// Construction / default-assignment forms, capturing the referenced identifier:
//   - construction:      `new <Id>(`
//   - fallback default:  `?? <Id>` / `|| <Id>`
//   - call/value assign: `= <Id>(` / `= <Id>;` / `= <Id>,`
// The captured identifier is then classified by `isStubIdentifier` so the
// CamelCase/word-boundary logic lives in code (clearer than one mega-regex).
const stubReferencePatterns = [
  /\bnew\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gu,
  /(?:\?\?|\|\|)\s*([A-Za-z_$][A-Za-z0-9_$]*)\b/gu,
  /=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[(;,]/gu,
];

// Split a JS identifier into lowercased words across CamelCase, digit, and `_`
// boundaries: `noopConflictResolver` → [noop, conflict, resolver];
// `StubChannel` → [stub, channel]; `FakeAllocator` → [fake, allocator].
function identifierWords(id) {
  return id
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[\s_$]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

const stubStems = new Set(["stub", "noop", "fake", "mock"]);

// An identifier is a stub-taxonomy reference if any of its words is a stub stem,
// OR it is a deterministic-answerer factory, OR a `templated*` generator. A
// hard-throw seam whose name carries no stem word (`UnconfiguredAllocator`, the
// `*AnswererUnconfiguredError` throws) is the CORRECT unconfigured default and is
// deliberately NOT in the taxonomy — failing loudly is not a stand-in.
function isStubIdentifier(id) {
  if (/^createDeterministic[A-Za-z0-9]*Answerer$/u.test(id) || /^templated[A-Z][A-Za-z0-9]*$/u.test(id)) {
    return true;
  }
  return identifierWords(id).some((word) => stubStems.has(word));
}

// Enumerated, reviewable allowlist. Each entry names the file, the identifier
// that may be constructed/defaulted there, and whether the exemption is
// permanent (absence-is-correct) or temporary (pending a phase). An entry is
// honored ONLY if the file also contains an `// arch-allow:` annotation.
export const productionStubAllowlist = [
  {
    file: "services/orchestrator/src/engine/notifications/registry.ts",
    identifier: "StubChannel",
    reason: "unconfigured channel → 'stubbed' audit record (honest not-wired), never a silent drop",
  },
];

function isProductionSource(file) {
  return file.includes("/src/") && !file.includes("/tests/") && !/\.test\.[tj]sx?$/u.test(file);
}

// Strip `//` line comments and `*`-prefixed block-comment body lines so a
// taxonomy word in prose/JSDoc (e.g. "templated narration") is not mistaken for
// a construction. String literals are left intact; a stub identifier inside a
// string is rare and still worth a reviewer's eye.
function stripCommentary(line) {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
    return "";
  }
  const commentIndex = line.indexOf("//");
  return commentIndex === -1 ? line : line.slice(0, commentIndex);
}

// Every stub-taxonomy identifier constructed / default-assigned on a line.
function stubReferencesIn(code) {
  const ids = new Set();
  for (const pattern of stubReferencePatterns) {
    for (const match of code.matchAll(pattern)) {
      if (isStubIdentifier(match[1])) {
        ids.add(match[1]);
      }
    }
  }
  return [...ids];
}

function allowlistEntryFor(file, identifier) {
  return productionStubAllowlist.find((entry) => entry.file === file && entry.identifier === identifier);
}

export function checkNoProductionStubs(projectFiles) {
  const diagnostics = [];
  const rule = "no-production-stubs";
  const annotatedFiles = new Set(
    projectFiles.filter(({ text }) => text.includes("// arch-allow:")).map(({ file }) => file),
  );
  for (const { file, text } of projectFiles) {
    if (!isProductionSource(file)) {
      continue;
    }
    const lines = text.split("\n");
    for (const [index, rawLine] of lines.entries()) {
      const code = stripCommentary(rawLine);
      const referenced = stubReferencesIn(code);
      if (referenced.length === 0) {
        continue;
      }
      const allowed = referenced.every((id) => allowlistEntryFor(file, id));
      // An allowlist entry is honored ONLY when the file carries the annotation.
      if (allowed && annotatedFiles.has(file)) {
        continue;
      }
      const detail = allowed
        ? "allowlisted but missing the required `// arch-allow:` annotation"
        : "stubs/mocks/no-op stand-ins may not be constructed or defaulted in production src/ (tests/ only)";
      diagnostics.push(diagnostic(rule, file, detail, index + 1));
    }
  }
  return diagnostics;
}
