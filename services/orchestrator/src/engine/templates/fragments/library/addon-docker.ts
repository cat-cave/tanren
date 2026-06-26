// ADDON — docker. Stack-agnostic: emits a Dockerfile + .dockerignore tuned to the
// chosen runtime (node-pnpm vs ruby-bundler). No dependency on a specific runtime;
// inspects `config.runtime` to choose the FROM image.

import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const ADDON_DOCKER_ID = "addon-docker" as const;

const DOCKERIGNORE = `node_modules
dist
.git
.env
.env.*
reports
coverage
.turbo
.stryker-tmp
`;

function nodeDockerfile(): string {
  return `# Multi-stage node-pnpm build — runs the project's \`just build\` and ships the dist/.
FROM node:24-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:24-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
CMD ["node", "dist/index.js"]
`;
}

function rubyDockerfile(): string {
  return `# Ruby-bundler build — installs gems, exposes the rake-built artifact.
FROM ruby:3.4-alpine
RUN apk add --no-cache build-base
WORKDIR /app
COPY Gemfile Gemfile.lock* ./
RUN bundle install
COPY . .
CMD ["bundle", "exec", "rake"]
`;
}

export const addonDockerFragment: Fragment = {
  id: ADDON_DOCKER_ID,
  version: "1.0.0",
  kind: "addon",
  contract: {},
  async apply(vfs: VirtualFileSystem, config: TemplateConfig): Promise<void> {
    vfs.write("Dockerfile", config.runtime === "ruby-bundler" ? rubyDockerfile() : nodeDockerfile());
    vfs.write(".dockerignore", DOCKERIGNORE);
  },
};
