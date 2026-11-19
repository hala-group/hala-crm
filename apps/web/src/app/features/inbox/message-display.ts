import { type ConversationView, type MessageType, type MessageView } from '@hala/shared';

const typeLabels: Record<MessageType, string> = {
  text: 'رسالة نصية', image: 'صورة', video: 'فيديو', audio: 'صوت', voice: 'رسالة صوتية',
  document: 'مستند', sticker: 'ملصق', location: 'موقع', contacts: 'جهة اتصال', reaction: 'تفاعل',
  poll: 'استطلاع', poll_vote: 'تصويت', template: 'قالب', interactive: 'رسالة تفاعلية',
  system: 'رسالة نظام', unknown: 'رسالة'
};

const statusLabels: Record<MessageView['status'], string> = {
  pending: 'قيد الإرسال', sent: 'أُرسلت', delivered: 'وصلت', read: 'قُرئت', failed: 'فشل الإرسال'
};

export function messageTypeLabel(type: MessageType): string { return typeLabels[type]; }
export function messageStatusLabel(status: MessageView['status']): string { return statusLabels[status]; }

export function messageDayKey(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function messageDayLabel(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const dayOrdinal = (value: Date) => Math.floor(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / 86_400_000);
  const difference = dayOrdinal(now) - dayOrdinal(date);
  if (difference === 0) return 'اليوم';
  if (difference === 1) return 'أمس';
  return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
    day: 'numeric', month: 'long', year: 'numeric'
  }).format(date);
}

export function visibleMessages(messages: MessageView[]): MessageView[] {
  return messages.filter(message => message.type !== 'reaction').reverse();
}

export function conversationPreview(conversation: ConversationView): string {
  const raw = conversation.lastMessagePreview?.trim();
  if (raw && !/^\[[a-z_]+\]$/i.test(raw)) return raw;
  return conversation.lastMessageType === 'text' ? 'محتوى الرسالة غير متاح' : messageTypeLabel(conversation.lastMessageType);
}

export function conversationTimeFormat(timestamp: string, now = new Date()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'dd/MM';
  if (date.toDateString() === now.toDateString()) return 'HH:mm';
  return date.getFullYear() === now.getFullYear() ? 'dd/MM' : 'dd/MM/yy';
}

export function missingMessageContent(message: MessageView): string {
  if (message.revokedAt) return 'حُذفت الرسالة للجميع';
  if (message.mediaStatus === 'failed') return 'تعذر تحميل المرفق';
  if (message.mediaStatus === 'pending' || message.mediaStatus === 'uploading') return 'جارٍ تجهيز المرفق';
  return message.type === 'text' ? 'محتوى الرسالة غير متاح' : messageTypeLabel(message.type);
}
