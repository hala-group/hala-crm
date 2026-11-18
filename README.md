# Hala CRM

Multi-tenant WhatsApp inbox with per-number authorization, call history, and horizontally scaled workers. See [the specification](docs/HALA_CRM_SPEC.md), [decisions](docs/DECISIONS.md), and [deployment guide](docs/DEPLOYMENT.md).

## Prerequisites

Node.js 24 LTS, pnpm 11.25 or compatible, and Docker Compose. Copy `.env.example` to `.env`. Set two different random JWT secrets of at least 32 characters, plus `BOOTSTRAP_TENANT_SLUG`, `BOOTSTRAP_TENANT_NAME`, `BOOTSTRAP_OWNER_EMAIL`, and a `BOOTSTRAP_OWNER_PASSWORD` of at least 12 characters. Set `ENCRYPTION_KEY_BASE64` to a base64-encoded 32-byte random key (for example, generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`). Keep `.env` private and back up the encryption key securely; losing it makes saved WhatsApp credentials unreadable.

## Local development

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts MongoDB, Redis, API, worker, and Angular web. Configure the Hostinger API URL and server-only API key in `.env` before starting; `STORAGE_DRIVER=hostinger` is the default. Deploy `deploy/hostinger-api/api` using its README. To use local storage instead, set `STORAGE_DRIVER=local`; S3-compatible storage is available with `STORAGE_DRIVER=s3` and the corresponding S3 variables. In a second terminal, initialize the tenant once with `pnpm seed`. Open `http://localhost:4200`, `http://localhost:3000/api/v1/health`, and `http://localhost:3000/docs`.

Sign in using the owner email and password. The app opens the inbox after sign-in; the dashboard remains available at `/dashboard`. The sign-in page gets its tenant from `BOOTSTRAP_TENANT_SLUG` in `.env`; the API still accepts an optional tenant slug for multi-tenant clients. Use **Roles** to create a custom role and **Users** to invite a user. The invitation token is returned only in the creation response; deliver it manually and enter it at `/accept-invite`. Passwords use Argon2id. Access tokens remain in browser memory; refresh tokens use rotating HttpOnly cookies with reuse detection. Suspensions and role changes take effect on the next request.

Open **أرقام واتساب** to add a Baileys or Cloud API number. The creator receives `manage` membership. Connect a Baileys number and scan the QR from the account modal; Cloud API uses a configured token and signed webhook. Members can be granted `view`, `reply`, or `manage` access by user ID; role permission and membership must both allow an action. Status and QR events use `/realtime` Socket.IO. QR is sent only to managers. A membership change immediately updates the user's rooms and permission state. The owner/admin `accounts:access_all` permission gives access to every number in that tenant.

Number managers can use **مزامنة الرسائل** on a connected Baileys number to fetch older messages for known chats that have a saved WhatsApp message. The worker requests successive pages and adds the history WhatsApp returns without deleting existing records. Keep the primary phone online while the request runs. The result depends on the history WhatsApp makes available to the linked device.

If the initial import is interrupted, use **مزامنة الرسائل** to replay any recently cached history notifications whose WhatsApp links are still valid. To request fresh history when it cannot be replayed, use **تسجيل الخروج** on the existing number, then link the same number again with its new QR code. This preserves the messages already stored by Hala CRM.

**مسح الدردشات وإعادة استيرادها** deletes that number's conversations, messages, and media, logs the linked session out, then starts a fresh QR pairing. Scan the new QR code to import the chats and messages WhatsApp offers at pairing. Tenant contacts remain stored because they can be shared by multiple numbers.

**حذف الرقم** permanently removes that number and its conversations, messages, stored media, and calls from Hala CRM after the WhatsApp session stops. The confirmation dialog warns that this cannot be undone. Shared tenant contacts and mandatory audit records remain.

WhatsApp may import a contact with only its anonymous LID and no phone number. Hala CRM shows the phone when WhatsApp supplies a phone/LID mapping through contact metadata, a message, or a phone-number-share event. Otherwise the inbox labels the phone as unavailable and shows a short identifier; an anonymous LID cannot be converted into a phone number by trimming its digits.

Each worker owns up to `MAX_SESSIONS_PER_WORKER` live sessions. This is a per-worker resource setting, not a tenant/account limit. Run additional workers with distinct `WORKER_ID` values against the same MongoDB and Redis to spread numbers. Leases expire after `LEASE_TTL_MS`; a surviving worker restores a session from encrypted MongoDB credentials after failover without a new QR. Workers must share the same `ENCRYPTION_KEY_BASE64`. A single machine can use the default generated worker ID, but a stable unique ID helps operational logs. The API and workers communicate through Redis leases, BullMQ command queues, and Redis events.

Open **المحادثات** to view inbound and linked-phone outgoing messages. The inbox supports account and text filters; paginated conversations and messages; live updates; and protected media previews. The contact panel shows the name, phone, private profile picture, WhatsApp about text and shared groups when available, plus a paginated media list. Baileys refreshes about and shared groups through the connected worker; privacy settings and unsupported providers may leave them unavailable. Every WhatsApp message is normalized in the Baileys adapter and persisted through the shared BullMQ `wa-inbound` queue. The worker stores media through the configured storage provider (Hostinger by default), with SHA-256 metadata and image thumbnails. Set `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, and `S3_REGION` for an external S3 endpoint. Local storage paths resolve from the monorepo root for both API and worker. Set `MEDIA_MAX_BYTES` to cap downloaded media (default 50 MiB). If WhatsApp returns 403, 404, or 410 for an expired media URL, the connected Baileys session asks WhatsApp for a refreshed path and retries once. Old media may still be impossible to decrypt even after WhatsApp refreshes its path; verify recovery before using the destructive clear-and-reimport action. All inbox REST endpoints and Socket.IO events apply the user's role and number membership; assigned conversations are filtered further by CASL.

On a fresh Baileys QR pairing, the worker automatically requests full WhatsApp history and imports messages that WhatsApp delivers through `messaging-history.set`. To retry an already linked number, use **تسجيل خروج واتساب**, then **ربط** and scan the new QR code on the phone; existing Hala contacts and conversations remain stored. Import runs asynchronously after pairing, needs no file export, and deduplicates existing WhatsApp message IDs. Imported messages do not increase unread counts. WhatsApp controls which old chats and messages it sends, and undecryptable items are skipped; a successful connection alone does not confirm that old history was imported. The **استيراد سجل الرسائل** action on an already connected number remains an optional on-demand request for up to 100 older messages per known conversation, but WhatsApp may acknowledge it without returning history. Cloud API numbers do not support this action.

The composer supports text, images, video, audio, voice notes, documents, stickers, location, contacts, reactions, polls, and Cloud API templates/interactive messages. Choose a connected number and open a conversation, then use the type selector and send button. Reply, mentions, edit, local/everyone delete, forward, retry, drag/drop and paste attachments, voice recording, and protected media previews are available in the inbox. The UI hides types not supported by the selected provider. The API validates the same capability set and requires both role permission and `reply` membership. `POST /media/upload` checks file signatures and size before storing; voice notes are transcoded by ffmpeg to Ogg/Opus. Outbound messages are queued to the worker holding the number's Redis lease and transition through pending/sent/delivered/read/failed. Failed messages can be retried with their original client ID. Templates and interactive messages require Cloud API and, for templates, an approved Meta template. Each media record pins its storage driver, so changing the default to Hostinger does not require migrating older local or S3 files.

The system includes authorized call history and call-only alerts for incoming and missed calls. Authorized users see live alerts in the app; they can enable browser Web Push from the header to receive them after closing the page. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` (a `mailto:` contact address) in `.env` using one stable VAPID key pair; browser push requires HTTPS or localhost. Assignment controls remain in the API for permission-scoped conversation access. Message notifications, the generic notification center, and conversation mute controls remain removed as recorded in `docs/DECISIONS.md`.

Authorized call records also appear in the inbox list and inside each conversation in time order. A call from a contact without messages creates a conversation. Use **تفعيل نغمة المكالمات** in the header once per page visit to allow audible incoming-call ringing; browsers require a click before audio playback. Missed-call updates or a short timeout stop the ringtone. Call history and ringtone remain scoped to users with `calls:read` and access to the WhatsApp number.

Contact names come from Baileys history and live contact events when WhatsApp supplies them. A contact without a name or phone number is shown with a short LID label. Existing LID contacts receive their names when WhatsApp sends contact metadata again; message imports preserve known names.

Opening a chat on the linked phone clears its CRM unread badge when WhatsApp sends either a chat read update or a read-status transition for the latest inbound message. Older read receipts leave newer unread messages intact.

Contact profile pictures load when an authorized user opens the inbox. The connected Baileys worker fetches them from WhatsApp, stores small private copies with the configured storage provider, and refreshes stale copies on demand. Photos hidden by the contact's WhatsApp privacy settings or unavailable to Baileys show a letter avatar. Cloud API conversations currently show the letter avatar because that provider does not supply contact profile pictures.

## Verification

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

The worker is a Nest application context with no HTTP listener. TOTP enrollment is optional in the Phase 1 checklist and deferred as recorded in `docs/DECISIONS.md`.

To exercise the Redis lease integration test against an already running Redis instance, set `REDIS_TEST_URL` to its URL before `pnpm test`. The test uses unique temporary keys and cleans them up. CI provides Redis automatically.

## Cloud API

Add a Cloud API number in **أرقام واتساب** with a phone number ID, WABA ID, and long-lived system-user access token. Hala encrypts the token with `ENCRYPTION_KEY_BASE64`. Set `CLOUD_GRAPH_VERSION`, `CLOUD_APP_SECRET`, and `CLOUD_WEBHOOK_VERIFY_TOKEN`; register `https://YOUR_HOST/api/v1/webhooks/whatsapp/cloud` with Meta and subscribe to messages and statuses. Connecting the number verifies Graph access. Approved templates and interactive messages are available in the composer only on Cloud API accounts. Other message types follow the provider capability matrix. Check your Meta app's supported Graph version before deployment.

## Production and additional tests

The [deployment guide](docs/DEPLOYMENT.md) covers Compose startup, seeding, worker scaling, shared storage, Cloud webhooks, and backup. Redis-backed HTTP and send rate limits apply across API replicas in production. `@nestjs/observe` reports active worker sessions, queue age, and errors when configured; Pino redacts credentials. `/api/v1/health` checks MongoDB and Redis.

CI runs MongoDB/Redis Testcontainers integration and a Playwright browser flow against a seeded FakeProvider Compose stack. The normal Compose stack uses real providers; FakeProvider requires `NODE_ENV=test` and `WA_PROVIDER_MODE=fake`. A 200-session FakeProvider test verifies distribution across four workers. `pnpm test:e2e` runs the browser flow against a prepared test stack. Data export is not exposed by the current API; any future export endpoint must add an audit entry. Real WhatsApp/Meta delivery remains a deployment check.
