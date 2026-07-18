/**
 * bh-14b — the six SEPARATE truth badges, rendered as independent fields.
 *
 * THE decisive invariant (bh-10/bh-11): a cosmetic-fix loop shows the `symptom`
 * badge RED while `demo`/reachability stays GREEN. These six are never collapsed
 * into one green — each carries its own tone derived only from its own value.
 */

import type { ProofBadges } from "../../api/selfHealing.js";

/** The badge display order + human label. Stable across the funnel + detail. */
export const BADGE_ORDER: ReadonlyArray<{ readonly key: keyof ProofBadges; readonly label: string }> = [
  { key: "gate", label: "gate" },
  { key: "merged", label: "merged" },
  { key: "deploy", label: "deploy" },
  { key: "demo", label: "demo" },
  { key: "symptom", label: "symptom" },
  { key: "source", label: "source" },
];

export type BadgeTone = "pass" | "fail" | "warn" | "absent";

/** Derive one badge's tone from ONLY its own value — never from a sibling. */
export function badgeTone(value: string): BadgeTone {
  switch (value) {
    case "passed":
    case "bound":
    case "reachable":
    case "verified_closed":
      return "pass";
    case "failed":
    case "unreachable":
      return "fail";
    case "inconclusive":
    case "pending":
      return "warn";
    default:
      return "absent";
  }
}
