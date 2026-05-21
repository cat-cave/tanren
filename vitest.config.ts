import { MergifyReporter } from "@mergifyio/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["default", new MergifyReporter()],
  },
});
