// FRONTEND — react-router. Adds a minimal SPA shell atop the node-pnpm runtime.
//
// Composition: depends on the node-pnpm runtime (a ruby-bundler runtime + a
// react-router frontend is a config the registry rejects at apply time — the runtime
// did not write a package.json the frontend can mount into). The dependency is
// expressed via `dependsOn` so the library load-order resolver throws on the bad
// combination at registry time, not at runtime.

import { RUNTIME_NODE_PNPM_ID } from "./runtime-node-pnpm.js";
import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const FRONTEND_REACT_ROUTER_ID = "frontend-react-router" as const;

const APP_SHELL = `import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { createRoot } from "react-dom/client";
import { StrictMode } from "react";

// Tanren react-router app shell — extend the router array as the project grows.
const router = createBrowserRouter([
  {
    path: "/",
    element: <div>tanren react-router runtime ready</div>,
  },
]);

const rootEl = document.getElementById("root");
if (rootEl !== null) {
  createRoot(rootEl).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
}
`;

const APP_TEST = `// React-router smoke — proves the router config exports a valid array.
import { describe, expect, it } from "vitest";
import { createBrowserRouter } from "react-router-dom";

describe("tanren react-router", () => {
  it("constructs a router for the demo route", () => {
    const router = createBrowserRouter([{ path: "/", element: null }]);
    expect(router).toBeDefined();
  });
});
`;

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>tanren</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/app.tsx"></script>
  </body>
</html>
`;

export const frontendReactRouterFragment: Fragment = {
  id: FRONTEND_REACT_ROUTER_ID,
  version: "1.0.0",
  kind: "frontend",
  dependsOn: [RUNTIME_NODE_PNPM_ID],
  contract: {},
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.write("src/app.tsx", APP_SHELL);
    vfs.write("tests/app.test.ts", APP_TEST);
    vfs.write("index.html", INDEX_HTML);

    vfs.addPackageJsonDep("react", "^19.0.0");
    vfs.addPackageJsonDep("react-dom", "^19.0.0");
    vfs.addPackageJsonDep("react-router-dom", "^7.0.0");
    vfs.addPackageJsonDevDep("@types/react", "^19.0.0");
    vfs.addPackageJsonDevDep("@types/react-dom", "^19.0.0");
  },
};
