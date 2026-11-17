import { inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { SwPush } from '@angular/service-worker';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import { callAlert, type CallAlert, type CallEvent } from './call-alerts';

export const CallAlertsStore = signalStore(
  { providedIn: 'root' },
  withState<{ alerts: CallAlert[]; publicKey: string; pushEnabled: boolean; pushLoading: boolean; pushError: string | null; soundEnabled: boolean }>({
    alerts: [], publicKey: '', pushEnabled: false, pushLoading: false, pushError: null, soundEnabled: true
  }),
  withMethods((store, http = inject(HttpClient), swPush = inject(SwPush)) => {
    let audio: AudioContext | undefined;
    let ringTimer: ReturnType<typeof setInterval> | undefined;
    let ringTimeout: ReturnType<typeof setTimeout> | undefined;

    const ensureAudio = (): AudioContext | undefined => {
      if (!audio && typeof window !== 'undefined') {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          try { audio = new AudioCtx(); } catch {}
        }
      }
      return audio;
    };

    if (typeof window !== 'undefined') {
      const unlockAudio = (): void => {
        const ctx = ensureAudio();
        if (ctx && ctx.state === 'suspended') {
          void ctx.resume();
        }
      };
      window.addEventListener('click', unlockAudio, { passive: true });
      window.addEventListener('keydown', unlockAudio, { passive: true });
      window.addEventListener('touchstart', unlockAudio, { passive: true });
    }

    const stopRing = (): void => {
      if (ringTimer) clearInterval(ringTimer);
      if (ringTimeout) clearTimeout(ringTimeout);
      ringTimer = undefined; ringTimeout = undefined;
    };
    const ring = (): void => {
      if (!store.soundEnabled()) return;
      const ctx = ensureAudio();
      if (!ctx) return;
      stopRing();
      const pulse = (): void => {
        if (!audio || audio.state !== 'running') return;
        for (const [frequency, offset] of [[660, 0], [880, .32]] as const) {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = 'sine'; oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(.0001, audio.currentTime + offset);
          gain.gain.exponentialRampToValueAtTime(.12, audio.currentTime + offset + .02);
          gain.gain.exponentialRampToValueAtTime(.0001, audio.currentTime + offset + .25);
          oscillator.connect(gain).connect(audio.destination);
          oscillator.start(audio.currentTime + offset);
          oscillator.stop(audio.currentTime + offset + .26);
        }
      };
      void ctx.resume().then(pulse).catch(() => {});
      ringTimer = setInterval(pulse, 1800);
      ringTimeout = setTimeout(stopRing, 20_000);
    };
    return {
    async enableSound(): Promise<void> {
      const ctx = ensureAudio();
      if (ctx) await ctx.resume();
      patchState(store, { soundEnabled: true });
    },
    disableSound(): void { stopRing(); patchState(store, { soundEnabled: false }); },
    pushAvailable(): boolean { return swPush.isEnabled; },
    receive(event: CallEvent, kind: CallAlert['kind']): void {
      const alert = callAlert(event, kind);
      if (store.alerts().some(current => current.id === alert.id)) return;
      patchState(store, { alerts: [...store.alerts(), alert].slice(-4) });
      if (kind === 'incoming') ring();
      else stopRing();

      if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
        try {
          new Notification(alert.title, {
            body: alert.body,
            icon: '/assets/imgs/logo.webp',
            tag: alert.id,
          });
        } catch {}
      }

      setTimeout(() => patchState(store, { alerts: store.alerts().filter(current => current.id !== alert.id) }), 15_000);
    },
    dismiss(id: string): void { patchState(store, { alerts: store.alerts().filter(alert => alert.id !== id) }); },
    clear(): void { stopRing(); patchState(store, { alerts: [] }); },
    async syncSubscription(): Promise<void> {
      ensureAudio();

      if (typeof window !== 'undefined' && 'Notification' in window) {
        if (Notification.permission === 'default') {
          try { await Notification.requestPermission(); } catch {}
        }
      }

      if (!swPush.isEnabled) return;
      try {
        const { publicKey } = await firstValueFrom(http.get<{ publicKey: string }>('/api/v1/calls/push-key'));
        patchState(store, { publicKey });
        let subscription = await Promise.race([
          firstValueFrom(swPush.subscription),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 1000))
        ]);
        if (!subscription && typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
          try {
            subscription = await swPush.requestSubscription({ serverPublicKey: publicKey });
          } catch {}
        }
        if (!subscription) { patchState(store, { pushEnabled: false }); return; }
        await firstValueFrom(http.post('/api/v1/calls/subscriptions', subscription.toJSON()));
        patchState(store, { pushEnabled: true, pushError: null });
      } catch { patchState(store, { pushEnabled: false }); }
    },
    async enableBrowserNotifications(): Promise<void> {
      if (!swPush.isEnabled) { patchState(store, { pushError: 'تنبيهات المتصفح غير مدعومة هنا.' }); return; }
      const publicKey = store.publicKey();
      if (!publicKey) { patchState(store, { pushError: 'مفتاح تنبيهات المكالمات غير متاح.' }); return; }
      patchState(store, { pushLoading: true, pushError: null });
      try {
        const subscription = await swPush.requestSubscription({ serverPublicKey: publicKey });
        await firstValueFrom(http.post('/api/v1/calls/subscriptions', subscription.toJSON()));
        patchState(store, { pushEnabled: true });
      } catch { patchState(store, { pushError: 'تعذر تفعيل تنبيهات المكالمات. تحقق من إذن المتصفح وحاول مجددًا.' }); }
      finally { patchState(store, { pushLoading: false }); }
    },
    async disableBrowserNotifications(): Promise<void> {
      if (!swPush.isEnabled) return;
      try {
        const subscription = await Promise.race([
          firstValueFrom(swPush.subscription),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 800))
        ]);
        if (subscription) {
          try {
            await Promise.race([
              firstValueFrom(http.request('DELETE', '/api/v1/calls/subscriptions', { body: { endpoint: subscription.endpoint } })),
              new Promise(resolve => setTimeout(resolve, 800))
            ]);
          } catch { /* An expired subscription will be removed after the next push attempt. */ }
          try { await swPush.unsubscribe(); } catch {}
        }
        patchState(store, { pushEnabled: false });
      } catch { patchState(store, { pushError: 'تعذر إيقاف تنبيهات المتصفح. حاول مجددًا.' }); }
    }
  }; })
);
