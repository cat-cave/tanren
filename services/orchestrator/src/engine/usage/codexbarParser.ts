import type { SubscriptionWindow, WindowUsage } from "./contracts.js";

// Parses the real `codexbar usage --provider <p> --source cli --format json`
// output. codexbar returns an ARRAY (one entry per account/provider). Each
// entry's `usage` carries up to three concurrent windows (primary/secondary/
// tertiary; any may be null) reported as percent-of-window consumed.
//
// Tolerant by contract: an `[{error:...}]` envelope, an empty array, or any
// shape we cannot recognize returns null ("no data" — never throws). We pick
// the FIRST entry whose provider matches, else the first entry, so a runner
// that surfaces a single provider still parses.
const WINDOW_SLOTS = ["primary", "secondary", "tertiary"] as const;

export function parseCodexbarUsage(stdout: string, provider: string): WindowUsage | null {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }
  // The `[{error:...}]` envelope means the tool ran but has no data.
  if (parsed.every((entry) => isErrorEnvelope(entry))) {
    return null;
  }
  const entries = parsed.filter((entry): entry is Record<string, unknown> => isObject(entry) && !isErrorEnvelope(entry));
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
    (window): window is SubscriptionWindow => window !== null
  );
  return {
    provider: stringField(match["provider"]) ?? provider,
    windows,
    creditsRemaining: parseCreditsRemaining(match["credits"]),
    accountEmail: stringField(usage["accountEmail"]) ?? identityEmail(usage["identity"]),
    source: stringField(match["source"]) ?? "",
    capturedAt: stringField(usage["updatedAt"]) ?? stringField(creditsUpdatedAt(match["credits"])) ?? new Date().toISOString()
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
    resetDescription: stringField(value["resetDescription"]) ?? ""
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
