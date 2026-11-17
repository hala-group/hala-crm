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
    expect(contactDisplayName({ waId: 'status@broadcast' })).toBe('حالات واتساب');
  });

  it('shows a phone only when the WhatsApp ID contains one', () => {
    expect(contactPhoneNumber('201001234567@s.whatsapp.net')).toBe('+201001234567');
    expect(contactPhoneNumber('lid@71722363576571')).toBeNull();
    expect(contactPhoneNumber('status@broadcast')).toBeNull();
  });
});
