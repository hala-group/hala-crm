import '@angular/compiler';
import { createEnvironmentInjector, Injector } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type AccountView } from '@hala/shared';
import { AccountsStore } from './accounts.store';

describe('AccountsStore', () => {
  it('keeps a card after an accepted delete and removes it only when refreshed server data confirms completion', async () => {
    const account: AccountView = { _id: 'account-1', tenantId: 'tenant-1', label: 'Support', provider: 'baileys',
      status: 'connected', desiredState: 'connected', capabilities: ['text'] };
    const cleanup = { id: 'job-1', operation: 'delete' as const, state: 'queued' as const, processedMedia: 0, totalMedia: 0 };
    const http = { get: vi.fn(() => of([account])), delete: vi.fn(() => of({ accepted: true, cleanup })) };
    const injector = createEnvironmentInjector([AccountsStore, { provide: HttpClient, useValue: http }], Injector.NULL);
    try {
      const store = injector.get(AccountsStore);
      await store.load(); await store.remove(account._id);
      expect(store.accounts()).toHaveLength(1);
      expect(store.accounts()[0]?.cleanup).toEqual(cleanup);
      expect(store.accounts()[0]?.desiredState).toBe('disconnected');
      http.get.mockReturnValueOnce(of([]));
      await store.refresh();
      expect(store.accounts()).toHaveLength(0);
    } finally { injector.destroy(); }
  });

  it('loads number cards and applies scoped status updates', async () => {
    const account: AccountView = {
      _id: 'account-1', tenantId: 'tenant-1', label: 'Support', provider: 'baileys',
      status: 'created', desiredState: 'disconnected', capabilities: ['text']
    };
    const http = { get: vi.fn(() => of([account])) };
    const injector = createEnvironmentInjector([AccountsStore, { provide: HttpClient, useValue: http }], Injector.NULL);
    const store = injector.get(AccountsStore);
    await store.load();
    expect(http.get).toHaveBeenCalledWith('/api/v1/whatsapp/accounts');
    expect(store.accounts()).toHaveLength(1);
    store.applyStatus({ accountId: 'account-1', status: 'connected', phoneNumber: '201234567890' });
    expect(store.accounts()[0]?.status).toBe('connected');
    expect(store.accounts()[0]?.phoneNumber).toBe('201234567890');
    store.clear();
    expect(store.accounts()).toEqual([]);
    injector.destroy();
  });
});
