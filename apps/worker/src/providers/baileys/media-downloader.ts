import { addAbortSignal } from 'node:stream';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { type MediaSource } from '@hala/shared';

export async function downloadBaileysMedia(source: MediaSource, refresh?: () => Promise<MediaSource>, signal?: AbortSignal): Promise<Buffer> {
  if (!source.mediaKeyBase64) throw new Error('Baileys media key missing');
  const read = async (current: MediaSource): Promise<Buffer> => {
    const timeout = AbortSignal.timeout(30_000);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const stream = await downloadContentFromMessage({
      mediaKey: Buffer.from(current.mediaKeyBase64 ?? source.mediaKeyBase64!, 'base64'),
      directPath: current.directPath, url: current.url
    }, source.kind, { options: { signal: deadline } });
    const chunks: Buffer[] = [];
    let size = 0;
    const max = Number(process.env.MEDIA_MAX_BYTES ?? 50 * 1024 * 1024);
    for await (const chunk of addAbortSignal(deadline, stream)) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > max) throw new Error('Media exceeds MEDIA_MAX_BYTES');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  };
  try {
    return await read(source);
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (!refresh || (status !== 403 && status !== 404 && status !== 410)) throw error;
    return read(await refresh());
  }
}
