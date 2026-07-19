// rv-23 — shared render helpers for the proof dashboard surfaces. The pill logic
// is the anti-laundering crux made visual: ONLY `passed` renders green; every
// failed/inconclusive/cancelled outcome renders as a fail/warn, and a MISSING
// verdict (null cell) renders an explicit `unproven` unknown pill — never green.
import type { Outcome } from "../../api/proofDashboard.js";

export function outcomeClass(outcome: Outcome): "pass" | "fail" | "warn" {
  if (outcome === "passed") return "pass";
  if (
    outcome === "inconclusive_infrastructure" ||
    outcome === "inconclusive_external" ||
    outcome === "cancelled_superseded"
  ) {
    return "warn";
  }
  return "fail";
}

/** A verdict cell that may be absent — a null cell is UNPROVEN, rendered unknown, never green. */
export function OutcomePill(props: { readonly outcome: Outcome | null }) {
  if (props.outcome === null) return <span class="pill unknown">unproven</span>;
  return <span class={`pill ${outcomeClass(props.outcome)}`}>{props.outcome.replaceAll("_", " ")}</span>;
}

export function shortHash(value: string | null): string {
  if (value === null || value === "") return "—";
  const stripped = value.startsWith("sha256:") ? value.slice(7) : value;
  return stripped.length > 12 ? `${stripped.slice(0, 12)}…` : stripped;
}

/**
 * The two fail-closed states shared by every surface: a project whose scope is not
 * visible to the caller, and a surface whose data could not be resolved. Neither
 * ever shows a green/"all passed" — an unresolved surface is explicitly blocked.
 */
export function SurfaceUnavailable(props: { readonly missingProject: boolean; readonly what: string }) {
  if (props.missingProject) {
    return (
      <div class="empty" role="status">
        Project scope is not visible for this session. No {props.what} can be shown.
      </div>
    );
  }
  return (
    <div class="alert" role="alert">
      <b>{props.what} unavailable</b> — the orchestrator did not return a valid response. This surface is BLOCKED, not
      empty: no proof state is being shown, and nothing here should be read as passing.
    </div>
  );
}
