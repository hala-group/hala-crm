# AGENTS.md — Hala CRM

## Source of truth
- Read `docs/HALA_CRM_SPEC.md` fully before any task. If code and spec disagree, the spec wins; record any deviation in `docs/DECISIONS.md` BEFORE implementing it.

## Workflow
- Work on ONE phase at a time. Stop after the phase's Definition of Done and wait for confirmation.
- Before finishing any task run: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` and fix every failure.
- Each phase ends with a summary: what was built, how to verify, deviations, next phase.
- Conventional Commits. Never commit secrets; update `.env.example` for every new env var.

## Versions
- Use the latest STABLE compatible versions (as of Oct 2026: Angular 22.x, NestJS 12.x). Verify with `npm view <pkg> version`, do not rely on memory, never downgrade to simplify work. Record the final versions in `docs/DECISIONS.md`.
- If an API (Angular 22, NestJS 12, @ngrx/signals, Baileys, CASL, BullMQ) is unclear or may have changed, read the official docs / package types and state your assumption. Do not guess.

## Angular rules (apps/web)
- Standalone only, zoneless (`provideZonelessChangeDetection`), `OnPush`.
- New control flow only: `@if @for(track) @switch @defer @let`. NEVER `*ngIf/*ngFor/ngSwitch`.
- Signal APIs only: `input() input.required() output() model() viewChild() contentChild()`. NEVER `@Input/@Output/@ViewChild` decorators.
- `inject()` for DI; functional guards/interceptors/resolvers.
- State: `@ngrx/signals` SignalStore (`withState/withEntities/withComputed/withMethods/withHooks/rxMethod`). No NgRx classic store, no BehaviorSubject state.
- Forms: Signal Forms. Simple reads: `resource()/httpResource()`.
- Permission checks in UI use the shared CASL ability (`packages/shared`); hiding UI is UX only — the API is the real enforcement.
- Lazy routes, `@defer` for heavy parts, CDK virtual scroll for long lists, RTL + i18n ready, Vitest for tests.

## NestJS rules (apps/api, apps/worker)
- ESM-first. Validate with Standard Schema (Zod) from `packages/shared` in `@Body/@Query/@Param`. Config validated at boot.
- Modular monolith with two entrypoints: `api` (HTTP+WS) and `worker` (WhatsApp sessions + processors).
- NEVER import Baileys outside `worker/providers/baileys`. All WhatsApp access goes through the `WhatsAppProvider` interface and its `capabilities`.
- Every query is tenant-scoped via the tenant plugin AND account-scoped via CASL `accessibleBy(ability)`. A guard alone is NOT enough. Add isolation tests for REST, Socket, media, search, notifications, push.
- One WhatsApp session per account at any time (Redis lease + fencing token). No limit on the number of accounts anywhere in code.
- Messages: idempotent (`waMessageId`, `clientMessageId`), media via storage abstraction (never binary in Mongo), WhatsApp credentials encrypted (AES-256-GCM).
- Audit-log every sensitive action listed in the spec.

## Quality bar
- TypeScript strict, no unjustified `any`, no dead code, tests for every feature (unit + integration; e2e for critical flows with `FakeProvider`).
- Swagger for every endpoint; README kept up to date.
- Do not build CRM features (pipelines, deals, campaigns, automation) — only the extension points in the spec.
