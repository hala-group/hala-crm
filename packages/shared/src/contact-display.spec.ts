import { describe, expect, it } from 'vitest';
import { contactDisplayName, contactPhoneNumber } from './contact-display.js';

describe('contact display name', () => {
  it('uses a saved name or a phone before any WhatsApp identifier', () => {
    expect(contactDisplayName({ displayName: ' Aisha ', pushName: 'Other', waId: 'lid@71722363576571' })).toBe('Aisha');
    expect(contactDisplayName({ phoneE164: '+201001234567', waId: 'lid@71722363576571' })).toBe('+201001234567');
    expect(contactDisplayName({ waId: '201001234567@s.whatsapp.net' })).toBe('+201001234567');
  });

  it('does not expose a raw LID or broadcast identifier as a title', () => {
    expect(contactDisplayName({ waId: 'lid@71722363576571' })).toBe('رقم غير متاح · معرّف 6571');
    expect(contactDisplayName({ isSelf: true, waId: 'lid@71722363576571' })).toBe('أنت (رسائل شخصية)');
    expect(contactDisplayName({ waId: 'status@broadcast' })).toBe('حالات واتساب');
  });

  it('shows a phone only when the WhatsApp ID contains one', () => {
    expect(contactPhoneNumber('201001234567@s.whatsapp.net')).toBe('+201001234567');
    expect(contactPhoneNumber('lid@71722363576571')).toBeNull();
    expect(contactPhoneNumber('status@broadcast')).toBeNull();
  });

  it('determines self chat from the source account rather than a saved name or shared flag', () => {
    const contact = { waId: '201001234567@s.whatsapp.net', isSelf: true, displayName: 'أنت (رسائل شخصية)', pushName: 'الاسم الصحيح' };
    expect(contactDisplayName(contact, { phoneNumber: '201001234567' })).toBe('أنت (رسائل شخصية)');
    expect(contactDisplayName(contact, { phoneNumber: '201009999999' })).toBe('الاسم الصحيح');
    expect(contactDisplayName(contact, { phoneNumber: '201001234567', ownJid: '201009999999@s.whatsapp.net' })).toBe('الاسم الصحيح');
    expect(contactDisplayName({ ...contact, pushName: 'أنت' }, { phoneNumber: '201009999999' })).toBe('+201001234567');
    expect(contactDisplayName({ ...contact, waId: '201001234567@lid' }, { ownJid: '201001234567@s.whatsapp.net' })).toBe('الاسم الصحيح');
    expect(contactDisplayName({ ...contact, waId: '777777777777@lid' }, { ownLid: '777777777777:2@lid' })).toBe('أنت (رسائل شخصية)');
  });
});
