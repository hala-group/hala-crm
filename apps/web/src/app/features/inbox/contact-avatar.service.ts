import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

type AvatarStatus = { status: 'missing' | 'pending' | 'ready' | 'unavailable' | 'failed'; checkedAt?: string };
type AvatarLoad = { blob: Blob | null; cacheMs: number };
type CachedAvatar = { promise: Promise<Blob | null>; expiresAt: number };

@Injectable({ providedIn: 'root' })
export class ContactAvatarService {
  private readonly http = inject(HttpClient);
  private readonly cache = new Map<string, CachedAvatar>();

  load(conversationId: string): Promise<Blob | null> {
    const now = Date.now();
    const cached = this.cache.get(conversationId);
    if (cached && cached.expiresAt > now) {
      this.cache.delete(conversationId);
      this.cache.set(conversationId, cached);
      return cached.promise;
    }
    this.cache.delete(conversationId);

    const entry: CachedAvatar = { promise: Promise.resolve(null), expiresAt: Number.POSITIVE_INFINITY };
    entry.promise = this.fetchAvatar(conversationId).then(result => {
      entry.expiresAt = Date.now() + result.cacheMs;
      return result.blob;
    }).catch(() => {
      entry.expiresAt = Date.now() + 15_000;
      return null;
    });
    this.cache.set(conversationId, entry);
    while (this.cache.size > 200) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return entry.promise;
  }

  private async fetchAvatar(id: string): Promise<AvatarLoad> {
    const base = `/api/v1/conversations/${id}/avatar`;
    let state = await firstValueFrom(this.http.get<AvatarStatus>(`${base}/status`));

    if (state.status === 'ready') {
      const blob = await this.readAvatar(base);
      if (state.checkedAt && Date.now() - new Date(state.checkedAt).getTime() > 7 * 86_400_000) {
        void firstValueFrom(this.http.post(`${base}/refresh`, {})).catch(() => {});
      }
      return { blob, cacheMs: 10 * 60_000 };
    }
    if (state.status === 'unavailable') return { blob: null, cacheMs: 24 * 60 * 60_000 };

    const checkedAt = state.checkedAt ? new Date(state.checkedAt).getTime() : 0;
    const stalePending = state.status === 'pending' && (!checkedAt || Date.now() - checkedAt >= 120_000);
    if (state.status === 'missing' || state.status === 'failed' || stalePending) {
      state = await firstValueFrom(this.http.post<AvatarStatus>(`${base}/refresh`, {}));
      if (state.status === 'ready') return { blob: await this.readAvatar(base), cacheMs: 10 * 60_000 };
      if (state.status === 'unavailable') return { blob: null, cacheMs: 24 * 60 * 60_000 };
      if (state.status === 'failed') return { blob: null, cacheMs: 60_000 };
    }

    for (let attempt = 0; attempt < 6 && state.status === 'pending'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      state = await firstValueFrom(this.http.get<AvatarStatus>(`${base}/status`));
      if (state.status === 'ready') {
        return { blob: await this.readAvatar(base), cacheMs: 10 * 60_000 };
      }
      if (state.status === 'unavailable') return { blob: null, cacheMs: 24 * 60 * 60_000 };
      if (state.status === 'failed') return { blob: null, cacheMs: 60_000 };
    }

    return { blob: null, cacheMs: state.status === 'pending' ? 30_000 : 60_000 };
  }

  private readAvatar(base: string): Promise<Blob> {
    return firstValueFrom(this.http.get(base, { responseType: 'blob' }));
  }
}
