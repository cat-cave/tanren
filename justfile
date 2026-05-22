set shell := ["bash", "-euo", "pipefail", "-c"]

default:
  just --list

format-check:
  corepack pnpm run format:check

lint:
  corepack pnpm run lint

architecture:
  corepack pnpm run check:architecture

schema-drift:
  corepack pnpm run check:schema-drift

typecheck:
  corepack pnpm run typecheck

fast-check: format-check lint architecture schema-drift typecheck test compose-config

test:
  corepack pnpm run test

build:
  corepack pnpm run build

compose-config:
  corepack pnpm run compose:config

ci: format-check lint architecture schema-drift typecheck test build compose-config

compose-build:
  docker compose build orchestrator dashboard runner

runner-key:
  test -f /tmp/tanren_runner_key || ssh-keygen -t ed25519 -N "" -f /tmp/tanren_runner_key

compose-up: runner-key
  TANREN_RUNNER_AUTHORIZED_KEY="$(cat /tmp/tanren_runner_key.pub)" TANREN_RUNNER_IDENTITY_PRIVATE_KEY="$(cat /tmp/tanren_runner_key)" docker compose up -d postgres vault orchestrator dashboard runner ntfy

compose-down:
  docker compose down -v

wait-for-stack:
  ./scripts/wait-for-url.sh http://localhost:3100/healthz
  ./scripts/wait-for-url.sh http://localhost:3000/healthz

smoke-hello:
  corepack pnpm --filter @tanren/cli tanren doctor
  summary="$(corepack pnpm --filter @tanren/cli tanren hello)"; echo "$summary"; run_id="$(printf '%s' "$summary" | node -e 'let input = ""; process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => console.log(JSON.parse(input).runId));')"; corepack pnpm --filter @tanren/cli tanren status "$run_id"
  ssh -i /tmp/tanren_runner_key -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/tmp/tanren_runner_known_hosts tanren@localhost 'echo tanren-runner-ok'

smoke-ssh-integration:
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_SSH_INTEGRATION=1 TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/ssh.integration.test.ts

live-codex-writer:
  test -n "${TANREN_CODEX_AUTH_JSON_FILE:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_CODEX_LIVE=1 TANREN_CODEX_AUTH_JSON_FILE="${TANREN_CODEX_AUTH_JSON_FILE}" TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/codexWriter.live.test.ts

live-codex-answerer:
  test -n "${TANREN_CODEX_AUTH_JSON_FILE:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_CODEX_ANSWERER_LIVE=1 TANREN_CODEX_AUTH_JSON_FILE="${TANREN_CODEX_AUTH_JSON_FILE}" TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/codexAnswerer.live.test.ts

live-github-draft-pr:
  test -n "${TANREN_GITHUB_TOKEN_FILE:-}"
  test -n "${TANREN_GITHUB_REPO_URL:-}"
  fingerprint="$(ssh-keyscan -p 2222 -t ed25519 localhost 2>/dev/null | ssh-keygen -lf - -E sha256 | awk 'NR == 1 { print $2 }')"; test -n "$fingerprint"; TANREN_GITHUB_LIVE=1 TANREN_GITHUB_TOKEN_FILE="${TANREN_GITHUB_TOKEN_FILE}" TANREN_GITHUB_REPO_URL="${TANREN_GITHUB_REPO_URL}" TANREN_GITHUB_BASE_BRANCH="${TANREN_GITHUB_BASE_BRANCH:-main}" TANREN_SSH_KEY_PATH=/tmp/tanren_runner_key TANREN_SSH_HOST=127.0.0.1 TANREN_SSH_PORT=2222 TANREN_SSH_USER=tanren TANREN_SSH_HOST_FINGERPRINT="$fingerprint" TANREN_SSH_HOST_KEY_ALGORITHMS=ssh-ed25519 corepack pnpm exec vitest run services/orchestrator/tests/githubDraftPr.live.test.ts

live-ci-poll:
  test -n "${TANREN_GITHUB_TOKEN_FILE:-}"
  TANREN_GITHUB_TOKEN_FILE="${TANREN_GITHUB_TOKEN_FILE}" corepack pnpm exec vitest run services/orchestrator/tests/ciPolling.test.ts -t "live CI polling fixture"

smoke: compose-build compose-up wait-for-stack smoke-hello smoke-ssh-integration
