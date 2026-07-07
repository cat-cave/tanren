// F2 writer-prompt exemplars — one representative shipped fragment per slot kind.
//
// The F2 authorer prompt (`buildFragmentAuthorerPrompt`) embeds ONE exemplar per
// slot kind so the LLM sees a real, in-tree, shipped fragment shaped exactly like
// the constrained-subset body it must produce. Exemplars are stored as INLINE
// string constants (not read from disk) because:
//   - The orchestrator build is a bare `tsc` that drops non-JS/JSON files from
//     `dist/`; the `library/*.ts` sources are NOT copied into `dist/` (see
//     `scripts/copy-orchestrator-runtime-assets.mjs`). Reading the `.ts` files at
//     runtime would ENOENT in production.
//   - Inline constants make the prompt deterministic + zero-I/O in the hot path.
//
// DRIFT GUARD: the exemplars intentionally MIRROR the shipped library sources.
// The `fragmentAuthorerExemplars.test.ts` suite asserts each exemplar's substring
// signature still appears in the corresponding library file — a shipped-fragment
// refactor that renames a helper without updating the exemplar surfaces LOUDLY in
// CI rather than silently drifting the writer's guidance.

import type { FragmentKind } from "./types.js";

/** One exemplar entry: the fragment id it demonstrates + the TS source text. */
export interface FragmentExemplar {
  fragmentId: string;
  source: string;
}

// Character cap per exemplar in the assembled prompt (defensive — the runtime and
// ruby exemplars are ~8kb, so this preserves them but truncates any future outlier).
export const EXEMPLAR_MAX_CHARS = 8000;

// Exemplar: runtime — node + pnpm. The reference runtime fragment.
const RUNTIME_EXEMPLAR: FragmentExemplar = {
  fragmentId: "runtime-node-pnpm",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const RUNTIME_NODE_PNPM_ID = "runtime-node-pnpm" as const;

const TSCONFIG = \`{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
\`;

const VITEST_CONFIG = \`import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: [["default", { summary: false }], ["junit", { outputFile: "reports/junit.xml" }]],
  },
});
\`;

const DEMO_ENTRY = \`export function tanrenDemo(): string {
  return "tanren node-pnpm runtime ready";
}
\`;

const DEMO_TEST = \`import { describe, expect, it } from "vitest";
import { tanrenDemo } from "../src/demo.js";

describe("tanren demo", () => {
  it("returns the runtime-ready string", () => {
    expect(tanrenDemo()).toContain("node-pnpm runtime ready");
  });
});
\`;

export const runtimeNodePnpmFragment: Fragment = {
  id: RUNTIME_NODE_PNPM_ID,
  version: "1.0.0",
  kind: "runtime",
  contract: {
    testRunner: "vitest",
    reportPath: "reports/junit.xml",
    ciTier2: "pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  },
  async apply(vfs: VirtualFileSystem, config: TemplateConfig): Promise<void> {
    vfs.overwrite("mise.toml", "[tools]\\nnode = \\"24\\"\\npnpm = \\"11\\"\\n");
    vfs.write("package.json", "{}");
    vfs.write("tsconfig.json", TSCONFIG);
    vfs.write("vitest.config.ts", VITEST_CONFIG);
    vfs.write("src/demo.ts", DEMO_ENTRY);
    vfs.write("tests/demo.test.ts", DEMO_TEST);

    vfs.addPackageJsonDevDep("vitest", "^4.0.0");
    vfs.addPackageJsonDevDep("typescript", "^5.6.0");

    vfs.appendToJustfileTarget("bootstrap", ["pnpm install --no-frozen-lockfile"]);
    vfs.appendToJustfileTarget("tier-1", ["pnpm lint", "pnpm typecheck"]);
    vfs.appendToJustfileTarget("tier-2", [
      "mkdir -p reports",
      "pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
    ]);
    vfs.appendToJustfileTarget("tier-3", ["pnpm build"]);
    vfs.appendToJustfileTarget("build", ["pnpm build"]);
  },
};
export default runtimeNodePnpmFragment;
`,
};

// Exemplar: deploy — Fly.io. A minimal deploy fragment (fly.toml + provider token).
const DEPLOY_EXEMPLAR: FragmentExemplar = {
  fragmentId: "deploy-fly",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const DEPLOY_FLY_ID = "deploy-fly" as const;

const FLY_TOML = \`app = "TANREN_APP_NAME"
primary_region = "iad"

[build]
  builder = "paketobuildpacks/builder:base"

[http_service]
  internal_port = 3000
  force_https = true
\`;

export const deployFlyFragment: Fragment = {
  id: DEPLOY_FLY_ID,
  version: "1.0.0",
  kind: "deploy",
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("fly.toml", FLY_TOML);
    vfs.addEnvVar("FLY_API_TOKEN", "fly_token_provisioned_via_tanren_integration_grant");
  },
};
export default deployFlyFragment;
`,
};

// Exemplar: frontend — Remix. The reference frontend fragment (more feature-complete
// than the react-router alternative — routes/, vite config, framework deps).
const FRONTEND_EXEMPLAR: FragmentExemplar = {
  fragmentId: "frontend-remix",
  source: `import { RUNTIME_NODE_PNPM_ID } from "./runtime-node-pnpm.js";
import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const FRONTEND_REMIX_ID = "frontend-remix" as const;

const ROOT_TSX = \`import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
\`;

const INDEX_ROUTE = \`import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [{ title: "tanren remix runtime ready" }];

export default function Index() {
  return <main><h1>tanren remix runtime ready</h1></main>;
}
\`;

const ROOT_TEST = \`import { describe, expect, it } from "vitest";
import App from "../app/root.js";

describe("tanren remix", () => {
  it("exports a root component", () => {
    expect(typeof App).toBe("function");
  });
});
\`;

const VITE_CONFIG = \`import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [remix()] });
\`;

export const frontendRemixFragment: Fragment = {
  id: FRONTEND_REMIX_ID,
  version: "1.0.0",
  kind: "frontend",
  dependsOn: [RUNTIME_NODE_PNPM_ID],
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("app/root.tsx", ROOT_TSX);
    vfs.write("app/routes/_index.tsx", INDEX_ROUTE);
    vfs.write("tests/root.test.ts", ROOT_TEST);
    vfs.write("vite.config.ts", VITE_CONFIG);

    vfs.addPackageJsonDep("@remix-run/node", "^2.13.0");
    vfs.addPackageJsonDep("@remix-run/react", "^2.13.0");
    vfs.addPackageJsonDep("react", "^18.3.0");
    vfs.addPackageJsonDep("react-dom", "^18.3.0");
    vfs.addPackageJsonDevDep("@remix-run/dev", "^2.13.0");
    vfs.addPackageJsonDevDep("vite", "^5.4.0");
  },
};
export default frontendRemixFragment;
`,
};

// Exemplar: db — postgres + prisma. Reference db fragment: schema + migrations dir
// + owned DATABASE_URL env var + bootstrap-hook wiring for `prisma generate`.
const DB_EXEMPLAR: FragmentExemplar = {
  fragmentId: "db-postgres-prisma",
  source: `import { RUNTIME_NODE_PNPM_ID } from "./runtime-node-pnpm.js";
import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const DB_POSTGRES_PRISMA_ID = "db-postgres-prisma" as const;

const PRISMA_SCHEMA = \`generator client {
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
\`;

const DB_TEST = \`import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

describe("tanren prisma", () => {
  it("constructs a client (env DATABASE_URL is the lookup key)", () => {
    expect(() => new PrismaClient({ datasourceUrl: process.env["DATABASE_URL"] ?? "postgresql://noop" })).not.toThrow();
  });
});
\`;

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
    vfs.write("tests/db.test.ts", DB_TEST);

    vfs.addPackageJsonDep("@prisma/client", "^6.0.0");
    vfs.addPackageJsonDevDep("prisma", "^6.0.0");

    vfs.addEnvVar("DATABASE_URL", "postgresql://tanren:tanren@localhost:5432/tanren");

    vfs.appendToJustfileTarget("bootstrap", ["pnpm prisma generate"]);
  },
};
export default dbPostgresPrismaFragment;
`,
};

// Exemplar: addon — docker. Cross-cutting addon: writes a Dockerfile + .dockerignore.
const ADDON_EXEMPLAR: FragmentExemplar = {
  fragmentId: "addon-docker",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const ADDON_DOCKER_ID = "addon-docker" as const;

const DOCKERIGNORE = \`node_modules
dist
.git
.env
.env.*
reports
coverage
\`;

const NODE_DOCKERFILE = \`FROM node:24-alpine AS builder
ENV CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
CMD ["node", "dist/index.js"]
\`;

export const addonDockerFragment: Fragment = {
  id: ADDON_DOCKER_ID,
  version: "1.0.0",
  kind: "addon",
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("Dockerfile", NODE_DOCKERFILE);
    vfs.write(".dockerignore", DOCKERIGNORE);
  },
};
export default addonDockerFragment;
`,
};

// The kinds without a natural shipped exemplar (backend / auth / example): each
// falls back to the runtime exemplar so the writer still sees a full, real,
// constrained-subset fragment shape (better than an empty section). The
// slot-kind guidance section already covers what the writer must produce for these.
export const FRAGMENT_EXEMPLARS: Readonly<Record<FragmentKind, FragmentExemplar>> = {
  base: RUNTIME_EXEMPLAR,
  runtime: RUNTIME_EXEMPLAR,
  frontend: FRONTEND_EXEMPLAR,
  backend: RUNTIME_EXEMPLAR,
  db: DB_EXEMPLAR,
  auth: RUNTIME_EXEMPLAR,
  addon: ADDON_EXEMPLAR,
  example: RUNTIME_EXEMPLAR,
  deploy: DEPLOY_EXEMPLAR,
} as const;

/** Look up the exemplar the F2 prompt should embed for a given slot kind. Falls
 * back to the runtime exemplar when the kind has no dedicated shipped analog. */
export function exemplarFor(kind: FragmentKind): FragmentExemplar {
  return FRAGMENT_EXEMPLARS[kind];
}

/** Trim an exemplar body to fit the per-exemplar cap. Preserves the head (which
 * carries the load-bearing `Fragment` value declaration). */
export function truncateExemplar(source: string, max = EXEMPLAR_MAX_CHARS): string {
  if (source.length <= max) return source;
  return source.slice(0, max) + "\n// … (exemplar truncated for prompt size cap)\n";
}
