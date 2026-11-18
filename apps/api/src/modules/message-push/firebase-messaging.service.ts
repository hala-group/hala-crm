import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type FidMulticastMessage, type Messaging } from 'firebase-admin/messaging';
import { type MessagePushConfig } from '@hala/shared';

interface EncodedServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

@Injectable()
export class FirebaseMessagingService {
  private readonly messaging?: Messaging;
  private readonly webConfig: MessagePushConfig;

  constructor() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const apiKey = process.env.FIREBASE_WEB_API_KEY;
    const authDomain = process.env.FIREBASE_AUTH_DOMAIN;
    const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID;
    const appId = process.env.FIREBASE_APP_ID;
    const vapidKey = process.env.FIREBASE_VAPID_KEY;
    const accountBase64 = process.env.FIREBASE_ADMIN_SERVICE_ACCOUNT_BASE64;

    if (!projectId || !apiKey || !authDomain || !messagingSenderId || !appId || !vapidKey || !accountBase64) {
      this.webConfig = { enabled: false };
      return;
    }

    const account = JSON.parse(Buffer.from(accountBase64, 'base64').toString('utf8')) as EncodedServiceAccount;
    const appName = 'hala-message-push';
    const app = getApps().find(candidate => candidate.name === appName) ?? initializeApp({
      projectId,
      credential: cert({ projectId: account.project_id, clientEmail: account.client_email,
        privateKey: account.private_key.replace(/\\n/g, '\n') })
    }, appName);
    this.messaging = getMessaging(app);
    this.webConfig = {
      enabled: true,
      config: { apiKey, authDomain, projectId, messagingSenderId, appId },
      vapidKey
    };
  }

  config(): MessagePushConfig { return this.webConfig; }

  isConfigured(): boolean { return Boolean(this.messaging); }

  sendEachForMulticast(message: FidMulticastMessage) {
    if (!this.messaging) throw new ServiceUnavailableException('Firebase message push is not configured');
    return this.messaging.sendEachForMulticast(message);
  }
}
