import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/src/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
});
