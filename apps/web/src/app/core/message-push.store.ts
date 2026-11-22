import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SwPush } from '@angular/service-worker';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom, timeout } from 'rxjs';
import { messagePushConfigSchema, type MessagePushConfig } from '@hala/shared';
import { PermissionsStore } from './permissions.store';
import { FirebasePushClient } from './firebase-push.client';
import { closeMessageNotifications } from './message-notification.client';

export const MessagePushStore = signalStore(
  { providedIn: 'root' },
  withState({ available: false, configured: false, enabled: false, loading: false, error: '' }),
  withMethods((store, http = inject(HttpClient), permissions = inject(PermissionsStore),
    client = inject(FirebasePushClient), swPush = inject(SwPush)) => {
    let config: MessagePushConfig = { enabled: false };
    let identity = '';
    let stop: (() => void) | undefined;
    let version = 0;
    let work: Promise<void> = Promise.resolve();
    const key = () => `hala:message-push:${identity}`;
    const read = (): string | null => { try { return localStorage.getItem(key()); } catch { return null; } };
    const save = (fid: string): void => { localStorage.setItem(key(), fid); };
    const clear = (): void => { try { localStorage.removeItem(key()); } catch { /* Storage may be unavailable. */ } };
    const remove = async (fid: string): Promise<void> => {
      await firstValueFrom(http.request('DELETE', '/api/v1/message-push/installations', { body: { fid } }).pipe(timeout(8000)));
    };
    const connect = async (): Promise<void> => {
      if (!config.enabled) return;
      const current = ++version;
      stop?.(); stop = undefined;
      let upload: Promise<void> = Promise.resolve();
      let registered = false;
      const disconnect = await client.connect(config, fid => {
        if (current !== version) return;
        registered = true;
        // Persist the FID before uploading so logout can remove an uncertain upload too.
        try { save(fid); } catch { patchState(store, { error: 'تعذر حفظ إعداد الإشعارات في هذا المتصفح.' }); return; }
        upload = firstValueFrom(http.post('/api/v1/message-push/installations', { fid }).pipe(timeout(8000)))
          .then(() => { if (current === version) patchState(store, { enabled: true, error: '' }); })
          .catch(() => { if (current === version) patchState(store, { enabled: false, error: 'تعذر تسجيل إشعارات الرسائل. حاول مجددًا.' }); });
        work = upload;
      });
      if (current !== version) { disconnect(); return; }
      stop = disconnect;
      // register may finish before onRegistered; that callback also handles later FID changes.
      if (registered) await upload;
    };
    return {
      async initialize(): Promise<void> {
        const me = permissions.me();
        if (!me || !permissions.can('conversations:read')) return;
        const nextIdentity = `${me.tenantId}:${me.id}`;
        if (identity === nextIdentity) return;
        stop?.(); stop = undefined;
        identity = nextIdentity;
        const current = ++version;
        const available = client.supported() && swPush.isEnabled;
        patchState(store, { available });
        try {
          const loadedConfig = messagePushConfigSchema.parse(await firstValueFrom(http.get('/api/v1/message-push/config').pipe(timeout(8000))));
          if (current !== version) return;
          config = loadedConfig;
          patchState(store, { configured: config.enabled });
          if (available && config.enabled && read() && client.permission() === 'granted') {
            work = connect(); await work;
          }
        } catch { patchState(store, { error: 'تعذر تحميل إعداد إشعارات الرسائل.' }); }
      },
      async enable(): Promise<void> {
        if (store.loading()) return;
        if (!store.available() || !config.enabled) return;
        patchState(store, { loading: true, error: '' });
        // Request from the click handler before asynchronous SDK loading.
        const permission = client.requestPermission();
        try {
          if (await permission !== 'granted') {
            patchState(store, { error: 'الإشعارات محظورة. اسمح بها من إعدادات الموقع في المتصفح.' }); return;
          }
          work = connect(); await work;
        } catch (error) { patchState(store, { error: error instanceof Error && error.message === 'vapid-mismatch'
          ? 'إعداد الإشعارات على هذا الجهاز لا يطابق إعداد الموقع. تواصل مع مدير النظام.'
          : 'تعذر تفعيل إشعارات الرسائل. حاول مجددًا.' }); }
        finally { patchState(store, { loading: false }); }
      },
      async disable(): Promise<void> {
        const recipient = permissions.me();
        ++version; stop?.(); stop = undefined;
        patchState(store, { loading: true, error: '' });
        try {
          await work.catch(() => {});
          const fid = read();
          if (fid) await remove(fid);
          clear(); patchState(store, { enabled: false });
          closeMessageNotifications(recipient);
        } catch { patchState(store, { error: 'تعذر إيقاف إشعارات الرسائل. حاول مجددًا.' }); }
        finally { patchState(store, { loading: false }); }
      },
      async logout(): Promise<void> {
        const recipient = permissions.me();
        ++version; stop?.(); stop = undefined;
        await work.catch(() => {});
        const fid = read();
        try { if (fid) await remove(fid); }
        finally {
          closeMessageNotifications(recipient);
          identity = ''; config = { enabled: false };
          patchState(store, { enabled: false, configured: false, loading: false, error: '' });
        }
      }
    };
  })
);
