import { MergifyReporter } from "@mergifyio/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tanren/db": new URL("./db/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    reporters: ["default", new MergifyReporter()]
  }
});
