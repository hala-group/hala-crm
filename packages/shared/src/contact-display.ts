export interface ContactDisplayInput {
  displayName?: string | null;
  pushName?: string | null;
  phoneE164?: string | null;
  waId?: string | null;
  isGroup?: boolean | null;
  isSelf?: boolean | null;
}

export interface ContactAccountIdentity { phoneNumber?: string | null; ownJid?: string | null; ownLid?: string | null }

export function isOwnContact(contact: ContactDisplayInput, account: ContactAccountIdentity): boolean {
  if (contact.isGroup || !contact.waId) return false;
  const normalized = (id: string) => id.trim().replace(/:\d+(?=@)/, '');
  const phone = account.phoneNumber?.replace(/[^0-9]/g, '');
  const verified = [account.ownJid, account.ownLid].filter(Boolean);
  return (verified.length ? verified : [phone ? `${phone}@s.whatsapp.net` : undefined])
    .some(id => Boolean(id && normalized(id) === normalized(contact.waId!)));
}

export function contactPhoneNumber(waId: string | null | undefined): string | null {
  const phoneJid = /^([1-9][0-9]{5,15})@s\.whatsapp\.net$/.exec(waId?.trim() ?? '');
  return phoneJid ? `+${phoneJid[1]}` : null;
}

export function contactDisplayName(contact: ContactDisplayInput, account?: ContactAccountIdentity): string {
  if (account ? isOwnContact(contact, account) : contact.isSelf) return 'أنت (رسائل شخصية)';
  for (const candidate of [contact.displayName, contact.pushName]) {
    const name = candidate?.trim();
    if (name && name !== 'أنت (رسائل شخصية)' && name !== 'أنت' && !/^[.\u2026]+$/u.test(name)) return name;
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
