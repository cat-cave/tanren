import type { NotificationChannel } from "./channels/types.js";
import { NtfyChannel, type NtfyChannelDeps } from "./channels/ntfy.js";
import { StubChannel } from "./channels/stub.js";
import { ChannelKind } from "./schemas.js";

// P2A-0017: v0 channel registry. Only ntfy is wired; every other
// ChannelKind is registered as a StubChannel so the matrix can be
// configured against them without crashing the dispatcher.

export interface ChannelRegistryDeps {
  ntfy?: NtfyChannelDeps;
}

export function buildChannelRegistry(
  deps: ChannelRegistryDeps = {}
): Record<ChannelKind, NotificationChannel> {
  const registry: Partial<Record<ChannelKind, NotificationChannel>> = {};
  for (const kind of ChannelKind.options) {
    registry[kind] = kind === "ntfy" ? new NtfyChannel(deps.ntfy ?? {}) : new StubChannel(kind);
  }
  return registry as Record<ChannelKind, NotificationChannel>;
}
