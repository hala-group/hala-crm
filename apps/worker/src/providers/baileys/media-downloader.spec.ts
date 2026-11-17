import { describe, expect, it, vi } from 'vitest';
import { downloadBaileysMedia } from './media-downloader.js';

const download = vi.hoisted(() => vi.fn());
vi.mock('@whiskeysockets/baileys', () => ({ downloadContentFromMessage: download }));

const source = { kind: 'image' as const, mimeType: 'image/png', mediaKeyBase64: Buffer.alloc(32).toString('base64'),
  directPath: '/expired' };

describe('expired WhatsApp media', () => {
  it('requests a fresh path after a 403 while consuming the stream', async () => {
    download.mockReset().mockImplementationOnce(async () => (async function* () {
      throw { response: { status: 403 } };
    })()).mockImplementationOnce(async () => (async function* () { yield Buffer.from('media'); })());
    const refresh = vi.fn(async () => ({ ...source, directPath: '/fresh' }));
    await expect(downloadBaileysMedia(source, refresh)).resolves.toEqual(Buffer.from('media'));
    expect(refresh).toHaveBeenCalledOnce();
    expect(download.mock.calls[1]?.[0]).toMatchObject({ directPath: '/fresh' });
  });

  it('does not retry unrelated failures', async () => {
    download.mockReset().mockImplementationOnce(async () => (async function* () { throw new Error('bad key'); })());
    const refresh = vi.fn();
    await expect(downloadBaileysMedia(source, refresh)).rejects.toThrow('bad key');
    expect(refresh).not.toHaveBeenCalled();
  });
});
