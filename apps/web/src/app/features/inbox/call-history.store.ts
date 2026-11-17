import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { type CallView } from '@hala/shared';

export const CallHistoryStore = signalStore(
  { providedIn: 'root' },
  withState<{ items: CallView[]; loading: boolean; error: string | null }>({
    items: [],
    loading: false,
    error: null
  }),
  withMethods((store, http = inject(HttpClient)) => {
    let requestId = 0;
    return {
      async load(): Promise<void> {
        const current = ++requestId;
        patchState(store, { loading: true, error: null });
        try {
          const items = await firstValueFrom(http.get<CallView[]>('/api/v1/calls'));
          if (current === requestId) patchState(store, { items, loading: false });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'تعذر تحميل المكالمات';
          if (current === requestId) patchState(store, { items: [], loading: false, error: message });
        }
      },
      clear(): void { requestId++; patchState(store, { items: [], loading: false, error: null }); }
    };
  })
);
