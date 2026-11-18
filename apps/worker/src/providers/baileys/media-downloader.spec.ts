import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { downloadBaileysMedia } from './media-downloader.js';

const download = vi.hoisted(() => vi.fn());
vi.mock('@whiskeysockets/baileys', () => ({ downloadContentFromMessage: download }));

const source = { kind: 'image' as const, mimeType: 'image/png', mediaKeyBase64: Buffer.alloc(32).toString('base64'),
  directPath: '/expired' };

describe('expired WhatsApp media', () => {
  it('requests a fresh path after a 403 while consuming the stream', async () => {
    const expired = new Readable({ read() { this.destroy(Object.assign(new Error('expired'), { response: { status: 403 } })); } });
    download.mockReset().mockResolvedValueOnce(expired).mockResolvedValueOnce(Readable.from([Buffer.from('media')]));
    const refresh = vi.fn(async () => ({ ...source, directPath: '/fresh' }));
    await expect(downloadBaileysMedia(source, refresh)).resolves.toEqual(Buffer.from('media'));
    expect(refresh).toHaveBeenCalledOnce();
    expect(download.mock.calls[1]?.[0]).toMatchObject({ directPath: '/fresh' });
  });

  it('does not retry unrelated failures', async () => {
    const broken = new Readable({ read() { this.destroy(new Error('bad key')); } });
    download.mockReset().mockResolvedValueOnce(broken);
    const refresh = vi.fn();
    await expect(downloadBaileysMedia(source, refresh)).rejects.toThrow('bad key');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('cancels a stalled decrypting stream when the worker stops', async () => {
    const stream = new PassThrough();
    download.mockReset().mockResolvedValueOnce(stream);
    const controller = new AbortController();
    const result = expect(downloadBaileysMedia(source, undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await result;
    expect(stream.destroyed).toBe(true);
  });
});
