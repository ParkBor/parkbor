# ParkBor CRM (admin SPA) for Railway: Vite build + unprivileged nginx on $PORT.
# Build context is the REPO ROOT (pnpm workspace). Railway: Root Directory "/", variable
# RAILWAY_DOCKERFILE_PATH=deploy/railway/crm/Dockerfile (docs/RAILWAY.md). The same file builds
# locally:  docker build -f deploy/railway/crm/Dockerfile --build-arg VITE_TELEGRAM_BOT_USERNAME=x .
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
# Public (non-secret) build-time values: they end up in the JS bundle. Railway passes service
# variables with these names as build args because they are declared here.
ARG VITE_API_URL=https://api.parkbor.uz/api/v1
ARG VITE_TELEGRAM_BOT_USERNAME
ARG VITE_TILE_URL=
ENV VITE_API_URL=$VITE_API_URL \
    VITE_TELEGRAM_BOT_USERNAME=$VITE_TELEGRAM_BOT_USERNAME \
    VITE_TILE_URL=$VITE_TILE_URL
RUN pnpm --filter admin build

FROM nginxinc/nginx-unprivileged:1.27-alpine
# The stock default.conf also listens on 8080: drop it, then return to non-root.
USER root
RUN rm -f /etc/nginx/conf.d/default.conf && chown nginx:nginx /etc/nginx/conf.d
USER 101
COPY deploy/railway/crm/nginx.conf /etc/nginx/nginx.conf
# Single source of truth for the shared security headers (also used by the compose edge).
COPY infra/nginx/snippets/security-headers.conf /etc/nginx/snippets/security-headers.conf
# Rendered by the image entrypoint (envsubst) into /etc/nginx/conf.d at container start. Only
# ${PORT} and ${API_ORIGIN} are substituted; nginx's own $variables stay intact.
COPY deploy/railway/crm/crm.conf.template /etc/nginx/templates/crm.conf.template
COPY --from=admin-build /repo/admin/dist /usr/share/nginx/admin
# Railway overrides PORT at runtime; API_ORIGIN must match the origin of VITE_API_URL (CSP).
ENV PORT=8080 \
    API_ORIGIN=https://api.parkbor.uz \
    NGINX_ENVSUBST_FILTER="^(PORT|API_ORIGIN)$"
EXPOSE 8080
