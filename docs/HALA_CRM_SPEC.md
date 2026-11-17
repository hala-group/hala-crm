# Hala CRM — Architecture & Implementation Spec (v2)

> المرجع الوحيد للتنفيذ (Single Source of Truth). أي قرار يخالف هذا الملف يجب توثيقه في `docs/DECISIONS.md` قبل تنفيذه.

**Hala CRM** = منصة تربط عددًا غير محدود من أرقام واتساب، وتخزّن كل الرسائل، وتتيح إرسال **كل أنواع الرسائل**، وترسل إشعارات فورية للرسائل والمكالمات، مع **مستخدمين متعددين + أدوار وصلاحيات + صلاحيات على مستوى كل رقم**، ومبنية بحيث تتحول لاحقًا إلى CRM متكامل.

---

## 0. الـ Stack (أحدث ما هو مستقر)

> **تحقق قبل التثبيت:** بحسب آخر فحص (أكتوبر 2026): Angular **22.x** (صدر 3 يونيو 2026)، و NestJS **12.x**. المطلوب من Codex تشغيل `npm view <pkg> version` لكل حزمة وتثبيت **أحدث إصدار مستقر متوافق**، وتوثيق الإصدارات الفعلية في `docs/DECISIONS.md`. لا تُخفَّض الإصدارات لتسهيل التنفيذ.

| الطبقة | التقنية |
|---|---|
| Runtime | Node.js LTS الحالي، pnpm workspaces |
| Frontend | **Angular 22** (Standalone فقط، **Zoneless**، Signals، **Signal Forms**، `resource`/`httpResource`)، **@ngrx/signals** (SignalStore)، Angular Material + CDK (v22)، `@angular/service-worker` (SwPush)، Vitest (اختبار) |
| Backend | **NestJS 12** (ESM-first)، **Standard Schema validation** (Zod) داخل `@Body/@Query/@Param`، `@nestjs/observe` للـ observability، `@nestjs/event-emitter`، `@nestjs/schedule`، `@nestjs/throttler`، `@nestjs/swagger` |
| DB | MongoDB (أحدث مستقر) + Mongoose |
| Queue/Cache | Redis + **BullMQ** (الإصدار المدعوم من Nest 12) |
| Realtime | Socket.IO + `@socket.io/redis-adapter` |
| الصلاحيات | **CASL** (`@casl/ability` + `@casl/mongoose`) — نفس تعريف الـ ability مشترك بين front/back |
| واتساب | `@whiskeysockets/baileys` (غير رسمي) خلف Provider interface + Cloud API رسمي لاحقًا |
| وسائط | `sharp` (صور/thumbnails)، `ffmpeg` (تحويل الصوت إلى ogg/opus للـ voice notes) |
| Push | `web-push` (VAPID) |
| أدوات | TypeScript strict، ESLint/oxlint، Prettier، Husky، Conventional Commits |

### ممارسات "الحديث" الإلزامية

**Angular**
- `provideZonelessChangeDetection()` (لا Zone.js) + `ChangeDetectionStrategy.OnPush`.
- Control flow الجديد فقط: `@if / @for (track) / @switch / @defer / @let` — ممنوع `*ngIf/*ngFor`.
- `input()` / `input.required()` / `output()` / `model()` / `viewChild()` / `contentChild()` — ممنوع `@Input/@Output` decorators.
- `inject()` بدل الـ constructor injection، و functional guards/interceptors/resolvers.
- **SignalStore** (`@ngrx/signals`): `signalStore`, `withState`, `withEntities`, `withComputed`, `withMethods`, `withHooks`, `rxMethod`, `signalMethod`، و `withProps/withLinkedState` عند الحاجة.
- `computed`, `effect` (بحذر)، `linkedSignal`, `resource()` / `httpResource()` للجلب البسيط.
- **Signal Forms** لكل النماذج (composer، إدارة المستخدمين، الأدوار…).
- `withComponentInputBinding()` للـ router، lazy `loadComponent`/`loadChildren`، و `@defer` للمكونات الثقيلة (معاينة الوسائط، emoji picker).
- `NgOptimizedImage`، و `cdk-virtual-scroll` لقوائم المحادثات والرسائل.
- Vitest للاختبار (الافتراضي الحديث) + Testing Library اختياريًا.

**NestJS**
- ESM-first، و Standard Schema (Zod) للتحقق والـ serialization بدل `class-validator`:
  ```ts
  create(@Body({ schema: createUserSchema }) body: CreateUserDto) { … }
  ```
  (تأكد من الصيغة الدقيقة من وثائق Nest 12.) والـ schemas تعيش في `packages/shared` وتُستخدم في الواجهة أيضًا.
- Config مُتحقَّق منه بـ Zod عند الإقلاع (fail-fast).
- Observability عبر `@nestjs/observe` + pino (structured logs) + health checks (Terminus).
- Graceful shutdown (إغلاق جلسات واتساب بشكل نظيف) + `enableShutdownHooks()`.
- أدوات الـ toolchain الافتراضية في Nest 12 (Vitest/oxlint/…) إن وُجدت — اتبعها.

---

## 1. النطاق

### داخل النطاق (Phase 1 → 6)
1. **عدد غير محدود** من أرقام واتساب لكل tenant (بدون حد في الكود؛ التوسع أفقيًا بالموارد).
2. استقبال وتخزين الرسائل بكل أنواعها.
3. **إرسال كل أنواع الرسائل** (انظر القسم 6).
4. حالات الرسائل (sent/delivered/read/failed)، الرد (reply)، التفاعلات (reactions)، التعديل والحذف للجميع، التحويل (forward).
5. إشعارات فورية: رسالة جديدة + مكالمة واردة/فائتة (In-app + Web Push) **موجّهة فقط لمن لديهم صلاحية على الرقم**.
6. **مستخدمون متعددون + أدوار + صلاحيات دقيقة (RBAC)**.
7. **صلاحيات على مستوى الرقم:** تعيين رقم لمجموعة محددة من المستخدمين بمستويات (view / reply / manage).
8. Inbox كامل + بحث + إسناد محادثات (assignment).
9. Audit log لكل العمليات الحساسة.

### خارج النطاق (لاحقًا)
Pipeline/Deals، Tasks، Chatbots/Automation، Campaigns، Reports، قنوات أخرى.

### ملاحظة حول المكالمات
واتساب لا يتيح الرد على المكالمات برمجيًا. النظام **يرصد ويُشعر ويسجّل** (وارد/فائت/مرفوض). راجع وثائق WhatsApp Calling API الحالية إن أردت دعمًا رسميًا لاحقًا.

---

## 2. القرارات المعمارية

| # | القرار | السبب |
|---|--------|-------|
| 1 | **Modular Monolith** + **عمليتان:** `api` (HTTP + WS) و `worker` (جلسات واتساب + queues) من نفس الكود | عدد غير محدود من الأرقام يتطلب فصل الجلسات الثقيلة عن الـ API وتوسعتها أفقيًا |
| 2 | **Provider Abstraction** (`WhatsAppProvider` + `capabilities`) | تبديل Baileys ↔ Cloud API |
| 3 | **Multi-tenant من اليوم الأول** (`tenantId` في كل document) | CRM متعدد الشركات لاحقًا |
| 4 | **Contact كيان مركزي** | يتحول إلى Lead/Customer |
| 5 | **Authorization مركزي بـ CASL** (Role permissions ∩ Number access) يُفرض على مستوى الـ query وليس الـ controller فقط | منع تسرّب بيانات الأرقام |
| 6 | **Session Leases في Redis** (كل حساب له worker مالك واحد) | منع جلستين لنفس الرقم، وتوزيع الحمل |
| 7 | **Event-driven داخليًا** (EventEmitter + BullMQ + Redis pub/sub) | توسعة CRM لاحقًا |
| 8 | **Idempotency** للرسائل (unique `waMessageId` + `clientMessageId`) | |
| 9 | الوسائط عبر **Storage Abstraction** (local → S3/MinIO) | |
| 10 | Shared package: **Zod schemas + types + permissions + ability** | عقد واحد بين الواجهة والـ API |

### المزوّد (Provider)
| | Baileys | WhatsApp Cloud API |
|---|---|---|
| الربط | QR | Number ID + Token |
| المخاطر | غير رسمي — خطر حظر | رسمي ومستقر |
| الاستخدام | Phase 1 | إنتاج تجاري / Templates / Interactive |

> تحقق من إصدار Baileys الحالي وتغيراته (ESM، وأنظمة المعرّفات مثل LID) قبل التنفيذ، وطبّع الـ contact IDs بحيث يعمل النظام مع `phoneE164` و `waId` معًا.

---

## 3. هيكل المشروع

```
hala-crm/
├─ AGENTS.md
├─ docs/{HALA_CRM_SPEC.md, DECISIONS.md}
├─ docker-compose.yml                 # mongo, redis, minio
├─ pnpm-workspace.yaml
├─ packages/
│  └─ shared/
│     └─ src/
│        ├─ schemas/                  # Zod: auth, users, roles, accounts, messages(out/in), contacts…
│        ├─ permissions.ts            # catalog + default roles
│        ├─ ability.ts                # defineAbilityFor(user, memberships) — CASL
│        ├─ events.ts                 # socket + internal event contracts
│        └─ enums.ts
├─ apps/
│  ├─ api/                            # NestJS (HTTP + Socket.IO)
│  │  └─ src/
│  │     ├─ main.ts, app.module.ts
│  │     ├─ config/
│  │     ├─ common/                   # tenant plugin, policies guard, filters, interceptors, audit
│  │     └─ modules/
│  │        ├─ auth/  users/  roles/  tenants/
│  │        ├─ whatsapp-accounts/     # CRUD + members (number access)
│  │        ├─ access/                # AccountAccessService + CASL factory
│  │        ├─ contacts/ conversations/ messages/ media/ calls/
│  │        ├─ notifications/  realtime/  push/
│  │        ├─ audit/  health/
│  ├─ worker/                         # NestJS standalone (no HTTP)
│  │  └─ src/
│  │     ├─ session/                  # SessionManager + LeaseService
│  │     ├─ providers/{baileys, cloud-api}/
│  │     └─ processors/               # BullMQ: inbound, outbound, media, push
│  └─ web/                            # Angular 22 (zoneless)
│     └─ src/app/
│        ├─ core/                     # auth, interceptors, api, socket, push, permissions
│        ├─ shared/                   # ui, pipes, directives (hasPermission)
│        ├─ features/
│        │  ├─ auth/ accounts/ inbox/ contacts/ calls/
│        │  ├─ notifications/ users/ roles/ settings/ audit/
│        └─ layout/
```

الـ modules المشتركة بين `api` و `worker` (schemas, repositories) تُستورد من `packages/` أو libs داخلية — لا نسخ.

**قاعدة التبعيات:** الـ provider ينشر أحداثًا موحّدة فقط؛ باقي الـ modules تستهلكها. لا يستورد أي module شيئًا من Baileys مباشرة.

---

## 4. نموذج البيانات (MongoDB)

> كل collection (عدا `tenants`): `tenantId` مفهرس + `createdAt/updatedAt`.

### 4.1 `users`
```ts
{ tenantId, email (unique per tenant), passwordHash, name, avatarUrl?,
  roleId, status: 'invited'|'active'|'suspended', lastLoginAt?,
  twoFactor?: { enabled, secretEnc }, pushSubscriptions: [...], preferences: { locale, theme, sounds } }
```
### 4.2 `roles`
```ts
{ tenantId, name, key?, isSystem: boolean, permissions: string[] /* من الكتالوج */, description? }
```
أدوار النظام الافتراضية تُزرع (seed) لكل tenant: **owner, admin, supervisor, agent, viewer**. ويمكن إنشاء أدوار مخصّصة.

### 4.3 `whatsapp_accounts` (بدون أي حد للعدد)
```ts
{ tenantId, label, color?, phoneNumber?, provider: 'baileys'|'cloud_api',
  status: 'created'|'qr_pending'|'connecting'|'connected'|'disconnected'|'logged_out'|'error',
  desiredState: 'connected'|'disconnected',     // ما يريده المستخدم
  assignedWorkerId?, leaseUpdatedAt?,            // للمراقبة فقط (المصدر الفعلي Redis)
  lastConnectedAt?, lastError?, providerConfig?: { /* cloud: phoneNumberId, wabaId, tokenEnc */ },
  settings: { autoReadReceipts, sendPacing: { minDelayMs, maxDelayMs } } }
```
### 4.3.1 `whatsapp_account_members`  ← **صلاحية الأرقام**
```ts
{ tenantId, accountId, userId,
  level: 'view' | 'reply' | 'manage',   // view=قراءة، reply=قراءة+إرسال+إسناد، manage=+ربط/فصل/إعدادات/أعضاء الرقم
  grantedBy, grantedAt }
```
Index: unique `(accountId, userId)`، و `(tenantId, userId)`.

### 4.4 `wa_auth_states` (Baileys)
`{ accountId, key, valueEnc }` — unique `(accountId, key)`، تشفير AES-256-GCM.

### 4.5 `contacts`
```ts
{ tenantId, waId, lid?, phoneE164?, displayName?, pushName?, avatarUrl?, isGroup,
  // امتدادات CRM (موجودة وفارغة):
  tags: string[], customFields: Record<string, unknown>, ownerUserId?, lifecycleStage? }
```
> جهة الاتصال **على مستوى tenant** (تُشارك بين الأرقام)، أما **المحادثة** فهي على مستوى (رقم × جهة اتصال). ظهور جهة الاتصال للمستخدم مقيّد بالأرقام التي يصل إليها (عبر المحادثات).

### 4.6 `conversations`
```ts
{ tenantId, accountId, contactId, status: 'open'|'archived',
  assignedUserId?, lastMessageAt, lastMessagePreview, lastMessageType, lastMessageDirection,
  unreadCount, isMuted?: boolean }
```
Index: unique `(tenantId, accountId, contactId)`، `(tenantId, accountId, lastMessageAt:-1)`، `(assignedUserId, lastMessageAt:-1)`.

### 4.7 `messages`
```ts
{ tenantId, accountId, conversationId, contactId,
  waMessageId, clientMessageId?, direction: 'in'|'out',
  type: 'text'|'image'|'video'|'audio'|'voice'|'document'|'sticker'|'location'|'contacts'|'reaction'|'poll'|'poll_vote'|'template'|'interactive'|'system'|'unknown',
  text?, caption?, mediaId?, location?: {lat,lng,name?,address?}, contacts?: [{name, phones[], vcard}],
  poll?: { question, options: [{id,text}], selectableCount }, reaction?: { targetWaMessageId, emoji },
  quotedWaMessageId?, mentions?: string[], forwarded?: boolean,
  editedAt?, revokedAt?, 
  status: 'pending'|'sent'|'delivered'|'read'|'failed', failureReason?, statusHistory: [{status, at}],
  sentByUserId?, timestamp, raw? }
```
Index: **unique** `(tenantId, accountId, waMessageId)`، unique sparse `(tenantId, accountId, clientMessageId)`، `(conversationId, timestamp:-1)`، text index على `text`.

### 4.8 `media`
`{ tenantId, accountId, messageId?, mimeType, size, fileName?, storageKey, storageDriver, sha256, width?, height?, durationSec?, thumbnailKey?, status: 'uploading'|'pending'|'ready'|'failed' }`

### 4.9 `calls`
`{ tenantId, accountId, contactId, waCallId, direction, isVideo, status: 'ringing'|'missed'|'rejected'|'accepted'|'ended', startedAt, endedAt? }`

### 4.10 `notifications`
`{ tenantId, userId, accountId?, type: 'message.new'|'call.incoming'|'call.missed'|'account.disconnected'|'conversation.assigned', title, body, data, readAt? }` — **يُنشأ سجل لكل مستخدم مستحق** (fan-out بعد فحص الصلاحية).

### 4.11 `audit_logs`
`{ tenantId, actorUserId, action, resourceType, resourceId, accountId?, meta, ip, userAgent, at }` — إلزامي لـ: تسجيل الدخول، إدارة المستخدمين/الأدوار، ربط/فصل الأرقام، منح/سحب صلاحية رقم، إرسال/حذف رسائل، تصدير بيانات.

---

## 5. الصلاحيات (RBAC + Number Access)

### 5.1 كتالوج الصلاحيات (`packages/shared/permissions.ts`)
صيغة: `resource:action`

| المجال | الصلاحيات |
|---|---|
| users | `users:read` `users:create` `users:update` `users:delete` |
| roles | `roles:read` `roles:manage` |
| accounts | `accounts:read` `accounts:create` `accounts:connect` `accounts:update` `accounts:delete` `accounts:members` `accounts:access_all` |
| conversations | `conversations:read` `conversations:read_all` `conversations:assign` `conversations:archive` |
| messages | `messages:send` `messages:send_media` `messages:edit` `messages:delete` |
| contacts | `contacts:read` `contacts:update` `contacts:delete` `contacts:export` |
| calls | `calls:read` |
| audit | `audit:read` |
| settings | `settings:manage` |

- `conversations:read` = يرى المحادثات **المسندة له** أو غير المسندة داخل أرقامه. `conversations:read_all` = يرى كل محادثات أرقامه (بما فيها المسندة لغيره).
- `accounts:access_all` = يصل إلى **كل** الأرقام (للـ owner/admin) دون عضوية.

### 5.2 الأدوار الافتراضية
| الدور | الصلاحيات |
|---|---|
| owner | كل شيء (+ `accounts:access_all`) |
| admin | كل شيء عدا حذف الـ tenant، + `accounts:access_all` |
| supervisor | `conversations:read_all/assign/archive`, `messages:*`, `contacts:*`, `calls:read`, `accounts:read`, `users:read` — **على أرقامه فقط** |
| agent | `conversations:read/archive`, `messages:send/send_media`, `contacts:read/update`, `calls:read` — على أرقامه فقط |
| viewer | `conversations:read_all`, `contacts:read`, `calls:read` — قراءة فقط |

### 5.3 قاعدة التقييم (مهمة جدًا)
العملية على مورد داخل رقم `A` مسموحة **فقط إذا**:
1. المستخدم يملك صلاحية الدور المطلوبة (`resource:action`)، **و**
2. (يملك `accounts:access_all` **أو** له عضوية على `A`) **و** مستوى العضوية كافٍ:

| العملية | المستوى الأدنى للعضوية |
|---|---|
| قراءة محادثات/رسائل/مكالمات/جهات اتصال الرقم | `view` |
| إرسال، تعديل، حذف رسائل، إسناد، أرشفة | `reply` |
| ربط/فصل الرقم، تعديل إعداداته، إدارة أعضاء الرقم | `manage` |

مثال: مستخدم دوره `agent` وعضويته على الرقم X بمستوى `view` فقط ⇒ يرى X لكن لا يرسل منه.

### 5.4 التنفيذ
- `packages/shared/ability.ts`: `defineAbilityFor(user, role, memberships)` يبني CASL ability بشروط مثل `{ accountId: { $in: [...] } }`. **نفس الملف** يستخدمه الـ API (للفرض) والواجهة (لإخفاء الأزرار).
- Backend:
  - `PoliciesGuard` + decorator `@CheckPolicy(Action, Subject)` على الـ controllers.
  - **فرض على مستوى الاستعلام:** `Model.accessibleBy(ability)` (من `@casl/mongoose`) في كل list/search، بحيث لا تُجلب أبدًا بيانات رقم غير مصرّح به (الـ guard وحده لا يكفي).
  - `AccountAccessService.resolve(userId)` يرجع `{ all: boolean, accounts: Map<accountId, level> }` مع cache في Redis (TTL قصير) ويُبطَل عند حدث `access.changed`.
  - عند `access.changed`: يُجبر الـ Gateway المستخدم على مغادرة/دخول rooms الأرقام فورًا ويُرسل `access:updated` للواجهة.
- Socket.IO: rooms `account:{id}` (يدخلها المستخدم حسب عضويته) و `user:{id}`؛ أحداث الرقم تُبث إلى `account:{id}` فقط.
- الإشعارات: fan-out فقط إلى المستخدمين المستحقين: (أ) المحادثة مسندة ⇒ المسند إليه + من لديهم `read_all`؛ (ب) غير مسندة ⇒ كل من لديه `reply`+ على الرقم. يحترم mute/تفضيلات المستخدم.
- حماية من الإقصاء الذاتي: لا يمكن حذف/تخفيض آخر `owner`.

---

## 6. إرسال الرسائل (كل الأنواع)

### 6.1 العقد (Zod discriminated union — في `packages/shared`)
```ts
const base = z.object({
  conversationId: objectId.optional(),
  to: phoneOrJid.optional(),                 // أحدهما إلزامي (refine)
  accountId: objectId,                        // الرقم المُرسل منه (إلزامي — يُفحص مستوى reply)
  clientMessageId: z.string().uuid(),         // idempotency
  replyToMessageId: objectId.optional(),
  mentions: z.array(z.string()).optional(),
});

export const outgoingMessageSchema = z.discriminatedUnion('type', [
  base.extend({ type: z.literal('text'),     text: z.string().max(4096), linkPreview: z.boolean().default(true) }),
  base.extend({ type: z.literal('image'),    mediaId: objectId, caption: z.string().max(1024).optional(), viewOnce: z.boolean().optional() }),
  base.extend({ type: z.literal('video'),    mediaId: objectId, caption: z.string().optional(), gif: z.boolean().optional(), viewOnce: z.boolean().optional() }),
  base.extend({ type: z.literal('audio'),    mediaId: objectId }),
  base.extend({ type: z.literal('voice'),    mediaId: objectId }),               // voice note (ptt)
  base.extend({ type: z.literal('document'), mediaId: objectId, fileName: z.string().optional(), caption: z.string().optional() }),
  base.extend({ type: z.literal('sticker'),  mediaId: objectId }),
  base.extend({ type: z.literal('location'), lat: z.number(), lng: z.number(), name: z.string().optional(), address: z.string().optional() }),
  base.extend({ type: z.literal('contacts'), contacts: z.array(contactCardSchema).min(1) }),
  base.extend({ type: z.literal('reaction'), targetMessageId: objectId, emoji: z.string().max(8).or(z.literal('')) }), // '' = إزالة
  base.extend({ type: z.literal('poll'),     question: z.string(), options: z.array(z.string()).min(2).max(12), selectableCount: z.number().int().min(0).default(1) }),
  base.extend({ type: z.literal('template'), name: z.string(), language: z.string(), components: z.any() }),          // Cloud API فقط
  base.extend({ type: z.literal('interactive'), kind: z.enum(['buttons','list']), body: z.string(), /* … */ }),        // Cloud API فقط
]);
```
### 6.2 عمليات إضافية
| العملية | Endpoint | ملاحظات |
|---|---|---|
| تعديل رسالة | `PATCH /messages/:id` | نص فقط، ضمن المهلة التي يسمح بها واتساب |
| حذف للجميع | `DELETE /messages/:id?scope=everyone` | `messages:delete` + `reply` |
| حذف محلي | `DELETE /messages/:id?scope=me` | من قاعدة Hala فقط |
| تحويل | `POST /messages/:id/forward` | إلى محادثات متعددة (يُفحص `reply` على كل رقم) |
| "يكتب الآن" | Socket `typing:start/stop` | presence |
| تعليم كمقروء | `POST /conversations/:id/read` | |

### 6.3 مصفوفة دعم المزوّدين (`provider.capabilities`)
| النوع | Baileys | Cloud API |
|---|---|---|
| text / image / video / audio / voice / document / sticker | ✅ | ✅ |
| location / contacts / reaction / reply / mentions | ✅ | ✅ |
| poll | ✅ | محدود/غير مدعوم (تحقق) |
| edit / revoke / forward | ✅ | قيود (تحقق) |
| template | ❌ | ✅ |
| interactive (buttons/list) | غير موثوق (تحقق) ❌ افتراضيًا | ✅ |

كل provider يعرّف `capabilities: Set<MessageType | Action>`؛ الـ API يرفض غير المدعوم بـ `422 UNSUPPORTED_BY_PROVIDER`، والواجهة تُخفي الخيار حسب الرقم المحدد.

### 6.4 معالجة الوسائط للإرسال
1. `POST /media/upload` (multipart/chunked) → فحص النوع/الحجم (magic bytes، لا الاعتماد على الامتداد) → تخزين → `mediaId`.
2. صور: `sharp` (تصحيح الاتجاه، thumbnail). صوت للـ voice: `ffmpeg` → `ogg/opus`. فيديو: التحقق من الترميز/الحجم وتوليد thumbnail.
3. حدود الأحجام قابلة للتهيئة (config) ومتوافقة مع حدود واتساب.
4. الرسالة تُنشأ `pending` فورًا ويراها المرسل (Optimistic UI) ثم تتحول `sent/failed`.

### 6.5 تدفق الإرسال
```
POST /messages (Zod validate)
 → CASL: can('send', subject('Message', {accountId}))  + مستوى reply
 → idempotency (clientMessageId)  → insert Message(pending) → audit
 → enqueue إلى worker المالك للرقم (انظر 7.2)
 → worker: pacing (jitter) → provider.send(...) → update (sent + waMessageId)
 → status updates (delivered/read) تصل عبر wa.message.status
 → Socket 'message:status' إلى account:{id}
 فشل ⇒ failed + failureReason + retry يدوي من الواجهة
```
**Pacing:** تأخير عشوائي صغير بين الرسائل لكل رقم (قابل للتهيئة) لتقليل خطر الحظر على Baileys. لا Bulk/Broadcast على Baileys.

---

## 7. الأرقام غير المحدودة (Scalability)

### 7.1 المبادئ
- لا يوجد `limit` على عدد الحسابات في أي مكان. القيد الوحيد هو موارد الخادم → **التوسع بإضافة workers**.
- كل رقم = جلسة Baileys واحدة تعيش في **worker** واحد فقط في أي لحظة.

### 7.2 Session Leases (Redis)
- المفتاح: `lease:account:{id}` = `{workerId, fencingToken}` بـ `SET NX PX 30000`، يُجدَّد كل 10 ثوانٍ.
- كل worker يمسح دوريًا الحسابات `desiredState=connected` التي بلا lease، ويحاول الاستحواذ عليها حتى `MAX_SESSIONS_PER_WORKER` (env).
- فقدان lease ⇒ إغلاق الجلسة فورًا (منع الجلسة المزدوجة)؛ استخدام fencing token في كتابة `wa_auth_states`.
- **توجيه الأوامر:** الـ API يقرأ مالك الـ lease ويرسل الأمر (`connect/disconnect/send/markRead/downloadMedia`) إلى قناة/Queue خاصة بذلك الـ worker (`wa-commands:{workerId}`). إن لم يوجد مالك ⇒ الأمر ينتظر ثم يفشل بـ `ACCOUNT_NOT_RUNNING`.
- worker جديد/سقط ⇒ تُعاد قيادة الأرقام تلقائيًا (failover) بدون QR جديد لأن auth state في MongoDB.
- Backoff أسّي لإعادة الاتصال، و Jitter عند الإقلاع الجماعي لتجنب عاصفة اتصالات.

### 7.3 الأحداث بين العمليات
- worker ينشر: `wa.qr`, `wa.connection`, `wa.message.in/out/status`, `wa.call` → BullMQ/Redis → processors (تخزين) → أحداث نطاق → Socket.IO (عبر Redis adapter) إلى `api`.
- مراقبة: metrics لكل worker (عدد الجلسات، متوسط عمر الاتصال، أخطاء)، وتنبيه عند `account.disconnected`.

---

## 8. التدفقات الأساسية

**ربط رقم:** `POST /whatsapp/accounts` (`accounts:create`) → `POST .../connect` (`accounts:connect` + `manage`) → `desiredState=connected` → worker يستحوذ على lease → QR عبر Socket إلى `account:{id}` (لمن لديه `manage`) → `connected`. المنشئ يحصل تلقائيًا على عضوية `manage`.

**رسالة واردة:**
```
Baileys messages.upsert → normalize → queue inbound
  1. upsert Contact  2. upsert Conversation (unreadCount++)
  3. insert Message (unique waMessageId → تجاهل التكرار)
  4. media-download في الخلفية  5. emit 'message.created'
  → NotificationsService: يحسب المستحقين (5.4) → Notification لكل مستخدم + Socket + Web Push
```
**مكالمة:** حدث `wa.call` → upsert Call → `call.incoming` عند ringing، `call.missed` عند الفوات — بنفس منطق التوجيه حسب الرقم.

**Web Push:** `web-push` + VAPID، يُرسل للمستخدم المستحق عند غياب اتصال socket نشط (أو مع `tag` للدمج)، وتُحذف الاشتراكات المنتهية (404/410). النقر يفتح `/inbox/:conversationId`.

---

## 9. الـ API (`/api/v1`، Swagger على `/docs`)

| المجال | Endpoints |
|---|---|
| Auth | `POST /auth/login` `/auth/refresh` `/auth/logout` `/auth/accept-invite` `/auth/2fa/*` — `GET /me` (يرجع user + role + permissions + account memberships) |
| Users | `GET/POST /users` `PATCH/DELETE /users/:id` `POST /users/:id/suspend` `POST /users/invite` |
| Roles | `GET/POST /roles` `PATCH/DELETE /roles/:id` `GET /permissions` |
| Accounts | `GET/POST /whatsapp/accounts` `PATCH/DELETE /:id` `POST /:id/connect` `/disconnect` `/logout` |
| Account members | `GET /whatsapp/accounts/:id/members` `PUT /whatsapp/accounts/:id/members/:userId` `{level}` `DELETE .../:userId` — وعكسيًا `GET /users/:id/accounts` |
| Conversations | `GET /conversations?cursor&limit&q&accountId&assigned&status` `POST /:id/assign` `/archive` `/read` |
| Messages | `GET /conversations/:id/messages?cursor` — `POST /messages` — `PATCH/DELETE /messages/:id` — `POST /messages/:id/forward` |
| Media | `POST /media/upload` `GET /media/:id` (محمي بـ CASL على رقم الرسالة) |
| Contacts / Calls | `GET/PATCH /contacts…` `GET /calls` |
| Notifications / Push | `GET /notifications` `POST /:id/read` `/read-all` — `POST /push/subscribe` `/unsubscribe` |
| Audit | `GET /audit-logs` |
| Health | `GET /health` |

**Socket events (server→client):** `account:qr` `account:status` `message:new` `message:status` `message:updated` `conversation:updated` `call:incoming` `call:missed` `notification:new` `access:updated`
**(client→server):** `typing:start/stop` `conversation:open`

JWT في `handshake.auth.token`؛ الانضمام للـ rooms يتم من الـ server حسب الصلاحيات (لا يطلب العميل الانضمام لأي room).

---

## 10. الواجهة (Angular 22 — زونلس + SignalStore)

### 10.1 الشاشات
1. **Login / Accept invite / 2FA**
2. **Accounts:** بطاقات الأرقام (لا حد) + حالة مباشرة + QR modal + تبويب **Members** (إضافة/سحب مستخدمين ومستوى الوصول).
3. **Inbox (3 أعمدة):** فلتر الرقم (متعدد) + محادثات (virtual scroll، بحث، unread، assigned-to-me) ← نافذة محادثة ← تفاصيل جهة الاتصال. **Composer** يدعم: نص، emoji، مرفقات (drag&drop/paste)، تسجيل صوت (voice note)، موقع، جهة اتصال، استطلاع، رد/اقتباس، منشن، سحب وإفلات، ومعاينة قبل الإرسال.
4. **Users** (دعوات، تعليق، تغيير الدور) · **Roles** (محرر صلاحيات بمصفوفة checkboxes) · **Audit log**.
5. **Calls** · **Notifications center** · **Settings** (تفضيلات الصوت/الإشعارات/الثيم/اللغة).
6. RTL كامل + `ar/en` (Angular i18n أو Transloco).

### 10.2 أنماط إلزامية
```ts
// stores/inbox.store.ts
export const InboxStore = signalStore(
  { providedIn: 'root' },
  withEntities<ConversationVm>(),
  withState<InboxState>({ filter: { accountIds: [], q: '', assignedToMe: false }, selectedId: null, loading: false }),
  withComputed(({ entities, filter, selectedId }) => ({
    selected: computed(() => entities().find(c => c.id === selectedId())),
    totalUnread: computed(() => entities().reduce((n, c) => n + c.unreadCount, 0)),
  })),
  withMethods((store, api = inject(ConversationsApi)) => ({
    load: rxMethod<InboxFilter>(pipe(
      tap(() => patchState(store, { loading: true })),
      switchMap(f => api.list(f)),
      tap(res => patchState(store, setAllEntities(res.items), { loading: false })),
    )),
    applyRealtime(update: ConversationVm) { patchState(store, setEntity(update)); },
  })),
  withHooks({ onInit(store) { /* اشتراك socket عبر signalMethod/effect */ } }),
);
```
- Stores المطلوبة: `AuthStore`, `PermissionsStore` (يبني ability من `/me` ويُحدَّث على `access:updated`)، `AccountsStore`, `InboxStore`, `MessagesStore` (per-conversation مع optimistic updates)، `ComposerStore`, `NotificationsStore`, `UsersStore`, `RolesStore`.
- **إخفاء/تعطيل حسب الصلاحية:** `can('send', account)` كـ computed؛ ودرِكتيف `hasPermission` / pipe `can`. *الإخفاء للتجربة فقط — الفرض الحقيقي في الـ API.*
- `httpResource` للقراءات البسيطة (تفاصيل مستخدم، قائمة أدوار)؛ و SignalStore للحالة المعقدة/الـ realtime.
- Signal Forms لكل النماذج، والـ Zod schemas المشتركة مصدر قواعد التحقق قدر الإمكان.
- Service Worker (`ngsw` + SwPush) للـ Push + `notificationclick` → فتح المحادثة.
- Interceptor: JWT + refresh queue، ومعالجة `401/403/422` موحدة.

---

## 11. الأمان
- Argon2id للكلمات، JWT access (15د) + refresh rotation + كشف إعادة الاستخدام، 2FA (TOTP) اختياري للمدراء.
- **Tenant isolation:** Mongoose plugin يضيف `tenantId` لكل query تلقائيًا + اختبارات تسرّب إلزامية.
- **Account isolation:** `accessibleBy(ability)` في كل استعلام + اختبارات: مستخدم بلا عضوية لا يرى/لا يصل (REST + Socket + Media + Search + Notifications + Push).
- تشفير الجلسات والـ tokens (AES-256-GCM)، مفاتيح من env/secret manager.
- Throttler (REST) + حدود Socket + حدود إرسال لكل رقم/مستخدم.
- فحص الملفات (magic bytes، حجم، منع الملفات التنفيذية)، وروابط وسائط موقّعة قصيرة العمر أو مُصادَقة.
- Helmet + CORS مقيّد + CSRF غير لازم للـ Bearer لكن cookies الـ refresh = `HttpOnly; SameSite`.
- Logs بدون محتوى الرسائل/الأرقام الكاملة. Audit للعمليات الحساسة.
- **امتثال واتساب:** تنبيه في الواجهة عند الإرسال لمن لم يبدأ المحادثة، ولا حملات جماعية على Baileys.

---

## 12. خطة التنفيذ (Phases)

> **Phase واحدة في كل مرة.** لا تبدأ التالية قبل تحقق DoD وموافقتي.

### Phase 0 — التأسيس
- [ ] pnpm workspace: `packages/shared`, `apps/{api,worker,web}` + tsconfig/ESLint/Prettier/Husky.
- [ ] `docker-compose.yml` (mongo, redis, minio).
- [ ] Nest 12: config (Zod)، pino، Swagger، health، observe، global filters، graceful shutdown.
- [ ] Angular 22: zoneless، theme RTL، layout، interceptors، i18n، PWA/SW إعداد أولي.
- [ ] CI (lint + typecheck + test + build) + `.env.example`.

**DoD:** `pnpm dev` يشغّل api+worker+web+DB، `/health` OK، CI أخضر، وتوثيق الإصدارات الفعلية في DECISIONS.

### Phase 1 — Auth + Tenancy + Users + RBAC
- [ ] Tenants/Users/Roles + seed (tenant + owner + أدوار النظام).
- [ ] Auth كامل (login/refresh/logout/invite/2FA اختياري).
- [ ] كتالوج الصلاحيات + `ability.ts` المشترك + `PoliciesGuard` + tenant plugin.
- [ ] Audit module.
- [ ] Angular: Login، Users، Roles (محرر صلاحيات)، `PermissionsStore` + `hasPermission`.

**DoD:** إنشاء أدوار مخصصة ومستخدمين ودعوتهم؛ اختبارات تثبت tenant isolation وفرض الصلاحيات.

### Phase 2 — الأرقام (غير محدودة) + صلاحيات الأرقام
- [ ] `WhatsAppProvider` + `capabilities` + `BaileysProvider` + auth state مشفّر في Mongo.
- [ ] Worker: `SessionManager` + `LeaseService` (Redis) + أوامر موجّهة + failover.
- [ ] Accounts CRUD + `whatsapp_account_members` + `AccountAccessService` + `access.changed`.
- [ ] Socket rooms حسب الصلاحية + `access:updated`.
- [ ] Angular: Accounts (بطاقات، QR modal، Members tab).

**DoD:** إضافة ≥ 20 رقمًا تجريبيًا (FakeProvider) بدون أي حد؛ تشغيل worker ثانٍ يوزّع الأرقام؛ إيقاف worker ينقل جلساته دون QR؛ مستخدم بلا عضوية لا يرى الرقم إطلاقًا.

### Phase 3 — تخزين الرسائل الواردة + Inbox
- [ ] Schemas/indexes (contacts/conversations/messages/media).
- [ ] Inbound pipeline + normalizer لكل الأنواع + idempotency + media download.
- [ ] Conversations/Messages API (cursor) مع `accessibleBy`.
- [ ] Angular Inbox (stores، virtual scroll، real-time، معاينة الوسائط).

**DoD:** كل أنواع الرسائل الواردة تُخزن وتُعرض؛ لا تكرار؛ المستخدم يرى محادثات أرقامه فقط (REST + Socket).

### Phase 4 — إرسال كل أنواع الرسائل
- [ ] Outgoing Zod union + Media upload/processing (sharp/ffmpeg).
- [ ] Send pipeline (pacing، idempotency، retry) + حالات ✓✓ + `wa.message.out` من الهاتف.
- [ ] Reply، reactions، edit، delete-for-everyone، forward، poll، location، contacts، voice، sticker.
- [ ] Capabilities enforcement (422) + إخفاء الخيارات في الواجهة.
- [ ] Angular Composer كامل (Signal Forms + SignalStore + optimistic UI).

**DoD:** إرسال كل نوع مدعوم يعمل ويظهر لدى المستلم؛ مستخدم `view` فقط لا يستطيع الإرسال (واجهة + API)؛ الفشل واضح مع إعادة محاولة.

### Phase 5 — الإشعارات والمكالمات
- [ ] Calls module + notifications fan-out حسب الصلاحية والإسناد + preferences/mute.
- [ ] Web Push (VAPID) + Service Worker + Bell + badge + صوت.
- [ ] إشعار انقطاع الرقم لمن لديه `manage`.
- [ ] Conversation assignment + إشعار الإسناد.

**DoD:** Push يصل مع التبويب مغلقًا فقط للمستحقين؛ سحب صلاحية رقم يوقف إشعاراته فورًا.

### Phase 6 — التصليب والنشر
- [ ] Rate limits، audit مكتمل، metrics (`@nestjs/observe`)، تنظيف logs.
- [ ] اختبارات: unit + integration (Mongo/Redis testcontainers) + e2e (Playwright) مع `FakeProvider`، واختبارات التسرّب بين tenants/أرقام.
- [ ] Dockerfiles + compose إنتاج (api, worker ×N, web, mongo, redis) + دليل نشر وتوسعة.
- [ ] `CloudApiProvider` (template/interactive) خلف نفس الـ interface.
- [ ] README كامل.

**DoD:** كل الاختبارات خضراء، `docker compose up` يعمل على جهاز نظيف، واختبار حمل يثبت عمل N جلسة موزعة على عدة workers.

---

## 13. مسار التوسعة إلى CRM (لا يُنفَّذ الآن)
| الميزة | كيف تُضاف |
|---|---|
| Leads/Deals/Pipeline | module جديد على `contactId` يستمع لـ `message.created` |
| Tags/Custom fields | موجودة في `contacts` |
| Teams/Assignment rules | فوق `assignedUserId` + RBAC الحالي |
| Chatbot/Automation | مشترك في أحداث الرسائل ويستدعي `MessagesService.send` |
| Campaigns | Cloud API templates + queue مستقل |
| قنوات أخرى | `ChannelProvider` عام بنفس نمط `WhatsAppProvider` |
| Reports | aggregations على messages/conversations |

---

## 14. متغيرات البيئة (`.env.example`)
```
NODE_ENV=development
API_PORT=3000
MONGO_URI=mongodb://localhost:27017/hala_crm
REDIS_URL=redis://localhost:6379
JWT_ACCESS_SECRET=change-me
JWT_REFRESH_SECRET=change-me
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
ENCRYPTION_KEY_BASE64=            # 32 bytes
STORAGE_DRIVER=local              # local | s3
STORAGE_LOCAL_PATH=./storage
S3_ENDPOINT= S3_BUCKET= S3_ACCESS_KEY= S3_SECRET_KEY=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@example.com
CORS_ORIGINS=http://localhost:4200
WORKER_ID=                        # يُولَّد تلقائيًا إن تُرك فارغًا
MAX_SESSIONS_PER_WORKER=200
LEASE_TTL_MS=30000
MEDIA_MAX_IMAGE_MB=5
MEDIA_MAX_VIDEO_MB=16
MEDIA_MAX_AUDIO_MB=16
MEDIA_MAX_DOC_MB=100
```

## 15. Definition of Done العامة
- Lint + typecheck + tests + build ناجحة.
- لا `any` بدون سبب موثّق، ولا ثغرات tenant/account isolation.
- Swagger محدّث و README يشرح التشغيل والتوسعة.
- التزام بالممارسات الحديثة في القسم 0 (لا `*ngIf`، لا `@Input`، لا Zone.js، لا constructor DI في Angular).
- كل Phase = PR/commit مستقل بوصف واضح.
