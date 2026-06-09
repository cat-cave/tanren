import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";

// ntfy channel — the only channel kind wired in v0.
//
// Target shape:
//   - `destination` is either a full ntfy topic URL (`https://ntfy.example/foo`)
//     or a bare topic name. When bare, the base URL is resolved per-org first:
//     the target's own `base_url` (authoritative) wins; otherwise the DEPLOY
//     default injected at boot via `deps.baseUrl`. The channel reads NO env —
//     a process-wide env base URL must never shadow a per-org target (audit
//     C4 / RC-1: a SaaS-host env would otherwise route EVERY tenant's ntfy
//     traffic through one shared host).
//
// Base-URL resolution order for a bare topic:
//   1. `target.baseUrl` (the per-org authoritative host) — if set.
//   2. `deps.baseUrl` (the deploy default the boot wiring injects) — if set.
//   3. otherwise a LOUD throw at publish (never a silent wrong host), per
//      no_silent_fallbacks.
//
// Delivery model: POST a JSON body to the topic URL with the standard
// `Title` / `Tags` / `Priority` headers ntfy recognizes. Failures are
// surfaced as a thrown Error which the dispatcher catches and records as
// `status='failed'` in `notifications`.

export interface NtfyChannelDeps {
  // fetch is injected so tests can drive it without a real network. The
  // default is the global fetch in Node 20+.
  fetch?: typeof fetch;
  // The DEPLOY default base URL, injected by the boot wiring (which reads the
  // deploy value). Used only for a bare-topic target with no per-org
  // `base_url`. The channel reads NO env directly; when neither a per-org base
  // nor this deploy default is set, a bare topic fails LOUD at publish.
  baseUrl?: string;
}

const NTFY_PRIORITY_BY_SEVERITY: Record<NotificationPayload["severity"], string> = {
  ok: "low",
  info: "default",
  warn: "high",
  fail: "urgent",
};

export class NtfyChannel implements NotificationChannel {
  readonly kind = "ntfy" as const;
  readonly wired = true;
  private readonly fetchImpl: typeof fetch;
  // The DEPLOY default only. May be undefined — a bare-topic target with no
  // per-org base then fails LOUD. NO env read here (audit C4 / RC-1).
  private readonly deployBaseUrl: string | undefined;

  constructor(deps: NtfyChannelDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.deployBaseUrl = deps.baseUrl;
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    const url = this.resolveUrl(target);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Title: payload.title,
      Priority: NTFY_PRIORITY_BY_SEVERITY[payload.severity],
      Tags: tagsFor(payload).join(","),
    };
    if (payload.url !== undefined) {
      headers["Click"] = payload.url;
    }
    const body = JSON.stringify({
      message: payload.body,
      severity: payload.severity,
      event: payload.eventName,
      ...(payload.url === undefined ? {} : { url: payload.url }),
    });
    const response = await this.fetchImpl(url, { method: "POST", headers, body });
    if (!response.ok) {
      // Read text best-effort to surface upstream errors. ntfy returns
      // structured JSON on failure, but plain text is fine for the log row.
      const detail = await safeReadText(response);
      throw new Error(`ntfy publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
  }

  private resolveUrl(target: NotificationTargetRow): string {
    const destination = target.destination;
    if (destination.startsWith("http://") || destination.startsWith("https://")) {
      return destination;
    }
    // Bare topic — resolve the base per-org first, deploy default second.
    // No env read; a missing base is a LOUD failure (never a silent wrong host).
    const resolvedBase = target.baseUrl ?? this.deployBaseUrl;
    if (resolvedBase === undefined || resolvedBase === null || resolvedBase.length === 0) {
      throw new Error(
        `ntfy target ${target.id} (org ${target.orgId}) has a bare-topic destination ` +
          `"${destination}" but no base URL resolvable: set the target's base_url ` +
          `or configure the deploy default. Refusing to route to a wrong host.`,
      );
    }
    const base = resolvedBase.endsWith("/") ? resolvedBase.slice(0, -1) : resolvedBase;
    const topic = destination.startsWith("/") ? destination.slice(1) : destination;
    return `${base}/${topic}`;
  }
}

function tagsFor(payload: NotificationPayload): string[] {
  const baseTags = [`severity:${payload.severity}`, `event:${payload.eventName}`];
  if (payload.tags !== undefined) {
    return [...baseTags, ...payload.tags];
  }
  return baseTags;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
