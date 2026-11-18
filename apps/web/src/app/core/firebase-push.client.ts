import { Injectable } from '@angular/core';
import { type MessagePushConfig } from '@hala/shared';

type EnabledConfig = Extract<MessagePushConfig, { enabled: true }>;

@Injectable({ providedIn: 'root' })
export class FirebasePushClient {
  supported(): boolean {
    return typeof window !== 'undefined' && window.isSecureContext &&
      'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  }

  permission(): NotificationPermission { return this.supported() ? Notification.permission : 'denied'; }
  requestPermission(): Promise<NotificationPermission> { return Notification.requestPermission(); }

  async connect(config: EnabledConfig, onRegistered: (fid: string) => void): Promise<() => void> {
    const [appSdk, messagingSdk] = await Promise.all([import('firebase/app'), import('firebase/messaging')]);
    if (!await messagingSdk.isSupported()) throw new Error('unsupported');
    // The registration is created by Angular. Never replace it with Firebase's default worker.
    const registration = await this.deadline(navigator.serviceWorker.ready);
    const subscription = await registration.pushManager.getSubscription();
    const existingKey = subscription?.options.applicationServerKey;
    if (existingKey) {
      const expected = Uint8Array.from(atob(config.vapidKey.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
      const actual = new Uint8Array(existingKey);
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error('vapid-mismatch');
      }
    }
    const appName = `hala-push-${config.config.projectId}`;
    const app = appSdk.getApps().find(candidate => candidate.name === appName) ?? appSdk.initializeApp(config.config, appName);
    const messaging = messagingSdk.getMessaging(app);
    let confirmRegistration!: () => void;
    const confirmed = new Promise<void>(resolve => { confirmRegistration = resolve; });
    const stop = messagingSdk.onRegistered(messaging, fid => { onRegistered(fid); confirmRegistration(); });
    try {
      await this.deadline(Promise.all([
        messagingSdk.register(messaging, { vapidKey: config.vapidKey, serviceWorkerRegistration: registration }), confirmed
      ]));
      return stop;
    } catch (error) { stop(); throw error; }
  }

  private async deadline<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('push-timeout')), 15_000);
      })]);
    } finally { clearTimeout(timer); }
  }
}
