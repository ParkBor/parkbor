# nginx edge image: builds the admin SPA and serves it next to the reverse-proxy config.
# Build context is the REPO ROOT (pnpm workspace):  docker build -f infra/nginx/Dockerfile .
FROM node:22-alpine AS admin-build
RUN corepack enable
WORKDIR /repo
# Manifests first so the dependency layer is cached until a lockfile changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY admin/package.json admin/
COPY mobile/package.json mobile/
COPY packages/api-client/package.json packages/api-client/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter admin...
COPY packages packages
COPY admin admin
# Public (non-secret) build-time values: they end up in the JS bundle.
ARG VITE_API_URL=/api/v1
ARG VITE_TELEGRAM_BOT_USERNAME
ARG VITE_TILE_URL=
ENV VITE_API_URL=$VITE_API_URL \
    VITE_TELEGRAM_BOT_USERNAME=$VITE_TELEGRAM_BOT_USERNAME \
    VITE_TILE_URL=$VITE_TILE_URL
RUN pnpm --filter admin build

FROM nginxinc/nginx-unprivileged:1.27-alpine
# The stock default.conf also listens on 8080 as default_server: drop it, then return to non-root.
USER root
RUN rm -f /etc/nginx/conf.d/default.conf && chown nginx:nginx /etc/nginx/conf.d
USER 101
# Replaces the stock config entirely (pid/temp paths are writable for the non-root user).
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/snippets/ /etc/nginx/snippets/
# *.template files are rendered by the image entrypoint (envsubst) into /etc/nginx/conf.d.
COPY infra/nginx/templates/ /etc/nginx/templates/
COPY --from=admin-build /repo/admin/dist /usr/share/nginx/admin
EXPOSE 8080 8443
