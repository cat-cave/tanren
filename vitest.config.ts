import { MergifyReporter } from "@mergifyio/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tanren/db": new URL("./db/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    reporters: ["default", new MergifyReporter()],
    // P2A-0015: the fixture content under fixtures/acceptance-medium/ is
    // pushed verbatim to the operator-pre-created GitHub repo by the
    // medium acceptance gate. The placeholder vitest test there is meant
    // to run inside the fixture repo's CI, not in the Tanren repo's CI.
    // `.claude/**` excludes Claude Code agent worktrees, which are full
    // checkouts of the repo and would otherwise be discovered (and re-run)
    // by vitest during local development.
    exclude: ["**/node_modules/**", "**/dist/**", "fixtures/**", ".claude/**"]
  }
});
