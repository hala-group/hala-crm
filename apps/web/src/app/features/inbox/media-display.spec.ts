import { describe, expect, it } from 'vitest';
import { mediaKindLabel, mediaSourceUrl } from './media-display';

describe('media display', () => {
  it('loads image thumbnails and only requests the original for the full-screen viewer', () => {
    expect(mediaSourceUrl('media-1', 'image')).toBe('/api/v1/media/media-1?thumbnail=true');
    expect(mediaSourceUrl('media-1', 'sticker')).toBe('/api/v1/media/media-1?thumbnail=true');
    expect(mediaSourceUrl('media-1', 'image', true)).toBe('/api/v1/media/media-1');
  });

  it('uses the authorized original media endpoint for audio, video, and documents', () => {
    for (const kind of ['audio', 'voice', 'video', 'document']) {
      expect(mediaSourceUrl('media-1', kind)).toBe('/api/v1/media/media-1');
    }
  });

  it('provides localized media labels for accessible controls and download tiles', () => {
    expect(mediaKindLabel('voice')).toBe('رسالة صوتية');
    expect(mediaKindLabel('document')).toBe('مستند');
    expect(mediaKindLabel('other')).toBe('مرفق');
  });
});
