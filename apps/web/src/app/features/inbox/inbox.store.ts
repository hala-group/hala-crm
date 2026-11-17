import { inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { type ConversationView, type MessageSearchResultView } from '@hala/shared';

interface Page {
  items: ConversationView[];
  nextCursor: string | null;
}

export type FilterTab = 'all' | 'unread' | 'assigned_me' | 'archived';

export const InboxStore = signalStore(
  { providedIn: 'root' },
  withState<{
    items: ConversationView[];
    cursor: string | null;
    selectedId: string | null;
    loading: boolean;
    error: string | null;
    accountId: string;
    q: string;
    filterTab: FilterTab;
    selectedTag: string | null;
    availableTags: string[];
    messageSearchResults: MessageSearchResultView[];
    searchingMessages: boolean;
    messageSearchQuery: string;
    highlightMessageId: string | null;
  }>({
    items: [],
    cursor: null,
    selectedId: null,
    loading: false,
    error: null,
    accountId: '',
    q: '',
    filterTab: 'all',
    selectedTag: null,
    availableTags: [],
    messageSearchResults: [],
    searchingMessages: false,
    messageSearchQuery: '',
    highlightMessageId: null,
  }),
  withMethods((store, http = inject(HttpClient)) => {
    let latestRequestId = 0;
    return {
      async load(reset = true): Promise<void> {
        const requestId = ++latestRequestId;
        const accountId = store.accountId();
        const query = store.q();
        const cursor = store.cursor();
        const filterTab = store.filterTab();
        const selectedTag = store.selectedTag();
        patchState(store, { loading: true, error: null });
        try {
          let params = new HttpParams().set('limit', '50');
          if (!reset && cursor) params = params.set('cursor', cursor);
          if (accountId) params = params.set('accountId', accountId);
          if (query) params = params.set('q', query);
          if (filterTab === 'unread') {
            params = params.set('status', 'open').set('unreadOnly', 'true');
          } else if (filterTab === 'assigned_me') {
            params = params.set('status', 'open').set('assigned', 'me');
          } else if (filterTab === 'archived') {
            params = params.set('status', 'archived');
          } else {
            params = params.set('status', 'open');
          }
          if (selectedTag) params = params.set('tag', selectedTag);

          const page = await firstValueFrom(http.get<Page>('/api/v1/conversations', { params }));
          if (requestId !== latestRequestId) return;
          const merged = reset ? page.items : [...store.items(), ...page.items];
          patchState(store, {
            items: merged.filter(
              (item, index) =>
                merged.findIndex((candidate) => candidate._id === item._id) === index,
            ),
            cursor: page.nextCursor,
          });
        } catch {
          if (requestId === latestRequestId)
            patchState(store, {
              error: 'تعذر تحميل المحادثات. تحقق من الاتصال ثم أعد المحاولة.',
            });
        } finally {
          if (requestId === latestRequestId) patchState(store, { loading: false });
        }
      },
      filter(accountId: string, q: string): void {
        latestRequestId++;
        patchState(store, {
          accountId,
          q,
          cursor: null,
          items: [],
          loading: true,
          error: null,
        });
      },
      setFilterTab(tab: FilterTab): void {
        latestRequestId++;
        patchState(store, {
          filterTab: tab,
          cursor: null,
          items: [],
          loading: true,
          error: null,
        });
      },
      setSelectedTag(tag: string | null): void {
        latestRequestId++;
        patchState(store, {
          selectedTag: tag,
          cursor: null,
          items: [],
          loading: true,
          error: null,
        });
      },
      async loadTags(): Promise<void> {
        try {
          const res = await firstValueFrom(http.get<{ tags: string[] }>('/api/v1/tags'));
          patchState(store, { availableTags: res.tags ?? [] });
        } catch {
          // Non-critical, ignore
        }
      },
      async updateTags(conversationId: string, tags: string[]): Promise<void> {
        const updated = await firstValueFrom(
          http.patch<ConversationView>(`/api/v1/conversations/${conversationId}/tags`, { tags }),
        );
        const currentItems = store.items();
        patchState(store, {
          items: currentItems.map((item) =>
            item._id === conversationId ? { ...item, tags: updated.tags ?? tags } : item,
          ),
          availableTags: [...new Set([...store.availableTags(), ...tags])],
        });
      },
      async archive(conversationId: string, archived: boolean): Promise<void> {
        const updated = await firstValueFrom(
          http.post<ConversationView>(`/api/v1/conversations/${conversationId}/archive`, { archived }),
        );
        const tab = store.filterTab();
        if (tab === 'archived' && !archived) {
          patchState(store, {
            items: store.items().filter((item) => item._id !== conversationId),
          });
        } else if (tab !== 'archived' && archived) {
          patchState(store, {
            items: store.items().filter((item) => item._id !== conversationId),
          });
        } else {
          patchState(store, {
            items: store.items().map((item) =>
              item._id === conversationId ? { ...item, status: updated.status } : item,
            ),
          });
        }
      },
      async searchMessages(q: string, accountId?: string, conversationId?: string): Promise<void> {
        const query = q.trim();
        if (!query) {
          patchState(store, {
            messageSearchResults: [],
            searchingMessages: false,
            messageSearchQuery: '',
          });
          return;
        }
        patchState(store, { searchingMessages: true, messageSearchQuery: query });
        try {
          let params = new HttpParams().set('q', query);
          if (accountId) params = params.set('accountId', accountId);
          if (conversationId) params = params.set('conversationId', conversationId);
          const res = await firstValueFrom(
            http.get<{ items: MessageSearchResultView[] }>('/api/v1/messages/search', { params }),
          );
          patchState(store, {
            messageSearchResults: res.items ?? [],
            searchingMessages: false,
          });
        } catch {
          patchState(store, {
            messageSearchResults: [],
            searchingMessages: false,
          });
        }
      },
      clearMessageSearch(): void {
        patchState(store, {
          messageSearchResults: [],
          searchingMessages: false,
          messageSearchQuery: '',
        });
      },
      setHighlightMessageId(id: string | null): void {
        patchState(store, { highlightMessageId: id });
      },
      select(id: string | null): void {
        patchState(store, { selectedId: id });
      },
      apply(conversation: ConversationView): void {
        const tab = store.filterTab();
        const tag = store.selectedTag();
        const matchesStatus =
          tab === 'archived' ? conversation.status === 'archived' : conversation.status === 'open';
        const matchesUnread = tab !== 'unread' || conversation.unreadCount > 0;
        const matchesTag = !tag || (conversation.tags ?? []).includes(tag);

        const remaining = store.items().filter((item) => item._id !== conversation._id);
        if (matchesStatus && matchesUnread && matchesTag) {
          patchState(store, {
            items: [conversation, ...remaining].sort((a, b) =>
              b.lastMessageAt.localeCompare(a.lastMessageAt),
            ),
          });
        } else {
          patchState(store, { items: remaining });
        }
      },
      updateLastMessageStatus(conversationId: string, status?: ConversationView['lastMessageStatus']): void {
        patchState(store, {
          items: store.items().map((item) =>
            item._id === conversationId ? { ...item, lastMessageStatus: status } : item,
          ),
        });
      },
      clear(): void {
        latestRequestId++;
        patchState(store, {
          items: [],
          cursor: null,
          selectedId: null,
          loading: false,
          error: null,
          messageSearchResults: [],
          searchingMessages: false,
          messageSearchQuery: '',
          highlightMessageId: null,
        });
      },
    };
  }),
);
