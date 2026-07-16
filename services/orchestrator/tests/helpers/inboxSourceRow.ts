import type { InboxSource } from "../../src/engine/forge/inbox/index.js";

/** Canonical post-migration database projection for an inbox source fixture. */
export function inboxSourceRow(source: InboxSource): Record<string, unknown> {
  const attention = source.attention ?? null;
  return {
    id: source.id,
    org_id: source.orgId,
    project_id: source.projectId,
    kind: source.kind,
    name: source.name,
    detail: source.detail,
    config: source.config,
    enabled: source.enabled ? "true" : "false",
    auto_route: source.autoRoute ? "true" : "false",
    state: source.state ?? "active",
    attention_code: attention?.code ?? null,
    attention_message: attention?.message ?? null,
    attention_observed_at: attention?.observedAt ?? null,
    webhook_configured: source.webhookConfigured ?? false,
    retry_not_before: source.retryNotBefore ?? null,
    project_valid: true,
  };
}
