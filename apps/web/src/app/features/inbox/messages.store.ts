import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { type MessageView } from '@hala/shared';

interface Page {
  items: MessageView[];
  nextCursor: string | null;
}
export const MessagesStore = signalStore(
  { providedIn: 'root' },
  withState<{
    items: MessageView[];
    conversationId: string | null;
    loadedConversationId: string | null;
    cursor: string | null;
    loading: boolean;
    error: string | null;
  }>({
    items: [],
    conversationId: null,
    loadedConversationId: null,
    cursor: null,
    loading: false,
    error: null,
  }),
  withMethods((store, http = inject(HttpClient)) => {
    let activeLoad: Promise<void> | null = null;
    return {
      async select(id: string): Promise<void> {
        if (store.conversationId() === id && store.loadedConversationId() === id) return;
        patchState(store, {
          conversationId: id,
          loadedConversationId: null,
          items: [],
          cursor: null,
          error: null,
        });
        while (store.conversationId() === id && store.loadedConversationId() !== id) {
          await this.load();
          if (store.error()) return;
        }
      },
      async load(): Promise<void> {
        const id = store.conversationId();
        if (!id) return;
        if (activeLoad) {
          await activeLoad;
          return;
        }
        patchState(store, { loading: true, error: null });
        const cursor = store.cursor();
        const request = (async () => {
          try {
            const page = await firstValueFrom(
              http.get<Page>(`/api/v1/conversations/${id}/messages`, {
                params: cursor ? { cursor } : {},
              }),
            );
            if (store.conversationId() === id)
              patchState(store, {
                items: [...store.items(), ...page.items].filter(
                  (item, index, list) =>
                    list.findIndex((candidate) => candidate._id === item._id) === index,
                ),
                loadedConversationId: id,
                cursor: page.nextCursor,
              });
          } catch {
            if (store.conversationId() === id)
              patchState(store, {
                error: 'تعذر تحميل الرسائل. تحقق من الاتصال ثم أعد المحاولة.',
              });
          } finally {
            patchState(store, { loading: false });
          }
        })();
        activeLoad = request;
        try {
          await request;
        } finally {
          if (activeLoad === request) activeLoad = null;
        }
      },
      add(message: MessageView): void {
        if (
          store.conversationId() !== message.conversationId ||
          store.items().some((item) => item._id === message._id)
        )
          return;
        patchState(store, { items: [message, ...store.items()] });
      },
      upsert(message: MessageView): void {
        if (store.conversationId() !== message.conversationId) return;
        const remaining = store
          .items()
          .filter(
            (item) =>
              item._id !== message._id &&
              (!message.clientMessageId || item.clientMessageId !== message.clientMessageId),
          );
        patchState(store, { items: [message, ...remaining] });
      },
      updateStatus(event: {
        messageId: string;
        status: MessageView['status'];
        waMessageId?: string;
        failureReason?: string;
      }): void {
        patchState(store, {
          items: store.items().map((item) =>
            item._id === event.messageId
              ? {
                  ...item,
                  status: event.status,
                  waMessageId: event.waMessageId ?? item.waMessageId,
                  failureReason: event.failureReason,
                }
              : item,
          ),
        });
      },
      mediaReady(messageId: string, mediaId: string): void {
        patchState(store, {
          items: store
            .items()
            .map((item) =>
              item._id === messageId ? { ...item, mediaId, mediaStatus: 'ready' as const } : item,
            ),
        });
      },
      remove(id: string): void {
        patchState(store, { items: store.items().filter((item) => item._id !== id) });
      },
      clear(): void {
        patchState(store, {
          items: [],
          conversationId: null,
          loadedConversationId: null,
          cursor: null,
          error: null,
        });
      },
    };
  }),
);
