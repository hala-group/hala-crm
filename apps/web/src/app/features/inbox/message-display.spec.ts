import { describe, expect, it } from 'vitest';
import { type ConversationView, type MessageView } from '@hala/shared';
import { conversationPreview, conversationTimeFormat, messageDayKey, messageDayLabel, messageStatusLabel, missingMessageContent, visibleMessages } from './message-display';

describe('message display fallback', () => {
  it('replaces legacy technical placeholders without hiding real text', () => {
    const conversation = { lastMessagePreview: '[text]', lastMessageType: 'text' } as ConversationView;
    expect(conversationPreview(conversation)).toBe('محتوى الرسالة غير متاح');
    expect(conversationPreview({ ...conversation, lastMessagePreview: 'مرحبا' })).toBe('مرحبا');
    expect(conversationPreview({ ...conversation, lastMessagePreview: '[image]', lastMessageType: 'image' })).toBe('صورة');
  });

  it('distinguishes missing text from other message types and localizes status', () => {
    expect(missingMessageContent({ type: 'text' } as MessageView)).toBe('محتوى الرسالة غير متاح');
    expect(missingMessageContent({ type: 'document' } as MessageView)).toBe('مستند');
    expect(messageStatusLabel('read')).toBe('قُرئت');
  });

  it('uses compact WhatsApp-style dates for recent conversations', () => {
    const now = new Date(2026, 10, 10, 12);
    expect(conversationTimeFormat(new Date(2026, 10, 10, 9).toISOString(), now)).toBe('HH:mm');
    expect(conversationTimeFormat(new Date(2026, 10, 9, 9).toISOString(), now)).toBe('dd/MM');
    expect(conversationTimeFormat(new Date(2025, 10, 9, 9).toISOString(), now)).toBe('dd/MM/yy');
  });

  it('labels message days as today, yesterday, or a localized date', () => {
    const now = new Date(2026, 10, 19, 12);
    const today = new Date(2026, 10, 19, 8).toISOString();
    const yesterday = new Date(2026, 10, 18, 23).toISOString();
    const older = new Date(2026, 10, 12, 9).toISOString();

    expect(messageDayLabel(today, now)).toBe('اليوم');
    expect(messageDayLabel(yesterday, now)).toBe('أمس');
    expect(messageDayLabel(older, now)).toContain('12 نوفمبر 2026');
    expect(messageDayKey(today)).toBe(messageDayKey(new Date(2026, 10, 19, 18).toISOString()));
    expect(messageDayKey(yesterday)).not.toBe(messageDayKey(today));
    expect(messageDayKey('invalid')).toBeNull();
  });

  it('omits stored reaction records from the chat timeline', () => {
    const text = { _id: 'text', type: 'text' } as MessageView;
    const reaction = { _id: 'reaction', type: 'reaction' } as MessageView;
    expect(visibleMessages([reaction, text])).toEqual([text]);
  });
});
