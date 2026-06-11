// The HOST-SIDE PRODUCER of the neutral `EntityChangeMap` that feeds the native
// entity-risk oracle (entityRiskTaxonomy.ts). This is the §3.1 piece that makes
// the deterministic risk signal FIRE in production: Tanren runs `sem` READ-ONLY on
// the runner (over the existing command substrate) to produce the entity-change
// map, then the pure classifier turns it into the checker's pre-LLM risk posture.
//
// docs/roadmap/entity-analysis-layer.md §3.1 calls the entity-change map "a
// first-class signal the checker reasons over DETERMINISTICALLY before the LLM
// judgement". That is a NATIVE Tanren signal — NOT prompt injection. The §1
// constraint forbids "running `sem` host-side AND injecting its raw output into the
// prompt"; it does NOT forbid Tanren computing its own deterministic signal from
// `sem`. So this producer shells `sem diff --from <baselineSha> --to HEAD --format
// json`, parses it into the neutral `EntityChangeMap`, and hands it to the
// classifier. The agent still self-inspects the diff in its sandbox separately (the
// answererPrompts steer is UNCHANGED); the raw sem output never reaches the prompt.
//
// GRACEFUL (non-negotiable, §1): the signal is an OPTIONAL accelerator. `sem` is
// absent on stacks/images that don't vendor it, errors transiently, or cannot
// structurally parse a stack (it covers many languages but not every one — Tanren
// bakes in NO language assumption). EVERY such case returns the `unknown` signal
// exactly as today; the producer NEVER throws, blocks, or changes a verdict.
//
// NO-SILENT-FALLBACK (non-negotiable): the doctrine demands the UNEXPECTED failure
// (sem PRESENT but erroring / emitting unparseable output) be distinguished from
// the LEGITIMATE absence (sem not on PATH, or a stack sem can't parse). The
// producer stamps the right `UnavailableReason` so the wiring layer logs the
// unexpected case loudly while the legitimate ones stay quiet.
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { EntityChange, EntityChangeMap, UnavailableReason } from "./entityRiskTaxonomy.js";

// What the producer resolved: either a real map to classify, or a reason the map
// is UNAVAILABLE (which the wiring layer feeds straight to `classifyEntityRisk`'s
// `unavailable` arg → the `unknown` signal with the right provenance). A present
// map is ALWAYS classified, even when empty (an empty diff is the cosmetic-skip
// case the taxonomy already handles).
export type EntityMapProduction = { map: EntityChangeMap } | { unavailable: UnavailableReason };

// The host-side inputs the producer needs to shell `sem` on the runner. All of
// these are already in scope at the checker call site (the run's substrate +
// runner handle + workspace + diff base) — the producer adds NO new allocation.
export interface SemEntityProducerInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  // The diff base the checker already diffs against (the run base / baselineSha).
  // `sem diff --from <baselineSha> --to HEAD` mirrors the agent's own self-inspect.
  baselineSha: string;
  timeoutMs: number;
}

// The exact `sem diff` invocation. READ-ONLY (a diff over two refs; no write, no
// checkout, no cache mutation visible to the tree). `--format json` is sem's
// machine shape (parsed by `parseSemDiffJson`). Exported so a test can pin the
// command string without re-deriving it.
export function semDiffCommand(baselineSha: string): string {
  return `sem diff --from ${baselineSha} --to HEAD --format json`;
}

// ── The raw `sem diff --format json` shape (only the fields we read) ──────────
//
// sem emits `{ summary, changes, binaryChanges }`. We read `changes[]` only —
// `summary`/`binaryChanges` are not load-bearing for the risk taxonomy. Each
// change carries `changeType` (added/modified/deleted/renamed/moved/reordered),
// `entityType` (function/class/method/type/... or `chunk` when sem fell back to
// line-chunks because it could NOT structurally parse the file), and
// `structuralChange` (true = structural, false = cosmetic, null = undecided).
interface SemDiffChange {
  changeType?: unknown;
  entityType?: unknown;
  entityId?: unknown;
  entityName?: unknown;
  structuralChange?: unknown;
}
interface SemDiffJson {
  changes?: unknown;
}

// Map sem's `changeType` to the neutral `EntityChangeKind`. sem's `moved` /
// `reordered` are position-only changes with no shape change → treated as
// `modified` (a structural edit at most, never a public-shape break by kind
// alone). An unrecognized value is treated as `modified` (conservative — a change
// we cannot name is NOT downgraded to cosmetic).
function mapChangeKind(changeType: unknown): EntityChange["kind"] {
  switch (changeType) {
    case "added":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    case "modified":
    case "moved":
    case "reordered":
      return "modified";
    default:
      return "modified";
  }
}

// Map sem's `structuralChange` tri-state to the neutral `EntityChangeNature`.
// `false` ⇒ cosmetic (the cheap-skip case); `true` ⇒ structural; `null`/missing ⇒
// `unknown` (the classifier treats unknown-nature conservatively as NOT cosmetic).
function mapChangeNature(structuralChange: unknown): EntityChange["nature"] {
  if (structuralChange === false) return "cosmetic";
  if (structuralChange === true) return "structural";
  return "unknown";
}

// sem's `entityType: "chunk"` is its LINE-FALLBACK marker: when it cannot parse a
// file's structure (an unsupported language / a plain-text file) it emits raw
// line-chunks instead of real entities. A change whose entity is a chunk is NOT a
// structural entity signal.
function isChunkFallback(change: SemDiffChange): boolean {
  return change.entityType === "chunk";
}

// Parse `sem diff --format json` stdout into a neutral `EntityChangeMap`, or a
// reason it is unavailable. PURE + DETERMINISTIC: no IO, no env, no clock — every
// branch is exercised by a fixture of real sem output. This is the seam the
// producer's IO half delegates to, so the classification logic is unit-testable
// without a runner.
//
// Reasons returned:
//  - unparseable / wrong-shape JSON ⇒ `producer-errored` (UNEXPECTED, loud): sem
//    ran but its output is not the contract we parse.
//  - every change is a `chunk` line-fallback (≥1 change, all chunks) ⇒
//    `producer-unsupported` (LEGITIMATE, quiet): sem could not structurally parse
//    this stack, so there is no entity-level signal to classify.
//  - otherwise ⇒ a `map` (chunk changes mixed in with real entities are kept as
//    `unknown`-nature entities, so a partially-parsed diff still classifies).
export function parseSemDiffJson(stdout: string): EntityMapProduction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // sem present but emitted non-JSON (an error banner, a panic) — unexpected.
    return { unavailable: "producer-errored" };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { unavailable: "producer-errored" };
  }
  const rawChanges = (parsed as SemDiffJson).changes;
  if (!Array.isArray(rawChanges)) {
    // The `changes` array is the contract; its absence means the shape is not the
    // `sem diff --format json` we parse → unexpected (loud), not a quiet skip.
    return { unavailable: "producer-errored" };
  }

  const changes = rawChanges as SemDiffChange[];
  // A genuinely empty diff is a VALID map (the classifier's cosmetic-skip case) —
  // NOT an unavailability. Only a non-empty diff that is ALL chunk-fallback means
  // sem could not parse the stack.
  if (changes.length > 0 && changes.every((change) => isChunkFallback(change))) {
    return { unavailable: "producer-unsupported" };
  }

  const entities: EntityChange[] = changes.map((change) => {
    const kind = mapChangeKind(change.changeType);
    // A chunk-fallback change mixed into an otherwise-parsed diff carries no real
    // entity identity/nature — keep it as an `unknown`-nature entity so it counts
    // conservatively (non-cosmetic) without claiming a structural classification.
    const nature = isChunkFallback(change) ? "unknown" : mapChangeNature(change.structuralChange);
    const entity: EntityChange = {
      kind,
      nature,
      // sem does not expose a public/internal visibility axis; leave it `unknown`
      // (the taxonomy treats unknown visibility as NOT public, so it never
      // over-escalates to the public-api-signature class on sem data alone).
      visibility: "unknown",
    };
    const id = idOf(change);
    if (id !== undefined) {
      entity.id = id;
    }
    return entity;
  });
  return { map: { entities } };
}

// The entity's stable identity for traceability (sem's `entityId` structural-hash
// path, else its `entityName`). Not required for classification — purely an aid to
// the observability layer. Returns undefined when neither is a usable string.
function idOf(change: SemDiffChange): string | undefined {
  if (typeof change.entityId === "string" && change.entityId !== "") return change.entityId;
  if (typeof change.entityName === "string" && change.entityName !== "") return change.entityName;
  return undefined;
}

// Run `sem diff` on the runner over the existing command substrate (READ-ONLY) and
// resolve the entity-change map (or the reason it is unavailable). NEVER throws:
// every failure mode maps to an `UnavailableReason` so the checker degrades to the
// `unknown` signal gracefully.
//
// Failure mapping (no-silent-fallback):
//  - substrate transport failure / timeout ⇒ `producer-errored` (UNEXPECTED): the
//    runner was reachable enough to gate, so a substrate failure shelling sem is a
//    real fault to surface, not a quiet skip.
//  - `sem` not found (exit 127, or a shell "command not found") ⇒ `no-producer`
//    (LEGITIMATE, quiet): the image does not vendor sem.
//  - non-zero exit with output ⇒ `producer-errored` (UNEXPECTED): sem ran and
//    failed (a bad ref, an internal error).
//  - exit 0 ⇒ delegate to `parseSemDiffJson` (which itself returns
//    `producer-unsupported` for an unparseable stack).
export async function produceEntityChangeMap(input: SemEntityProducerInput): Promise<EntityMapProduction> {
  const result = await input.ssh.run(input.target, {
    command: semDiffCommand(input.baselineSha),
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
  });

  if (result.failure !== undefined || result.timedOut) {
    // The substrate could not run the command (transport fault / timeout). The
    // runner is otherwise live (the gate runs on it), so this is unexpected.
    return { unavailable: "producer-errored" };
  }

  if (result.exitCode !== 0) {
    // sem absent: a shell reports 127 (command not found). Treat that as the
    // LEGITIMATE quiet absence; any other non-zero exit is sem ERRORING (loud).
    if (isSemAbsent(result.exitCode, result.stderr)) {
      return { unavailable: "no-producer" };
    }
    return { unavailable: "producer-errored" };
  }

  return parseSemDiffJson(result.stdout);
}

// Whether a non-zero `sem diff` exit means sem is ABSENT (legitimate, quiet) rather
// than PRESENT-but-erroring (unexpected, loud). A shell that cannot find the binary
// exits 127 and/or prints a binary-not-found line. The match is DELIBERATELY tight
// — it anchors on the binary name (`sem: ...`) or the shell's exec-failure phrasing
// — so a stray "not found" inside a sem/git ERROR message (e.g. "revspec ... not
// found") is NOT misread as absence (it must stay the loud `producer-errored`).
function isSemAbsent(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 127) return true;
  // `bash: sem: command not found` / `sem: command not found` / `sem: not found`
  // / `... sem: No such file or directory` — the shell failing to EXEC the binary.
  return /(^|[:\s])sem:\s*(command not found|not found|no such file)/iu.test(stderr);
}
