import '@angular/compiler';
import { createEnvironmentInjector, Injector } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { type AccountView } from '@hala/shared';
import { AccountsStore } from './accounts.store';

describe('AccountsStore', () => {
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
