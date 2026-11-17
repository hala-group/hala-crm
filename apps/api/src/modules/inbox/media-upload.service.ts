import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { accessibleBy } from '@casl/mongoose';
import { type Model, Types } from 'mongoose';
import { fileTypeFromBuffer } from 'file-type';
import { BAILEYS_CAPABILITIES, CLOUD_API_CAPABILITIES, subject } from '@hala/shared';
import sharp from 'sharp';
import { createStorageRegistry } from '@hala/shared/storage';
import { type Principal } from '../../common/auth.types.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type MediaRecord } from './inbox.schema.js';

const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string | null;

type Kind = 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker';
const allowed: Record<Kind, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/vnd.wave', 'audio/webm'],
  voice: ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/vnd.wave', 'audio/webm'],
  document: ['application/pdf', 'application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'image/jpeg', 'image/png'],
  sticker: ['image/webp', 'image/png', 'image/jpeg']
};

async function ffmpeg(input: Buffer, args: string[], maxOutput = 16 * 1024 * 1024): Promise<{ output: Buffer; log: string }> {
  if (!ffmpegPath) throw new Error('FFMPEG_UNAVAILABLE');
  const tempDir = await mkdtemp(join(tmpdir(), 'hala-ffmpeg-'));
  const tempInput = join(tempDir, 'input.bin');
  await writeFile(tempInput, input);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'info', '-i', tempInput, ...args, 'pipe:1'],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let size = 0;
      let log = '';
      const timeout = setTimeout(() => child.kill(), 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxOutput) child.kill();
        else chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4096); });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => {
        clearTimeout(timeout);
        if (code !== 0 || size > maxOutput) {
          Logger.error(`ffmpeg failed (code=${code}, size=${size}, maxOutput=${maxOutput}):\n${log}`, 'MediaUploadService');
          reject(new UnprocessableEntityException('Invalid or oversized media'));
        } else {
          resolve({ output: Buffer.concat(chunks), log });
        }
      });
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

@Injectable()
export class MediaUploadService {
  private readonly storage = createStorageRegistry();
  constructor(
    @InjectModel('WhatsAppAccount') private readonly accounts: Model<WhatsAppAccountRecord>,
    @InjectModel('Media') private readonly media: Model<MediaRecord>
  ) {}

  async upload(principal: Principal, accountId: string, kind: Kind, file: Express.Multer.File) {
    if (!file?.buffer?.length) throw new UnprocessableEntityException('File required');
    const account = await this.accounts.findOne({ _id: accountId, $and: [accessibleBy(principal.ability, 'read').ofType('WhatsAppAccount')] });
    if (!account || !principal.ability.can('send_media', subject('Message', { tenantId: principal.tenantId, accountId }))) {
      throw new NotFoundException('Account not found');
    }
    const capabilities = account.provider === 'baileys' ? BAILEYS_CAPABILITIES : CLOUD_API_CAPABILITIES;
    if (!capabilities.includes(kind)) throw new UnprocessableEntityException({ code: 'UNSUPPORTED_BY_PROVIDER', capability: kind });
    const limitKey = kind === 'voice' ? 'AUDIO' : kind === 'sticker' ? 'IMAGE' : kind === 'document' ? 'DOC' : kind.toUpperCase();
    const maxMb = Number(process.env[`MEDIA_MAX_${limitKey}_MB`] ?? (kind === 'document' ? 100 : 16));
    if (file.size > maxMb * 1024 * 1024) throw new UnprocessableEntityException('Media exceeds size limit');
    const detected = await fileTypeFromBuffer(file.buffer);
    let mimeType = detected?.mime;
    if (!mimeType && kind === 'document' && file.buffer.every(byte => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126))) mimeType = 'text/plain';
    // file-type reports audio-only EBML recordings from MediaRecorder as video/webm.
    const isBrowserRecordedVoice = kind === 'voice' && mimeType === 'video/webm';
    if (!mimeType || (!allowed[kind].includes(mimeType) && !isBrowserRecordedVoice)) {
      throw new UnprocessableEntityException('Unsupported media format');
    }
    let bytes = file.buffer;
    let thumbnail: Buffer | undefined;
    let width: number | undefined;
    let height: number | undefined;
    if (kind === 'image' || kind === 'sticker') {
      const image = sharp(bytes, { failOn: 'error' }).rotate();
      const metadata = await image.metadata();
      width = metadata.width; height = metadata.height;
      if (kind === 'sticker') { bytes = await image.resize(512, 512, { fit: 'contain', background: '#00000000' }).webp().toBuffer(); mimeType = 'image/webp'; }
      else bytes = await image.toBuffer();
      thumbnail = await sharp(bytes).resize(320, 320, { fit: 'inside' }).jpeg().toBuffer();
    } else if (kind === 'voice') {
      bytes = (await ffmpeg(bytes, [
        '-vn', '-sn', '-dn',
        '-map_metadata', '-1',
        '-avoid_negative_ts', 'make_zero',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-vbr', 'on',
        '-f', 'ogg'
      ])).output;
      mimeType = 'audio/ogg';
    } else if (kind === 'video') {
      const result = await ffmpeg(bytes, ['-frames:v', '1', '-vf', 'scale=min(640\\,iw):-2', '-f', 'image2pipe', '-vcodec', 'mjpeg'], 2 * 1024 * 1024);
      if (!/Video:\s*h264/i.test(result.log)) throw new UnprocessableEntityException('Video must use H.264');
      thumbnail = result.output;
    }
    const id = new Types.ObjectId();
    const prefix = `${principal.tenantId}/${accountId}/${id.toString()}`;
    const key = `${prefix}/original`;
    const thumbnailKey = thumbnail ? `${prefix}/thumb` : undefined;
    await this.storage.put(key, bytes, mimeType);
    if (thumbnail && thumbnailKey) await this.storage.put(thumbnailKey, thumbnail, 'image/jpeg');
    const record = await this.media.create({ _id: id, tenantId: new Types.ObjectId(principal.tenantId), accountId: account._id,
      mimeType, size: bytes.length, fileName: file.originalname.slice(0, 255), storageKey: key,
      storageDriver: this.storage.defaultDriver,
      sha256: createHash('sha256').update(bytes).digest('hex'), width, height, thumbnailKey, status: 'ready' });
    return { mediaId: record._id.toString(), mimeType, size: bytes.length, thumbnailAvailable: Boolean(thumbnail) };
  }
}
