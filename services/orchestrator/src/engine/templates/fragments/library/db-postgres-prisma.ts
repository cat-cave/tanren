// DB — postgres + prisma. Adds the Prisma schema, the migrations directory, and the
// DATABASE_URL env declaration (collected into .env.example by processEnvVars).
//
// Stack-aware composition: depends on the node-pnpm runtime (prisma is a node tool).
// A ruby-bundler + postgres-prisma config is rejected at the dependency-resolve step.

import { RUNTIME_NODE_PNPM_ID } from "./runtime-node-pnpm.js";
import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const DB_POSTGRES_PRISMA_ID = "db-postgres-prisma" as const;

const PRISMA_SCHEMA = `// Tanren postgres-prisma — the seed schema. Extend with project models.
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model TanrenDemo {
  id        String   @id @default(cuid())
  createdAt DateTime @default(now())
  message   String
}
`;

const SEED_SCRIPT = `// Tanren prisma seed — a noop seed the project extends. Run via \`pnpm prisma db seed\`.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.tanrenDemo.create({ data: { message: "tanren seed ran" } });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
`;

const DB_TEST = `// A test that proves the prisma client is instantiable. The real db integration
// tests run under tier-2 against a test database; this is the structural baseline.
import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

describe("tanren prisma", () => {
  it("constructs a client (env DATABASE_URL is the lookup key)", () => {
    expect(() => new PrismaClient({ datasourceUrl: process.env["DATABASE_URL"] ?? "postgresql://noop" })).not.toThrow();
  });
});
`;

export const dbPostgresPrismaFragment: Fragment = {
  id: DB_POSTGRES_PRISMA_ID,
  version: "1.0.0",
  kind: "db",
  dependsOn: [RUNTIME_NODE_PNPM_ID],
  contract: {
    dbMigrationsDir: "prisma/migrations",
  },
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("prisma/schema.prisma", PRISMA_SCHEMA);
    vfs.write("prisma/migrations/.gitkeep", "");
    vfs.write("prisma/seed.ts", SEED_SCRIPT);
    vfs.write("tests/db.test.ts", DB_TEST);

    vfs.addPackageJsonDep("@prisma/client", "^6.0.0");
    vfs.addPackageJsonDevDep("prisma", "^6.0.0");

    vfs.addEnvVar("DATABASE_URL", "postgresql://tanren:tanren@localhost:5432/tanren");

    // Wire `prisma generate` into the bootstrap so a fresh checkout produces the
    // client (without it, `pnpm typecheck` fails — the @prisma/client package only
    // emits types after `prisma generate` reads the schema).
    vfs.appendToJustfileTarget("bootstrap", ["pnpm prisma generate"]);
  },
};
