import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostingerStorage, LocalStorage, StorageRegistry } from './storage.js';

const key = '507f1f77bcf86cd799439011/507f1f77bcf86cd799439012/507f1f77bcf86cd799439013/original';

describe('HostingerStorage', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uploads bytes to the documented multipart field with the private object key', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ key }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = new HostingerStorage('a'.repeat(40), 'https://example.test/api');
    await storage.put(key, Buffer.from('media'), 'image/jpeg');
    const [url, request] = fetchMock.mock.calls[0]!;
    const options = request!;
    expect(String(url)).toBe('https://example.test/api/upload.php');
    expect(options.method).toBe('POST');
    expect((options.headers as Record<string, string>).Authorization).toBe(`Bearer ${'a'.repeat(40)}`);
    expect(options.body).toBeInstanceOf(FormData);
    expect((options.body as FormData).get('key')).toBe(key);
    expect((options.body as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('opens and deletes only validated object keys', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(Buffer.from('image-bytes'), { headers: { 'content-type': 'image/jpeg' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const storage = new HostingerStorage('b'.repeat(40), 'https://example.test/api/');
    const opened = await storage.open(key);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('image-bytes');
    expect(opened.mimeType).toBe('image/jpeg');
    await storage.delete(key);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('files.php?key=');
    expect(fetchMock.mock.calls[1]![1]?.method).toBe('DELETE');
    await expect(storage.delete('../outside')).rejects.toThrow('Invalid storage key');
  });

  it('requires HTTPS for a remote storage endpoint', () => {
    expect(() => new HostingerStorage('c'.repeat(40), 'http://files.example.test/api')).toThrow('must use HTTPS');
  });
});

describe('StorageRegistry', () => {
  it('keeps the active write provider while resolving providers stored on existing media', () => {
    const registry = new StorageRegistry({
      STORAGE_DRIVER: 'hostinger', HOSTINGER_STORAGE_API_URL: 'https://example.test/api',
      HOSTINGER_STORAGE_API_KEY: 'd'.repeat(40), STORAGE_LOCAL_PATH: './test-media'
    });
    expect(registry.defaultDriver).toBe('hostinger');
    expect(registry.forDriver()).toBeInstanceOf(HostingerStorage);
    expect(registry.forDriver('local')).toBeInstanceOf(LocalStorage);
    expect(registry.forDriver('hostinger')).toBe(registry.forDriver());
  });
});
