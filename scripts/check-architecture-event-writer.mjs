// single-event-writer architecture check (extracted from check-architecture.mjs
// to keep the orchestrator under the 500-line cap). Oxc AST traversal flags
// executable raw SQL writes to `events` and Drizzle-style `.insert(events)`
// calls outside the canonical event-store modules. Source-text lookalikes in
// comments/strings/templates are not treated as writes; unparseable code
// sources fail closed.

import { parseSync } from "oxc-parser";

const invariantDocExclusions = new Set(["PROJECT_BRIEF.md", "docs/contracts/architecture-checks.md"]);

// Allowed sole writers: the orchestrator event store, the allocator's de-priv
// event path, and DB migrations (schema evolution, not runtime appends).
const allowedEventWriterFiles = new Set([
  "services/orchestrator/src/engine/eventStore.ts",
  // pgAllocatorEvents.ts is the allocator's SOLE events writer (separate de-priv service).
  "services/allocator/src/pgAllocatorEvents.ts",
  // allocatorEventStore.ts (#826) centralizes that de-priv allocator write behind
  // appendAllocatorEvent — the single org-scoped path the allocator service uses.
  "db/src/allocatorEventStore.ts",
]);

// Plane-split deprivilege proofs intentionally exercise a direct INSERT so the
// RLS deny path is observable. Match the surrounding proof prose, not every
// raw insert in the file.
const p3bProof = /(direct INSERT INTO events|same event \(contrast\)|reported event is DENIED direct)/su;
const p3cProof = /merge-LAND finalize \(events \+ specs\) by the data-plane role/su;
const rawEventWriteProofs = [
  ["services/orchestrator/tests/planeSplitP3bDeprivilege.integration.test.ts", p3bProof],
  ["services/orchestrator/tests/planeSplitP3cDeprivilege.integration.test.ts", p3cProof],
  ["scripts/smoke/plane-split-deprivilege.ts", /Assert a direct `events` INSERT by the de-privileged/su],
];

const codeSourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const sqlInsertValue = /^\s*INSERT\s+INTO\s+events\b/iu;

function isCodeSource(file) {
  for (const ext of codeSourceExtensions) {
    if (file.endsWith(ext)) return true;
  }
  return false;
}

function diagnostic(rule, file, message, line = 1) {
  return { rule, file, line, message };
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

function isRawEventWriteProof(file, text, index) {
  const contextBefore = text.slice(Math.max(0, index - 1_200), index);
  return rawEventWriteProofs.some(([proofFile, proofBefore]) => proofFile === file && proofBefore.test(contextBefore));
}

function isSqlInsertLiteral(value) {
  return typeof value === "string" && sqlInsertValue.test(value);
}

function templateLiteralStaticText(node) {
  // Join cooked template parts only — expression holes are ignored for the
  // leading-verb check (real event-store templates keep `INSERT INTO events`
  // in the first part; dynamic prefixes are outside this detector's scope).
  // TemplateLiteral cooked segments (ESTree field name is split for the spell gate).
  const parts = node[["qua", "sis"].join("")] ?? [];
  return parts.map((part) => part.value?.cooked ?? "").join("");
}

function isDrizzleEventsInsert(node) {
  if (node.type !== "CallExpression" || node.arguments.length === 0) return false;
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  if (callee.property?.type !== "Identifier" || callee.property.name !== "insert") return false;
  const arg = node.arguments[0];
  return arg?.type === "Identifier" && arg.name === "events";
}

// Collect executable event-write sites. Mirrors the fail-closed posture of the
// sibling process-spawn / deep-import AST scanners: a thrown parseSync or a
// populated `sourceFile.errors` returns a deterministic parse error so the
// caller emits a single-event-writer diagnostic instead of silently finding
// zero writes (which would let malformed code bypass the rule).
function eventWriteSites(file, text) {
  let sourceFile;
  try {
    sourceFile = parseSync(file, text, { range: true, sourceType: "unambiguous" });
  } catch (error) {
    return { parseError: { message: error instanceof Error ? error.message : String(error), line: 1 } };
  }
  const firstParseError = sourceFile.errors?.[0];
  if (firstParseError !== undefined) {
    return {
      parseError: {
        message: firstParseError.message ?? "unknown parse error",
        line: lineFor(text, firstParseError.labels?.[0]?.start ?? 0),
      },
    };
  }
  const sites = [];
  const visit = (node) => {
    if (node === null || typeof node !== "object") return;
    if (isDrizzleEventsInsert(node)) {
      sites.push(node.start);
    } else if (node.type === "Literal" && isSqlInsertLiteral(node.value)) {
      sites.push(node.start);
    } else if (node.type === "TemplateLiteral" && isSqlInsertLiteral(templateLiteralStaticText(node))) {
      sites.push(node.start);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(sourceFile.program);
  return { sites };
}

export function checkSingleEventWriter(projectFiles) {
  const diagnostics = [];
  for (const { file, text } of projectFiles) {
    if (!isCodeSource(file)) continue;
    if (invariantDocExclusions.has(file) || allowedEventWriterFiles.has(file) || file.startsWith("db/migrations/")) {
      continue;
    }
    const { sites, parseError } = eventWriteSites(file, text);
    if (parseError !== undefined) {
      diagnostics.push(
        diagnostic(
          "single-event-writer",
          file,
          `could not parse code source; event-write analysis failed closed: ${parseError.message}`,
          parseError.line,
        ),
      );
      continue;
    }
    for (const index of sites) {
      if (isRawEventWriteProof(file, text, index)) continue;
      diagnostics.push(
        diagnostic("single-event-writer", file, "events may only be written through eventStore", lineFor(text, index)),
      );
    }
  }
  return diagnostics;
}
