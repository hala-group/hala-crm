import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Types, type Model } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineAbilityFor, SYSTEM_ROLES } from '@hala/shared';
import { type Principal } from '../../common/auth.types.js';
import { type WhatsAppAccountRecord } from '../whatsapp-accounts/account.schema.js';
import { type MediaRecord } from './inbox.schema.js';

const storage = vi.hoisted(() => ({ put: vi.fn(async (_key: string, _data: Buffer, _mimeType: string) => {}) }));
vi.mock('@hala/shared/storage', () => ({ createStorageRegistry: () => ({ defaultDriver: 'local', put: storage.put }) }));

import { MediaUploadService } from './media-upload.service.js';

const require = createRequire(import.meta.url);
const ffmpegPath = require('ffmpeg-static') as string | null;

function owner(tenantId: string): Principal {
  const id = new Types.ObjectId().toString();
  return { id, tenantId, email: 'owner@test.invalid', name: 'Owner', status: 'active',
    role: { id: 'owner', name: 'Owner', permissions: [...SYSTEM_ROLES.owner] },
    ability: defineAbilityFor({ id, tenantId }, { permissions: SYSTEM_ROLES.owner }, []), accountMemberships: [] };
}

function browserVoiceWebm(): Buffer {
  if (!ffmpegPath) throw new Error('ffmpeg-static is unavailable');
  const result = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:duration=0.2', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

describe('MediaUploadService voice notes', () => {
  beforeEach(() => storage.put.mockClear());

  it('accepts browser WebM recordings and stores WhatsApp-ready Ogg/Opus', async () => {
    const accountId = new Types.ObjectId();
    const mediaId = new Types.ObjectId();
    const accounts = { findOne: vi.fn(async () => ({ _id: accountId, provider: 'baileys' })) };
    const media = { create: vi.fn(async (record: Record<string, unknown>) => ({ ...record, _id: mediaId })) };
    const service = new MediaUploadService(accounts as unknown as Model<WhatsAppAccountRecord>,
      media as unknown as Model<MediaRecord>);
    const bytes = browserVoiceWebm();
    const file = { buffer: bytes, size: bytes.length, originalname: 'voice.webm' } as Express.Multer.File;

    const result = await service.upload(owner(new Types.ObjectId().toString()), accountId.toString(), 'voice', file);

    expect(storage.put).toHaveBeenCalledOnce();
    const [, storedBytes, storedMimeType] = storage.put.mock.calls[0]!;
    expect(storedMimeType).toBe('audio/ogg');
    expect(storedBytes.subarray(0, 4).toString('ascii')).toBe('OggS');
    expect(result).toMatchObject({ mediaId: mediaId.toString(), mimeType: 'audio/ogg' });
  });
});
