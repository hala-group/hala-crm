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

### Firebase message push rollout

1. Select the Firebase project for CRM explicitly. Prefer a dedicated Web app named `Hala CRM` when a project also serves other applications. Enable the Firebase Cloud Messaging HTTP v1 API and FCM Registration API for that project.
2. In Firebase Project settings > Cloud Messaging > Web Push certificates, import the existing CRM `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` pair. Set `FIREBASE_VAPID_KEY` to that same public key. Never replace a shared project's existing Web Push key without checking which other applications use it.
3. Copy the Web app's public config into the API service variables: `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_APP_ID`.
4. Provision a service account for message delivery with `cloudmessaging.messages.create` on the selected project. Put its base64-encoded JSON in the API service's `FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64` secret. Do not put this JSON in the repository, browser build, issue tracker, or chat. Base64 does not encrypt it. The API validates that the service account and Web app project IDs match.
5. Deploy API and web from the same revision. All seven Firebase variables must be present together; no Firebase variables means message push is disabled. Worker configuration does not need Firebase credentials. Use HTTPS and the production Angular build so `ngsw-worker.js` is registered.
6. Sign in as an authorized user, open **الملف الشخصي → إشعارات الرسائل**, click **تفعيل إشعارات الرسائل**, and allow notifications in the browser. No permission prompt should appear just from signing in. Enable call push separately if wanted.
7. Send a new inbound WhatsApp message from a test sender to an authorized number. Verify a generic notification with the tab foregrounded, backgrounded, and closed. Click it and verify it opens the correct conversation. History import and outbound messages must not produce a new-message push.
8. Verify isolation with two test users: an unauthorized account must receive nothing, and removing account membership must stop subsequent notifications. Test disabling message push while keeping call push active, disabling call push while keeping messages active, logout, and login restoration of prior opt-in. Never use real customer contents in a test payload.
9. If enabling fails because the existing browser subscription uses an older VAPID key, correct the server/Firebase keys first, then have the user re-enrol that browser. Do not rotate a working production key just to fix a single browser.

Passing unit tests and a successful Firebase send response do not prove that a browser displayed the notification. Complete the foreground/background/closed-tab checks before marking the rollout verified.

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` before release. CI also runs Testcontainers and the Playwright FakeProvider stack. For a local browser run, seed the stack with `docker-compose.e2e.yml`, set `E2E_BASE_URL`, and run `pnpm test:e2e`. Never use the FakeProvider override in production. Back up MongoDB, media storage, and encryption keys. Redis stores leases, queues, and rate-limit counters; preserve queue data if in-flight outbound work must survive a Redis restore.
