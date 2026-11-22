import { type Model, type Types } from 'mongoose';
import { type StorageDriver, type StorageRegistry } from '@hala/shared/storage';

export type CleanupProgress = (processedMedia: number, totalMedia: number) => Promise<void>;

/** Checkpoint each asset only after both original and thumbnail are gone. */
export async function cleanupMedia(model: Model<Record<string, unknown>>, storage: StorageRegistry,
  scope: { tenantId: Types.ObjectId; accountId: Types.ObjectId }, initialTotal = 0,
  progress: CleanupProgress = async () => {}): Promise<number> {
  let remaining = await model.countDocuments(scope);
  const total = Math.max(initialTotal, remaining);
  await progress(total - remaining, total);
  while (remaining > 0) {
    const batch = await model.find(scope).sort({ _id: 1 }).limit(5)
      .select('storageKey thumbnailKey storageDriver').lean();
    if (!batch.length) break;
    const results = await Promise.allSettled(batch.map(async asset => {
      const driver = storage.forDriver(asset['storageDriver'] as StorageDriver | undefined);
      await driver.delete(asset['storageKey'] as string);
      if (asset['thumbnailKey']) await driver.delete(asset['thumbnailKey'] as string);
      await model.deleteOne({ ...scope, _id: asset._id });
    }));
    remaining = await model.countDocuments(scope);
    await progress(Math.max(0, total - remaining), total);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  return total;
}
