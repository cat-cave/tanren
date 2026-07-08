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
// DOCTRINE (fix/f2-exemplar-inline-literals — apex): every exemplar's `apply()`
// block calls the constrained-subset ops with LITERAL STRING ARGUMENTS ONLY. No
// module-scope `const FOO = "..."; vfs.write("path", FOO);` — the parser
// (`unifiedLibrary.ts:parseStringLiteral`) rejects an identifier argument LOUDLY,
// and the writer's rework loop cannot converge if the reference exemplar it is
// told to imitate is itself unparseable. Multi-line file contents use backtick
// template literals inlined at the call site (per the prompt's stated guidance:
// "Template literals (backticks) are also accepted for multi-line content. Do
// not interpolate."). The `fragmentAuthorerExemplars.test.ts` suite runs every
// exemplar through `parseFragmentBody` end-to-end — an exemplar that regresses
// to the identifier pattern fails LOUDLY in CI rather than silently poisoning
// the writer prompt.

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

export const runtimeNodePnpmFragment: Fragment = {
  id: "runtime-node-pnpm",
  version: "1.0.0",
  kind: "runtime",
  contract: {
    testRunner: "vitest",
    reportPath: "reports/junit.xml",
    ciTier2: "pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  },
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.overwrite("mise.toml", \`[tools]
node = "24"
pnpm = "11"
\`);
    vfs.write("package.json", \`{
  "name": "app",
  "version": "0.0.0",
  "private": true,
  "type": "module"
}
\`);
    vfs.write("tsconfig.json", \`{
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
\`);
    vfs.write("vitest.config.ts", \`import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: [["default", { summary: false }], ["junit", { outputFile: "reports/junit.xml" }]],
  },
});
\`);
    vfs.write("src/demo.ts", \`export function tanrenDemo(): string {
  return "tanren node-pnpm runtime ready";
}
\`);
    vfs.write("tests/demo.test.ts", \`import { describe, expect, it } from "vitest";
import { tanrenDemo } from "../src/demo.js";

describe("tanren demo", () => {
  it("returns the runtime-ready string", () => {
    expect(tanrenDemo()).toContain("node-pnpm runtime ready");
  });
});
\`);

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

export const deployFlyFragment: Fragment = {
  id: "deploy-fly",
  version: "1.0.0",
  kind: "deploy",
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("fly.toml", \`app = "TANREN_APP_NAME"
primary_region = "iad"

[build]
  builder = "paketobuildpacks/builder:base"

[http_service]
  internal_port = 3000
  force_https = true
\`);
    vfs.addEnvVar("FLY_API_TOKEN", "fly_token_provisioned_via_tanren_integration_grant");
    vfs.appendToJustfileTarget("deploy", ["flyctl deploy --remote-only"]);
  },
};
export default deployFlyFragment;
`,
};

// Exemplar: frontend — Remix. The reference frontend fragment (routes/, vite
// config, framework deps).
const FRONTEND_EXEMPLAR: FragmentExemplar = {
  fragmentId: "frontend-remix",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const frontendRemixFragment: Fragment = {
  id: "frontend-remix",
  version: "1.0.0",
  kind: "frontend",
  dependsOn: ["runtime-node-pnpm"],
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("app/root.tsx", \`import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";

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
\`);
    vfs.write("app/routes/_index.tsx", \`import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [{ title: "tanren remix runtime ready" }];

export default function Index() {
  return <main><h1>tanren remix runtime ready</h1></main>;
}
\`);
    vfs.write("tests/root.test.ts", \`import { describe, expect, it } from "vitest";
import App from "../app/root.js";

describe("tanren remix", () => {
  it("exports a root component", () => {
    expect(typeof App).toBe("function");
  });
});
\`);
    vfs.write("vite.config.ts", \`import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [remix()] });
\`);

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

// Exemplar: db — postgres + prisma. Reference db fragment: schema + migrations
// dir + owned DATABASE_URL env var + bootstrap-hook wiring for prisma generate.
const DB_EXEMPLAR: FragmentExemplar = {
  fragmentId: "db-postgres-prisma",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const dbPostgresPrismaFragment: Fragment = {
  id: "db-postgres-prisma",
  version: "1.0.0",
  kind: "db",
  dependsOn: ["runtime-node-pnpm"],
  contract: {
    dbMigrationsDir: "prisma/migrations",
  },
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("prisma/schema.prisma", \`generator client {
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
\`);
    vfs.write("prisma/migrations/.gitkeep", "");
    vfs.write("tests/db.test.ts", \`import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

describe("tanren prisma", () => {
  it("constructs a client (env DATABASE_URL is the lookup key)", () => {
    expect(() => new PrismaClient()).not.toThrow();
  });
});
\`);

    vfs.addPackageJsonDep("@prisma/client", "^6.0.0");
    vfs.addPackageJsonDevDep("prisma", "^6.0.0");

    vfs.addEnvVar("DATABASE_URL", "postgresql://tanren:tanren@localhost:5432/tanren");

    vfs.appendToJustfileTarget("bootstrap", ["pnpm prisma generate"]);
    vfs.appendToJustfileTarget("migrate", ["pnpm prisma migrate deploy"]);
  },
};
export default dbPostgresPrismaFragment;
`,
};

// Exemplar: addon — docker. Cross-cutting addon: writes a Dockerfile + .dockerignore.
const ADDON_EXEMPLAR: FragmentExemplar = {
  fragmentId: "addon-docker",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const addonDockerFragment: Fragment = {
  id: "addon-docker",
  version: "1.0.0",
  kind: "addon",
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("Dockerfile", \`FROM node:24-alpine AS builder
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
\`);
    vfs.write(".dockerignore", \`node_modules
dist
.git
.env
.env.*
reports
coverage
\`);
  },
};
export default addonDockerFragment;
`,
};

// Exemplar: backend — Fastify. A minimal server-framework exemplar. Owns the
// server surface: framework wiring + a health-check route + `just serve`.
// Deliberately DOES NOT set up the test runner (that's the runtime's job) or
// declare product env vars owned by db/deploy/auth slots.
const BACKEND_EXEMPLAR: FragmentExemplar = {
  fragmentId: "backend-fastify",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const backendFastifyFragment: Fragment = {
  id: "backend-fastify",
  version: "1.0.0",
  kind: "backend",
  dependsOn: ["runtime-node-pnpm"],
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("src/server.ts", \`import Fastify from "fastify";

export function buildServer() {
  const app = Fastify({ logger: true });
  app.get("/healthz", async () => ({ status: "ok" }));
  return app;
}

export async function startServer(port: number): Promise<void> {
  const app = buildServer();
  await app.listen({ port, host: "0.0.0.0" });
}
\`);
    vfs.write("tests/server.test.ts", \`import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("fastify server", () => {
  it("responds ok on /healthz", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
\`);

    vfs.addPackageJsonDep("fastify", "^5.0.0");

    vfs.appendToJustfileTarget("serve", ["node dist/server.js"]);
  },
};
export default backendFastifyFragment;
`,
};

// Exemplar: auth — a stub Auth.js setup. Owns the session/identity layer: the
// auth provider config + a protected-route helper + owned client-id/secret env
// vars. Deliberately DOES NOT touch db schema (that's the db fragment's job —
// auth CONSUMES the db, it does not model it) and DOES NOT declare DATABASE_URL.
const AUTH_EXEMPLAR: FragmentExemplar = {
  fragmentId: "auth-authjs",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const authAuthjsFragment: Fragment = {
  id: "auth-authjs",
  version: "1.0.0",
  kind: "auth",
  dependsOn: ["runtime-node-pnpm"],
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("src/auth.ts", \`import type { NextAuthConfig } from "@auth/core";

export const authConfig: NextAuthConfig = {
  providers: [],
  session: { strategy: "jwt" },
  callbacks: {
    authorized(params) {
      return Boolean(params.auth?.user);
    },
  },
};

export function requireSession(session: unknown): asserts session is { user: { id: string } } {
  if (session === null || session === undefined) {
    throw new Error("auth required");
  }
}
\`);
    vfs.write("tests/auth.test.ts", \`import { describe, expect, it } from "vitest";
import { authConfig, requireSession } from "../src/auth.js";

describe("auth-js config", () => {
  it("exposes a session strategy", () => {
    expect(authConfig.session?.strategy).toBe("jwt");
  });
  it("requireSession throws on null", () => {
    expect(() => requireSession(null)).toThrowError("auth required");
  });
});
\`);

    vfs.addPackageJsonDep("@auth/core", "^0.34.0");

    vfs.addEnvVar("AUTH_SECRET", "generate-a-strong-secret-at-provision-time");
    vfs.addEnvVar("AUTH_CLIENT_ID", "provider-client-id");
    vfs.addEnvVar("AUTH_CLIENT_SECRET", "provider-client-secret");
  },
};
export default authAuthjsFragment;
`,
};

// Exemplar: example — a seeded product example (todo domain). Product-specific
// behaviors + fixtures + minimal source. Deliberately does NOT overwrite
// runtime/frontend/backend/db config — it COMPOSES with them.
const EXAMPLE_EXEMPLAR: FragmentExemplar = {
  fragmentId: "example-todo",
  source: `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const exampleTodoFragment: Fragment = {
  id: "example-todo",
  version: "1.0.0",
  kind: "example",
  dependsOn: ["runtime-node-pnpm"],
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("src/example/todo.ts", \`export interface Todo {
  id: string;
  title: string;
  done: boolean;
}

export function completeTodo(todo: Todo): Todo {
  return { id: todo.id, title: todo.title, done: true };
}

export function activeCount(todos: readonly Todo[]): number {
  return todos.filter((t) => !t.done).length;
}
\`);
    vfs.write("src/example/todo.fixtures.ts", \`import type { Todo } from "./todo.js";

export const seedTodos: readonly Todo[] = [
  { id: "t1", title: "wire the demo", done: false },
  { id: "t2", title: "ship the exemplar", done: true },
];
\`);
    vfs.write("tests/example-todo.test.ts", \`import { describe, expect, it } from "vitest";
import { activeCount, completeTodo } from "../src/example/todo.js";
import { seedTodos } from "../src/example/todo.fixtures.js";

describe("example-todo", () => {
  it("completeTodo flips the done flag", () => {
    const t = completeTodo({ id: "x", title: "y", done: false });
    expect(t.done).toBe(true);
  });
  it("activeCount counts the not-done seeds", () => {
    expect(activeCount(seedTodos)).toBe(1);
  });
});
\`);
  },
};
export default exampleTodoFragment;
`,
};

// One exemplar per FragmentKind. Every kind now points at a dedicated exemplar
// shaped for THAT slot's responsibilities — the pre-fix map fell back to
// RUNTIME_EXEMPLAR for backend/auth/example, which taught the writer to touch
// runtime concerns (test runner, product env vars) in direct conflict with the
// slot-kind guidance that says those slots MUST NOT touch runtime. See Codex #7.
export const FRAGMENT_EXEMPLARS: Readonly<Record<FragmentKind, FragmentExemplar>> = {
  base: RUNTIME_EXEMPLAR,
  runtime: RUNTIME_EXEMPLAR,
  frontend: FRONTEND_EXEMPLAR,
  backend: BACKEND_EXEMPLAR,
  db: DB_EXEMPLAR,
  auth: AUTH_EXEMPLAR,
  addon: ADDON_EXEMPLAR,
  example: EXAMPLE_EXEMPLAR,
  deploy: DEPLOY_EXEMPLAR,
} as const;

/** Look up the exemplar the F2 prompt should embed for a given slot kind. */
export function exemplarFor(kind: FragmentKind): FragmentExemplar {
  return FRAGMENT_EXEMPLARS[kind];
}

/** Trim an exemplar body to fit the per-exemplar cap. Preserves the head (which
 * carries the load-bearing `Fragment` value declaration). */
export function truncateExemplar(source: string, max = EXEMPLAR_MAX_CHARS): string {
  if (source.length <= max) return source;
  return source.slice(0, max) + "\n// … (exemplar truncated for prompt size cap)\n";
}
