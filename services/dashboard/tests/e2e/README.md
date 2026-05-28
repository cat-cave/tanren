# Dashboard shell e2e smoke (LOCAL-ONLY)

This Playwright smoke exercises the two interactive behaviors the
`app.request` rendered-HTML tests cannot: the ⌘K palette opening in a real
browser, and the ink/ash theme toggle persisting across a reload.

## It is NOT part of the CI gate — on purpose

`just ci` / `just fast-check` run the `app.request` rendered-HTML tests
(`../shell.render.test.ts`) as the hard gate. The Playwright smoke is **not**
wired into either, and **no pixel/screenshot diff is wired into CI**. Rationale:

- The shell was recreated from the vendored hi-fi **design-tool** prototype.
  Design-tool rendering differs from a real browser (font metrics, sub-pixel
  layout, `oklch`/`clip-path` rasterisation), so pixel diffs against the hi-fi
  screenshots would be noisy and would break the green-CI merge gate that every
  PR must pass.
- `@playwright/test` and its browser binaries are heavy and are deliberately
  kept out of the CI dependency set.

The CI hard gate for this surface is the rendered-HTML assertions only.

## Running it manually

```sh
cd services/dashboard
pnpm add -D @playwright/test        # not a committed dependency
pnpm exec playwright install chromium
pnpm build                          # builds the client-islands bundle into dist/static
TANREN_REQUIRE_AUTH=0 pnpm start    # serve the shell on :3000 (another shell)
pnpm test:e2e                        # runs tests/e2e/*.spec.ts
```

Point at a different instance with `DASHBOARD_E2E_URL=http://host:port`.
