/**
 * Placeholder page body for sidenav rows that do not yet have a Phase-2B
 * implementation. Every placeholder states which phase the surface ships in and
 * (where known) the owning spec, satisfying the acceptance criterion that empty
 * routes are documented rather than blank.
 */

import type { NavRow } from "./routes.js";

export interface PlaceholderProps {
  row: NavRow;
}

export function PlaceholderBody(props: PlaceholderProps) {
  const { row } = props;
  const phaseLabel = row.phase === "2b" ? "ships in Phase 2B" : "ships in Phase 3+";
  return (
    <>
      <div class="page-head">
        <div>
          <div class="eyebrow">placeholder · {phaseLabel}</div>
          <div class="page-title">{row.label}</div>
          {row.spec !== undefined && <div class="sub">owned by {row.spec}</div>}
        </div>
      </div>
      <div class="page-body">
        <section class="placeholder-card">
          <p>
            This surface is a documented placeholder. The full <strong>{row.label}</strong> screen{" "}
            {row.phase === "2b"
              ? `is implemented by ${row.spec ?? "a Phase 2B spec"} once it lands inside the shell.`
              : "is part of the Phase 3 product expansion."}
          </p>
          <p class="placeholder-note">
            The shell, navigation, and ⌘K palette are live now; this route mounts here when its owning spec ships.
          </p>
        </section>
      </div>
    </>
  );
}
