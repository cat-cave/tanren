/**
 * DAG legend (P3-0013) — bottom-left graphical key for the five status
 * swatches + the numbered attention badge, matching the hi-fi `dag-legend`.
 * Reads as a key, not chrome. Colours from tokens only.
 */

import type { DagStatus } from "../../api/projectDag.js";
import { STATUS_STYLES } from "./DagNodes.js";

const ROWS: { k: DagStatus; pulse: boolean }[] = [
  { k: "done", pulse: false },
  { k: "live", pulse: true },
  { k: "review", pulse: true },
  { k: "blocked", pulse: true },
  { k: "queued", pulse: false },
];

export function DagLegend() {
  return (
    <div class="dag-legend">
      <div class="legend-title">legend</div>
      {ROWS.map((row) => {
        const s = STATUS_STYLES[row.k];
        return (
          <div class="legend-row">
            <span
              class={`swatch${row.pulse ? " pulse" : ""}`}
              style={`background:${s.fill};border-color:${s.stroke};color:${s.stroke}`}
            >
              {s.glyph}
            </span>
            <span class="k">{row.k}</span>
          </div>
        );
      })}
      <div class="legend-divider"></div>
      <div class="legend-row">
        <span class="num-swatch">N</span>
        <span class="k">attention #</span>
      </div>
    </div>
  );
}
