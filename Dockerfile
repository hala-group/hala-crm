FROM node:24-bookworm-slim AS workspace
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
ENV MONGOMS_DISABLE_POSTINSTALL=1
RUN --mount=type=cache,id=hala-pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @hala/shared build

FROM workspace AS api-build
RUN pnpm --filter @hala/api build

FROM workspace AS worker-build
RUN pnpm --filter @hala/worker build

FROM workspace AS web-build
RUN pnpm --filter @hala/web build

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-build /app /app
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]

FROM node:24-bookworm-slim AS worker
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=worker-build /app /app
CMD ["node", "apps/worker/dist/main.js"]

FROM nginx:1.29-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist/browser /usr/share/nginx/html
EXPOSE 80
