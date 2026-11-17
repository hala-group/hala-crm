import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { signalStore, withMethods, withState, patchState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { type LoginInput } from '@hala/shared';
import { PermissionsStore } from './permissions.store';
import { type Me } from './models';
import { RealtimeService } from './realtime.service';
import { CallAlertsStore } from './call-alerts.store';

interface AuthResponse { accessToken: string; expiresIn: number }

export const AuthStore = signalStore(
  { providedIn: 'root' },
  withState<{ accessToken: string | null; loading: boolean }>({ accessToken: null, loading: false }),
  withMethods((store, http = inject(HttpClient), permissions = inject(PermissionsStore), router = inject(Router), realtime = inject(RealtimeService), callAlerts = inject(CallAlertsStore)) => {
    let restorePromise: Promise<boolean> | null = null;
    const loadMe = async (): Promise<void> => {
      const me = await firstValueFrom(http.get<Me>('/api/v1/me'));
      permissions.setCurrent(me);
    };
    const refresh = async (): Promise<string> => {
      try {
        const response = await firstValueFrom(http.post<AuthResponse>('/api/v1/auth/refresh', {}, { withCredentials: true }));
        patchState(store, { accessToken: response.accessToken });
        await loadMe();
        realtime.start(response.accessToken);
        void callAlerts.syncSubscription();
        return response.accessToken;
      } catch (error) {
        patchState(store, { accessToken: null });
        permissions.setCurrent(null);
        realtime.stop();
        throw error;
      }
    };
    return {
      refresh,
      async restore(): Promise<boolean> {
        if (store.accessToken()) return true;
        restorePromise ??= refresh().then(() => true, () => false).finally(() => { restorePromise = null; });
        return restorePromise;
      },
      async login(input: LoginInput): Promise<void> {
        patchState(store, { loading: true });
        try {
          const response = await firstValueFrom(http.post<AuthResponse>('/api/v1/auth/login', input, { withCredentials: true }));
          patchState(store, { accessToken: response.accessToken });
          await loadMe();
          realtime.start(response.accessToken);
          void callAlerts.syncSubscription();
          await router.navigateByUrl('/inbox');
        } finally { patchState(store, { loading: false }); }
      },
      async logout(): Promise<void> {
        try {
          await Promise.race([
            callAlerts.disableBrowserNotifications(),
            new Promise(resolve => setTimeout(resolve, 500))
          ]);
        } catch { /* Continue logout if browser push is unavailable. */ }

        try {
          await Promise.race([
            firstValueFrom(http.post('/api/v1/auth/logout', {}, { withCredentials: true })),
            new Promise(resolve => setTimeout(resolve, 800))
          ]);
        } catch { /* Continue logout even if network request fails. */ }
        finally {
          patchState(store, { accessToken: null });
          permissions.setCurrent(null);
          realtime.stop();
          callAlerts.clear();
          try {
            await router.navigateByUrl('/login');
          } catch {
            window.location.href = '/login';
          }
        }
      }
    };
  })
);
