FROM node:22.23.1-bookworm AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY protocol ./protocol
COPY scripts ./scripts
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22.23.1-bookworm-slim AS runtime

ARG CODEX_VERSION
RUN test -n "$CODEX_VERSION" \
    && printf '%s\n' "$CODEX_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && install -d -o node -g node -m 0700 /run/codex-channel-bridge

WORKDIR /app
COPY --from=build --chown=node:node /app /app

ENV NODE_ENV=production
STOPSIGNAL SIGTERM
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/packages/cli/dist/main.js", "status", "--endpoint", "/run/codex-channel-bridge/control.sock"]
ENTRYPOINT ["node", "/app/packages/cli/dist/main.js", "supervisor", "run"]
CMD ["--config", "/etc/codex-channel-bridge/config.yaml", "--endpoint", "/run/codex-channel-bridge/control.sock"]
