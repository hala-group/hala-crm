import { inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { type ConversationView, type MessageView, type OutgoingMessageInput, type ComposerMessageInput } from '@hala/shared';
import { MessagesStore } from './messages.store';
import { InboxStore } from './inbox.store';

type ComposerType = OutgoingMessageInput['type'];
type MediaKind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';

export const ComposerStore = signalStore(
  { providedIn: 'root' },
  withState<{ type: ComposerType; mediaId: string | null; previewUrl: string | null; fileName: string | null;
    replyToMessageId: string | null; uploading: boolean; sending: boolean; error: string | null }>({
    type: 'text', mediaId: null, previewUrl: null, fileName: null, replyToMessageId: null,
    uploading: false, sending: false, error: null
  }),
  withMethods((store, http = inject(HttpClient), messages = inject(MessagesStore), inbox = inject(InboxStore)) => ({
    setType(type: ComposerType): void {
      const preview = store.previewUrl();
      if (preview) URL.revokeObjectURL(preview);
      patchState(store, { type, mediaId: null, previewUrl: null, fileName: null, error: null });
    },
    setError(error: string | null): void { patchState(store, { error }); },
    clearAttachment(): void {
      const preview = store.previewUrl();
      if (preview) URL.revokeObjectURL(preview);
      patchState(store, { type: 'text', mediaId: null, previewUrl: null, fileName: null, error: null });
    },
    reply(id: string | null): void { patchState(store, { replyToMessageId: id }); },
    async upload(file: File, accountId: string, kind: MediaKind): Promise<void> {
      patchState(store, { uploading: true, error: null });
      try {
        const body = new FormData();
        body.set('accountId', accountId); body.set('kind', kind); body.set('file', file);
        const result = await firstValueFrom(http.post<{ mediaId: string }>('/api/v1/media/upload', body));
        if (store.previewUrl()) URL.revokeObjectURL(store.previewUrl()!);
        patchState(store, { mediaId: result.mediaId, previewUrl: URL.createObjectURL(file), fileName: file.name, type: kind });
      } catch (error) {
        patchState(store, { error: error instanceof HttpErrorResponse ? error.error?.message ?? 'تعذر رفع الملف' : 'تعذر رفع الملف' });
        throw error;
      } finally { patchState(store, { uploading: false }); }
    },
    async send(conversation: ConversationView, data: ComposerMessageInput): Promise<boolean> {
      if (store.sending()) return false;
      const clientMessageId = crypto.randomUUID();
      const input = { ...data, accountId: conversation.accountId, conversationId: conversation._id, clientMessageId,
        ...(data.type !== 'reaction' && store.replyToMessageId() ? { replyToMessageId: store.replyToMessageId()! } : {}) } as OutgoingMessageInput;
      const reactionTarget = data.type === 'reaction'
        ? messages.items().find(item => item._id === data.targetMessageId) : undefined;
      const optimistic: MessageView = { _id: clientMessageId, clientMessageId,
        tenantId: conversation.tenantId, accountId: conversation.accountId, conversationId: conversation._id,
        contactId: conversation.contactId, waMessageId: clientMessageId.replaceAll('-', '').toUpperCase(),
        direction: 'out', type: input.type, timestamp: new Date().toISOString(), status: 'pending',
        text: input.type === 'text' ? input.text : undefined,
        caption: 'caption' in input ? input.caption : undefined,
        mediaId: 'mediaId' in input ? input.mediaId : undefined,
        reaction: data.type === 'reaction' && reactionTarget
          ? { targetWaMessageId: reactionTarget.waMessageId, emoji: data.emoji } : undefined };
      messages.upsert(optimistic);
      if (data.type !== 'reaction') inbox.updateLastMessageStatus(conversation._id, 'pending');
      patchState(store, { sending: true, error: null });
      try {
        const saved = await firstValueFrom(http.post<MessageView>('/api/v1/messages', input));
        messages.upsert(saved);
        if (data.type !== 'reaction') {
          if (store.previewUrl()) URL.revokeObjectURL(store.previewUrl()!);
          patchState(store, { type: 'text', mediaId: null, previewUrl: null, fileName: null,
            replyToMessageId: null });
        }
        return true;
      } catch (error) {
        const response = error instanceof HttpErrorResponse ? error : null;
        const messageId = response?.error?.messageId as string | undefined;
        messages.upsert({ ...optimistic, _id: messageId ?? optimistic._id, status: 'failed',
          failureReason: response?.error?.code ?? 'SEND_FAILED' });
        patchState(store, { error: response?.error?.message ?? 'تعذر الإرسال' });
        return false;
      } finally { patchState(store, { sending: false }); }
    },
    async retry(message: MessageView): Promise<void> {
      const result = await firstValueFrom(http.post<{ accepted: boolean }>(`/api/v1/messages/${message._id}/retry`, {}));
      if (result.accepted) messages.updateStatus({ messageId: message._id, status: 'pending' });
    },
    async edit(message: MessageView, text: string): Promise<void> {
      await firstValueFrom(http.patch(`/api/v1/messages/${message._id}`, { text }));
    },
    async remove(message: MessageView, scope: 'me' | 'everyone'): Promise<void> {
      await firstValueFrom(http.delete(`/api/v1/messages/${message._id}`, { params: { scope } }));
      if (scope === 'me') messages.remove(message._id);
    },
    async forward(message: MessageView, conversationIds: string[]): Promise<void> {
      await firstValueFrom(http.post(`/api/v1/messages/${message._id}/forward`, { conversationIds }));
    }
  }))
);
