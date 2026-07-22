// FRONTEND — remix. Adds a minimal Remix (Vite) app atop the node-pnpm runtime.
//
// Composition: depends on the node-pnpm runtime (the ruby-bundler runtime never
// writes a package.json the Remix dev server could mount into). The dependency
// is expressed via `dependsOn` so the library load-order resolver throws on the
// bad combination at registry time, not at runtime.
//
// Why Remix as a fragment: captured operator notes commonly say
// "ts/pnpm + Remix + PostgreSQL + Fly". Without this fragment, that lifecycle
// has no resolvable frontend slot and `selectFragmentConfig` returns a
// `missing-fragments` decision that triggers a per-fragment authoring run for
// frontend-remix on first use. Shipping the bundled core entry avoids the
// authoring-run round trip for that very common config.

import { RUNTIME_NODE_PNPM_ID } from "./runtime-node-pnpm.js";
import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const FRONTEND_REMIX_ID = "frontend-remix" as const;

const ROOT_TSX = `import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";

// Tanren remix app shell — extend the route tree under app/routes/.
export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
`;

const INDEX_ROUTE = `import type { MetaFunction } from "@remix-run/node";

export const meta: MetaFunction = () => [
  { title: "tanren remix runtime ready" },
];

export default function Index() {
  return (
    <main>
      <h1>tanren remix runtime ready</h1>
    </main>
  );
}
`;

const ROOT_TEST = `// Remix smoke — proves the root module exports a valid React component.
import { describe, expect, it } from "vitest";
import App from "../app/root.js";

describe("tanren remix", () => {
  it("exports a root component", () => {
    expect(typeof App).toBe("function");
  });
});
`;

const VITE_CONFIG = `import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [remix()],
});
`;

const TSCONFIG_REMIX = `{
  "extends": "./tsconfig.json",
  "include": ["app/**/*", "vite.config.ts"],
  "compilerOptions": {
    "jsx": "react-jsx"
  }
}
`;

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
    vfs.write("tsconfig.remix.json", TSCONFIG_REMIX);

    vfs.addPackageJsonDep("@remix-run/node", "^2.13.0");
    vfs.addPackageJsonDep("@remix-run/react", "^2.13.0");
    vfs.addPackageJsonDep("@remix-run/serve", "^2.13.0");
    vfs.addPackageJsonDep("react", "^18.3.0");
    vfs.addPackageJsonDep("react-dom", "^18.3.0");
    vfs.addPackageJsonDevDep("@remix-run/dev", "^2.13.0");
    vfs.addPackageJsonDevDep("@types/react", "^18.3.0");
    vfs.addPackageJsonDevDep("@types/react-dom", "^18.3.0");
    vfs.addPackageJsonDevDep("vite", "^5.4.0");
  },
};
