import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface StoredObject { stream: Readable; mimeType?: string; size?: number }
export type StorageDriver = 'local' | 's3' | 'hostinger';
export interface StoragePort {
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  open(key: string): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

function safeKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(key) || key.includes('..')) throw new Error('Invalid storage key');
}

export class LocalStorage implements StoragePort {
  private readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  private path(key: string): string {
    safeKey(key);
    const target = resolve(this.root, key);
    if (!target.startsWith(this.root + sep)) throw new Error('Storage path escape');
    return target;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const path = this.path(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  async open(key: string): Promise<StoredObject> {
    return { stream: createReadStream(this.path(key)) };
  }
  async delete(key: string): Promise<void> { await rm(this.path(key), { force: true }); }
}

export class S3Storage implements StoragePort {
  private readonly client: S3Client;
  constructor(private readonly bucket: string, options: { endpoint?: string; accessKeyId?: string; secretAccessKey?: string; region?: string }) {
    this.client = new S3Client({
      region: options.region ?? 'us-east-1', endpoint: options.endpoint,
      forcePathStyle: Boolean(options.endpoint),
      credentials: options.accessKeyId && options.secretAccessKey
        ? { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } : undefined
    });
  }
  async put(key: string, data: Buffer, mimeType: string): Promise<void> {
    safeKey(key);
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mimeType }));
  }
  async open(key: string): Promise<StoredObject> {
    safeKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body || !(result.Body instanceof Readable)) throw new Error('S3 did not return a Node stream');
    return { stream: result.Body, mimeType: result.ContentType, size: result.ContentLength };
  }
  async delete(key: string): Promise<void> {
    safeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

interface HostingerUploadResponse { key?: string; url?: string }

/** Private remote storage API hosted beside the PHP endpoints in deployment/hostinger-api. */
export class HostingerStorage implements StoragePort {
  private readonly baseUrl: URL;
  constructor(private readonly apiKey: string, apiUrl: string) {
    this.baseUrl = new URL(`${apiUrl.replace(/\/+$/, '')}/`);
    if (this.baseUrl.protocol !== 'https:' && this.baseUrl.hostname !== 'localhost') {
      throw new Error('Hostinger storage API must use HTTPS');
    }
  }

  private endpoint(file: 'upload.php' | 'files.php', key?: string): URL {
    const url = new URL(file, this.baseUrl);
    if (key) url.searchParams.set('key', key);
    return url;
  }

  private headers(): HeadersInit { return { Authorization: `Bearer ${this.apiKey}` }; }

  async put(key: string, data: Buffer, mimeType: string): Promise<void> {
    safeKey(key);
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(data)], { type: mimeType }), key.split('/').at(-1) ?? 'media');
    form.set('key', key);
    const response = await fetch(this.endpoint('upload.php'), { method: 'POST', headers: this.headers(), body: form,
      signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`HOSTINGER_STORAGE_UPLOAD_${response.status}`);
    const result = await response.json() as HostingerUploadResponse;
    if (result.key !== key) throw new Error('HOSTINGER_STORAGE_KEY_MISMATCH');
  }

  async open(key: string): Promise<StoredObject> {
    safeKey(key);
    const response = await fetch(this.endpoint('files.php', key), { headers: this.headers(), signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw new Error(`HOSTINGER_STORAGE_OPEN_${response.status}`);
    const body = response.body;
    const stream = Readable.from((async function* () {
      const reader = body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) return;
          yield Buffer.from(chunk.value);
        }
      } finally { reader.releaseLock(); }
    })());
    return { stream, mimeType: response.headers.get('content-type') ?? undefined,
      size: Number(response.headers.get('content-length')) || undefined };
  }

  async delete(key: string): Promise<void> {
    safeKey(key);
    const response = await fetch(this.endpoint('files.php', key), { method: 'DELETE', headers: this.headers(),
      signal: AbortSignal.timeout(30_000) });
    if (!response.ok && response.status !== 404) throw new Error(`HOSTINGER_STORAGE_DELETE_${response.status}`);
  }
}

function configuredDriver(env: NodeJS.ProcessEnv): StorageDriver {
  const driver = env.NODE_ENV === 'test' ? 'local' : env.STORAGE_DRIVER ?? 'hostinger';
  if (driver !== 'local' && driver !== 's3' && driver !== 'hostinger') throw new Error('Unknown STORAGE_DRIVER');
  return driver;
}

function createStorage(env: NodeJS.ProcessEnv, driver: StorageDriver): StoragePort {
  if (driver === 'hostinger') {
    if (!env.HOSTINGER_STORAGE_API_URL || !env.HOSTINGER_STORAGE_API_KEY) {
      throw new Error('HOSTINGER_STORAGE_API_URL and HOSTINGER_STORAGE_API_KEY are required for Hostinger storage');
    }
    return new HostingerStorage(env.HOSTINGER_STORAGE_API_KEY, env.HOSTINGER_STORAGE_API_URL);
  }
  if (driver === 's3') {
    if (!env.S3_BUCKET) throw new Error('S3_BUCKET is required for S3 storage');
    return new S3Storage(env.S3_BUCKET, {
      endpoint: env.S3_ENDPOINT, accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY,
      region: env.S3_REGION
    });
  }
  if (driver !== 'local') throw new Error('Unknown STORAGE_DRIVER');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const configured = env.STORAGE_LOCAL_PATH ?? './storage';
  return new LocalStorage(isAbsolute(configured) ? configured : resolve(root, configured));
}

/** Resolves both the active provider for new files and providers recorded on older media records. */
export class StorageRegistry implements StoragePort {
  readonly defaultDriver: StorageDriver;
  private readonly providers = new Map<StorageDriver, StoragePort>();

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.defaultDriver = configuredDriver(env);
    this.providers.set(this.defaultDriver, createStorage(env, this.defaultDriver));
  }

  forDriver(driver: StorageDriver = this.defaultDriver): StoragePort {
    let storage = this.providers.get(driver);
    if (!storage) {
      storage = createStorage(this.env, driver);
      this.providers.set(driver, storage);
    }
    return storage;
  }

  put(key: string, data: Buffer, mimeType: string): Promise<void> {
    return this.forDriver().put(key, data, mimeType);
  }

  open(key: string): Promise<StoredObject> { return this.forDriver().open(key); }
  delete(key: string): Promise<void> { return this.forDriver().delete(key); }
}

export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env, driver?: StorageDriver): StoragePort {
  const selected = driver ?? configuredDriver(env);
  return createStorage(env, selected);
}

export function createStorageRegistry(env: NodeJS.ProcessEnv = process.env): StorageRegistry {
  return new StorageRegistry(env);
}
