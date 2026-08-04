# ds-4 Slice B — the render-worker image.
#
# The orchestrator host (NixOS) cannot launch a prebuilt chromium (missing FHS libs),
# but Playwright's official image is bookworm/FHS with the browsers pre-installed at
# /ms-playwright, so chromium launches here. The base image ships the browsers but NOT
# the `playwright` npm package, so we add exactly that (it detects the pre-installed
# browsers via PLAYWRIGHT_BROWSERS_PATH and skips the download). The host
# `podmanScreenshotRunner` bind-mounts /work and runs `node /app/screenshot.mjs`.
#
# Build (on the orchestrator host, where podman lives):
#   podman build -t localhost/tanren-render-worker:local \
#     services/orchestrator/docker/render-worker
# Override the tag the runner uses with TANREN_DS4_RENDER_IMAGE.
FROM mcr.microsoft.com/playwright:v1.50.0-noble
# A DETERMINISTIC base locale. The base image sets none, so the container inherits a
# C-family default whose meaning is architecture-dependent: an arm64 chromium maps the C
# family to `en_US_POSIX` and reports `navigator.language === "en-US@posix"`, which is not
# valid BCP-47 and throws in `Intl.PluralRules`. The screenshot path declares the
# scenario's locale explicitly per page; this makes the image's own default host-
# independent for everything else that runs here (e.g. the click driver).
ENV LANG=en_US.UTF-8
WORKDIR /app
# Pin the npm package to the image's browser version so chromium + the driver match.
RUN npm init -y >/dev/null 2>&1 && npm install playwright@1.50.0 >/dev/null 2>&1
COPY screenshot.mjs /app/screenshot.mjs
# rv-26.6 (apex P6): the interactive click-driver shares this image (same Playwright
# chromium). The host `podmanBrowserClickRunner` invokes `node /app/clickDriver.mjs`.
COPY clickDriver.mjs /app/clickDriver.mjs
# The container is invoked with an explicit `node /app/<script>.mjs` command per run.
