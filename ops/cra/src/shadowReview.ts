import { resolve } from "node:path";
import type { CraPaths } from "./paths.js";
import { atomicWriteFile } from "./filesystem.js";
import { buildReviewMarker, type ReviewMarkerKey } from "./reviewMarker.js";
import type { ReviewPoster } from "./reviewOnce.js";

// Deliberately has no token, gh command, or mutation gateway. In shadow mode the
// official-review seam is replaced by this local-only draft writer.
export class ShadowReviewPoster implements ReviewPoster {
  public constructor(private readonly paths: CraPaths) {}

  public async post(key: ReviewMarkerKey, triage: Parameters<ReviewPoster["post"]>[1]) {
    const path = resolve(this.paths.draftsDirectory, `${key.pr}-${key.headSha}-${key.rubricVersion}.json`);
    await atomicWriteFile(
      path,
      `${JSON.stringify(
        {
          type: "CRA_SHADOW_DRAFT",
          marker: buildReviewMarker(key),
          pr: key.pr,
          headSha: key.headSha,
          rubricVersion: key.rubricVersion,
          verdict: triage.verdict,
          counts: triage.counts,
          findings: triage.findings,
        },
        null,
        2,
      )}\n`,
    );
    return { posted: false, reviewId: null, verdict: triage.verdict };
  }
}
