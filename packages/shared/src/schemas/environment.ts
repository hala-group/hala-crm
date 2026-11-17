import { z } from 'zod';

export const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MONGO_URI: z.url().default('mongodb://localhost:27017/hala_crm'),
  REDIS_URL: z.url().default('redis://localhost:6379'),
  CLOUD_GRAPH_VERSION: z.preprocess(value => value === '' ? undefined : value,
    z.string().regex(/^v\d+\.\d+$/).optional()),
  STORAGE_DRIVER: z.enum(['local', 's3', 'hostinger']).default('hostinger'),
  STORAGE_LOCAL_PATH: z.preprocess(value => value === '' ? undefined : value, z.string().optional()),
  S3_ENDPOINT: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  S3_REGION: z.preprocess(value => value === '' ? undefined : value, z.string().optional()),
  S3_BUCKET: z.preprocess(value => value === '' ? undefined : value, z.string().optional()),
  S3_ACCESS_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().optional()),
  S3_SECRET_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().optional()),
  HOSTINGER_STORAGE_API_URL: z.preprocess(value => value === '' ? undefined : value, z.url().optional()),
  HOSTINGER_STORAGE_API_KEY: z.preprocess(value => value === '' ? undefined : value, z.string().min(32).optional()),
  CORS_ORIGINS: z.string().default('http://localhost:4200'),
  WORKER_ID: z.string().optional(),
  MAX_SESSIONS_PER_WORKER: z.coerce.number().int().positive().default(200),
  LEASE_TTL_MS: z.coerce.number().int().positive().default(30000)
}).refine(value => value.STORAGE_DRIVER !== 's3' || Boolean(value.S3_BUCKET),
  { message: 'S3_BUCKET is required when STORAGE_DRIVER=s3' })
  .refine(value => value.STORAGE_DRIVER !== 'hostinger' || value.NODE_ENV === 'test' ||
    Boolean(value.HOSTINGER_STORAGE_API_URL && value.HOSTINGER_STORAGE_API_KEY),
    { message: 'HOSTINGER_STORAGE_API_URL and HOSTINGER_STORAGE_API_KEY are required when STORAGE_DRIVER=hostinger' });

export type Environment = z.infer<typeof environmentSchema>;
