export interface ContactDisplayInput {
  displayName?: string | null;
  pushName?: string | null;
  phoneE164?: string | null;
  waId?: string | null;
  isGroup?: boolean | null;
  isSelf?: boolean | null;
}

export function contactPhoneNumber(waId: string | null | undefined): string | null {
  const phoneJid = /^([1-9][0-9]{5,15})@s\.whatsapp\.net$/.exec(waId?.trim() ?? '');
  return phoneJid ? `+${phoneJid[1]}` : null;
}

export function contactDisplayName(contact: ContactDisplayInput): string {
  if (contact.isSelf) return 'أنت (رسائل شخصية)';
  for (const candidate of [contact.displayName, contact.pushName]) {
    const name = candidate?.trim();
    if (name && !/^[.\u2026]+$/u.test(name)) return name;
  }
  if (contact.phoneE164?.trim()) return contact.phoneE164.trim();
  const waId = contact.waId?.trim() ?? '';
  const phone = contactPhoneNumber(waId);
  if (phone) return phone;
  if (waId === 'status@broadcast') return 'حالات واتساب';
  const digits = waId.replace(/\D/g, '');
  if (contact.isGroup) return `مجموعة واتساب${digits ? ` · ${digits.slice(-4)}` : ''}`;
  return `رقم غير متاح${digits ? ` · معرّف ${digits.slice(-4)}` : ''}`;
}
