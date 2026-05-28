import type { NotificationPayload, NotificationTargetRow } from "../schemas.js";
import type { NotificationChannel } from "./types.js";

// P2A-0017 ntfy channel — the only channel kind wired in v0.
//
// Target shape:
//   - `destination` is either a full ntfy topic URL (`https://ntfy.example/foo`)
//     or a bare topic name. When bare, we resolve the base URL from
//     `TANREN_NTFY_BASE_URL` (defaulting to `http://ntfy:80` for the compose
//     stack the dev profile ships).
//
// Delivery model: POST a JSON body to the topic URL with the standard
// `Title` / `Tags` / `Priority` headers ntfy recognizes. Failures are
// surfaced as a thrown Error which the dispatcher catches and records as
// `status='failed'` in `notifications`.

export interface NtfyChannelDeps {
  // fetch is injected so tests can drive it without a real network. The
  // default is the global fetch in Node 20+.
  fetch?: typeof fetch;
  // Default base URL when the target destination is a bare topic. Compose
  // dev ships ntfy on port 80 inside the stack. Operators in production
  // set the env var to their public ntfy URL.
  baseUrl?: string;
}

const NTFY_PRIORITY_BY_SEVERITY: Record<NotificationPayload["severity"], string> = {
  ok: "low",
  info: "default",
  warn: "high",
  fail: "urgent"
};

export class NtfyChannel implements NotificationChannel {
  readonly kind = "ntfy" as const;
  readonly wired = true;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(deps: NtfyChannelDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.baseUrl = deps.baseUrl ?? process.env["TANREN_NTFY_BASE_URL"] ?? "http://ntfy:80";
  }

  async publish(target: NotificationTargetRow, payload: NotificationPayload): Promise<void> {
    const url = this.resolveUrl(target.destination);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Title: payload.title,
      Priority: NTFY_PRIORITY_BY_SEVERITY[payload.severity],
      Tags: tagsFor(payload).join(",")
    };
    if (payload.url !== undefined) {
      headers["Click"] = payload.url;
    }
    const body = JSON.stringify({
      message: payload.body,
      severity: payload.severity,
      event: payload.eventName,
      ...(payload.url !== undefined ? { url: payload.url } : {})
    });
    const response = await this.fetchImpl(url, { method: "POST", headers, body });
    if (!response.ok) {
      // Read text best-effort to surface upstream errors. ntfy returns
      // structured JSON on failure, but plain text is fine for the log row.
      const detail = await safeReadText(response);
      throw new Error(`ntfy publish failed: ${response.status} ${response.statusText} ${detail}`.trim());
    }
  }

  private resolveUrl(destination: string): string {
    if (destination.startsWith("http://") || destination.startsWith("https://")) {
      return destination;
    }
    const base = this.baseUrl.endsWith("/") ? this.baseUrl.slice(0, -1) : this.baseUrl;
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
