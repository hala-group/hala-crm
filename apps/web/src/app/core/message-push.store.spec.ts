import '@angular/compiler';
import { createEnvironmentInjector, Injector } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SwPush } from '@angular/service-worker';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { PermissionsStore } from './permissions.store';
import { FirebasePushClient } from './firebase-push.client';
import { MessagePushStore } from './message-push.store';
import { type Me } from './models';

vi.mock('./firebase-push.client', () => ({ FirebasePushClient: class FirebasePushClient {} }));

const me: Me = { id: 'user1', tenantId: 'tenant1', name: 'Agent', email: 'test@example.invalid', status: 'active',
  role: { id: 'role1', name: 'Agent', permissions: ['conversations:read'] },
  accountMemberships: [{ accountId: 'account1', level: 'view' }] };

function setup(saved = false) {
  const storage = new Map<string, string>();
  if (saved) storage.set('hala:message-push:tenant1:user1', 'fid1');
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key)
  });
  let callback: ((fid: string) => void) | undefined;
  const stop = vi.fn();
  const client = {
    supported: () => true, permission: () => 'granted', requestPermission: vi.fn(async () => 'granted'),
    connect: vi.fn(async (_config: unknown, registered: (fid: string) => void) => {
      callback = registered; registered('fid1'); return stop;
    })
  };
  const http = {
    get: vi.fn(() => of({ enabled: true, config: { apiKey: 'public', authDomain: 'test.firebaseapp.com',
      projectId: 'test', messagingSenderId: '123', appId: 'web-test' }, vapidKey: 'shared-key' })),
    post: vi.fn(() => of({ ok: true })), request: vi.fn(() => of({ ok: true }))
  };
  const injector = createEnvironmentInjector([MessagePushStore, PermissionsStore,
    { provide: FirebasePushClient, useValue: client }, { provide: HttpClient, useValue: http },
    { provide: SwPush, useValue: { isEnabled: true } }], Injector.NULL);
  injector.get(PermissionsStore).setCurrent(me);
  return { store: injector.get(MessagePushStore), http, client, storage, stop, injector,
    notify: (fid: string) => callback?.(fid) };
}

afterEach(() => vi.unstubAllGlobals());

describe('message push opt-in lifecycle', () => {
  it('loads configuration without prompting or registering until the user opts in', async () => {
    const h = setup();
    try {
      await h.store.initialize();
      expect(h.client.requestPermission).not.toHaveBeenCalled();
      expect(h.client.connect).not.toHaveBeenCalled();
      await h.store.enable();
      expect(h.client.requestPermission).toHaveBeenCalledOnce();
      expect(h.http.post).toHaveBeenCalledWith('/api/v1/message-push/installations', { fid: 'fid1' });
      expect(h.store.enabled()).toBe(true);
    } finally { h.injector.destroy(); }
  });

  it('restores only the signed-in user opt-in and uploads changed FIDs', async () => {
    const h = setup(true);
    try {
      await h.store.initialize();
      expect(h.client.requestPermission).not.toHaveBeenCalled();
      expect(h.store.enabled()).toBe(true);
      h.notify('fid2');
      await Promise.resolve();
      expect(h.http.post).toHaveBeenLastCalledWith('/api/v1/message-push/installations', { fid: 'fid2' });
      expect(h.storage.get('hala:message-push:tenant1:user1')).toBe('fid2');
    } finally { h.injector.destroy(); }
  });

  it('does not subscribe when notification permission is denied', async () => {
    const h = setup();
    h.client.requestPermission.mockResolvedValue('denied');
    try {
      await h.store.initialize(); await h.store.enable();
      expect(h.http.post).not.toHaveBeenCalled();
      expect(h.store.enabled()).toBe(false);
      expect(h.store.error()).toContain('محظورة');
    } finally { h.injector.destroy(); }
  });

  it('removes only the message registration on opt-out and stops later callbacks', async () => {
    const h = setup(true);
    const postMessage = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });
    try {
      await h.store.initialize(); await h.store.disable(); h.notify('late-fid');
      expect(h.http.request).toHaveBeenCalledWith('DELETE', '/api/v1/message-push/installations', { body: { fid: 'fid1' } });
      expect(h.stop).toHaveBeenCalledOnce();
      expect(h.http.post).toHaveBeenCalledOnce();
      expect(h.storage.size).toBe(0);
      expect(h.store.enabled()).toBe(false);
      expect(postMessage).toHaveBeenCalledWith({ type: 'HALA_CLOSE_MESSAGE_NOTIFICATIONS', tenantId: me.tenantId, recipientId: me.id });
    } finally { h.injector.destroy(); }
  });

  it('removes the current user registration at logout and preserves opt-in for the next login', async () => {
    const h = setup(true);
    const postMessage = vi.fn();
    vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage } } });
    try {
      await h.store.initialize(); await h.store.logout(); h.notify('late-fid');
      expect(h.http.request).toHaveBeenCalledOnce();
      expect(h.http.post).toHaveBeenCalledOnce();
      expect(h.store.enabled()).toBe(false);
      expect(h.storage.size).toBe(1);
      expect(postMessage).toHaveBeenCalledWith({ type: 'HALA_CLOSE_MESSAGE_NOTIFICATIONS', tenantId: me.tenantId, recipientId: me.id });
    } finally { h.injector.destroy(); }
  });

  it('retains the registration to allow retry after a failed opt-out', async () => {
    const h = setup(true);
    try {
      await h.store.initialize();
      h.http.request.mockReturnValue(throwError(() => new Error('offline')));
      await h.store.disable();
      expect(h.store.enabled()).toBe(true);
      expect(h.storage.size).toBe(1);
      expect(h.store.error()).toContain('تعذر');
    } finally { h.injector.destroy(); }
  });
});
