# Deployment and scaling

## Prepare

Install Docker Engine with Compose v2. Copy `.env.example` to `.env` and set two distinct JWT secrets (at least 32 characters), bootstrap tenant credentials, and `ENCRYPTION_KEY_BASE64` (32 random bytes encoded in base64). Set `PUBLIC_ORIGIN` to the browser's public HTTPS origin. Keep `.env` and database backups private. Preserve the encryption key separately: saved Baileys credentials and Cloud access tokens cannot be recovered without it.

Hostinger is the default storage provider. Deploy the private PHP endpoints from [`deploy/hostinger-api`](../deploy/hostinger-api/README.md), then set `HOSTINGER_STORAGE_API_URL` and `HOSTINGER_STORAGE_API_KEY` in `.env` before starting the API and worker. For a single Docker host, explicitly set `STORAGE_DRIVER=local` to use the shared `media_data` volume. For multiple hosts, set `STORAGE_DRIVER=s3` and configure S3 endpoint/region/bucket/key/secret so every API and worker sees the same objects. Recreate both API and worker after changing the driver. Do not expose the Hostinger key to the web app. The Compose stack does not bundle MinIO because its configured public container image is no longer anonymously pullable. Serve the web app behind TLS in production and terminate HTTPS before the web container. Forward WebSocket upgrades for `/socket.io/`.

## Start and seed

```sh
docker compose up -d --build --wait
docker compose run --rm api node apps/api/dist/seed.js
```

Open `PUBLIC_ORIGIN`, `/api/v1/health`, and `/docs`. Seeding the same tenant twice is idempotent. MongoDB and Redis have no host-published ports in the base Compose stack. Local `pnpm dev` uses `docker-compose.dev.yml` to expose them on loopback only.

## Scale sessions

```sh
docker compose up -d --scale worker=4
```

`MAX_SESSIONS_PER_WORKER` controls capacity per worker and is not an account or tenant limit. Each worker receives a unique runtime ID if `WORKER_ID` is unset. Redis leases and fencing tokens permit one live session per account. `LEASE_TTL_MS` controls failover time. Watch `hala_active_sessions`, queue age, and error counters in Observe. Scale worker count before the aggregate session count reaches total capacity; queue processors also scale with workers. For multiple API replicas, put them behind a load balancer and keep Redis Socket.IO adapter access.

## Cloud API

Set `CLOUD_APP_SECRET`, `CLOUD_WEBHOOK_VERIFY_TOKEN`, and `CLOUD_GRAPH_VERSION` in `.env`. Register `https://YOUR_HOST/api/v1/webhooks/whatsapp/cloud` in the Meta app, subscribe to messages and statuses, and use the matching verify token. Add a Cloud number through the web app with its phone number ID, WABA ID, and long-lived system-user token. Connect the account; the worker validates Graph access. Approved templates and interactive messages use the same outbound queue. Token rotation currently requires a controlled maintenance update of the encrypted account token; there is no self-service rotation endpoint.

## Verify and recover

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before release. CI also runs Testcontainers and the Playwright FakeProvider stack. For a local browser run, seed the stack with `docker-compose.e2e.yml`, set `E2E_BASE_URL`, and run `pnpm test:e2e`. Never use the FakeProvider override in production. Back up MongoDB, media storage, and encryption keys. Redis stores leases, queues, and rate-limit counters; preserve queue data if in-flight outbound work must survive a Redis restore.
