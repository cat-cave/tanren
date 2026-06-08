import type { SubscriptionWindow, WindowUsage } from "./contracts.js";

// Parses the real `codexbar usage --provider <p> --source cli --format json`
// output. codexbar returns an ARRAY (one entry per account/provider). Each
// entry's `usage` carries up to three concurrent windows (primary/secondary/
// tertiary; any may be null) reported as percent-of-window consumed.
//
// LEGITIMATE-EMPTY by contract: an `[{error:...}]` envelope or an empty array is
// "the tool ran clean but has no window data" → null. We pick the FIRST entry
// whose provider matches, else the first entry, so a runner that surfaces a
// single provider still parses.
const WINDOW_SLOTS = ["primary", "secondary", "tertiary"] as const;

// A DISCRIMINATED codexbar parse. `{ ok: null }` is a clean-but-empty read (an
// empty array / `[{error}]` envelope); `{ ok: <usage> }` is a parsed window;
// `{ failed }` is malformed NON-empty output (non-JSON / not-an-array) — parser
// or CLI-contract drift that must be LOUD, never a silent "no window pressure".
export type CodexbarParseResult = { ok: WindowUsage | null } | { failed: { detail: string } };

export function parseCodexbarUsageResult(stdout: string, provider: string): CodexbarParseResult {
  if (stdout.trim() === "") {
    return { ok: null };
  }
  const parsed = parseJson(stdout);
  // codexbar ALWAYS emits a JSON array (possibly empty). Non-JSON or a non-array
  // is contract drift → loud failure, not "no data".
  if (parsed === undefined || !Array.isArray(parsed)) {
    return { failed: { detail: codexbarTail(stdout) } };
  }
  return { ok: parseCodexbarUsage(stdout, provider) };
}

// A secret-free, bounded, whitespace-collapsed stdout tail for the diagnostic.
function codexbarTail(stdout: string): string {
  return stdout.slice(-500).replaceAll(/\s+/gu, " ").trim();
}

export function parseCodexbarUsage(stdout: string, provider: string): WindowUsage | null {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  // The `[{error:...}]` envelope means the tool ran but has no data.
  if (parsed.every((entry) => isErrorEnvelope(entry))) {
    return null;
  }
  const entries = parsed.filter(
    (entry): entry is Record<string, unknown> => isObject(entry) && !isErrorEnvelope(entry),
  );
  if (entries.length === 0) {
    return null;
  }
  const match = entries.find((entry) => entry["provider"] === provider) ?? entries[0];
  if (match === undefined) {
    return null;
  }
  const usage = isObject(match["usage"]) ? (match["usage"] as Record<string, unknown>) : undefined;
  if (usage === undefined) {
    return null;
  }
  const windows = WINDOW_SLOTS.map((slot) => parseWindow(slot, usage[slot])).filter(
    (window): window is SubscriptionWindow => window !== null,
  );
  return {
    provider: stringField(match["provider"]) ?? provider,
    windows,
    creditsRemaining: parseCreditsRemaining(match["credits"]),
    accountEmail: stringField(usage["accountEmail"]) ?? identityEmail(usage["identity"]),
    source: stringField(match["source"]) ?? "",
    capturedAt:
      stringField(usage["updatedAt"]) ?? stringField(creditsUpdatedAt(match["credits"])) ?? new Date().toISOString(),
  };
}

function parseWindow(slot: SubscriptionWindow["slot"], value: unknown): SubscriptionWindow | null {
  if (!isObject(value)) {
    return null;
  }
  const usedPercent = numberField(value["usedPercent"]);
  const windowMinutes = numberField(value["windowMinutes"]);
  const resetsAt = stringField(value["resetsAt"]);
  if (usedPercent === undefined || windowMinutes === undefined || resetsAt === undefined) {
    return null;
  }
  return {
    slot,
    usedPercent,
    resetsAt,
    windowMinutes,
    resetDescription: stringField(value["resetDescription"]) ?? "",
  };
}

function parseCreditsRemaining(credits: unknown): number | null {
  if (!isObject(credits)) {
    return null;
  }
  const remaining = numberField(credits["remaining"]);
  return remaining ?? null;
}

function creditsUpdatedAt(credits: unknown): unknown {
  return isObject(credits) ? credits["updatedAt"] : undefined;
}

function identityEmail(identity: unknown): string | null {
  if (!isObject(identity)) {
    return null;
  }
  return stringField(identity["accountEmail"]) ?? null;
}

function isErrorEnvelope(value: unknown): boolean {
  return isObject(value) && "error" in value && value["error"] !== undefined && value["error"] !== null;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
