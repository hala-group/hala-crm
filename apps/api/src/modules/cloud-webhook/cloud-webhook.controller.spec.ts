import { describe, expect, it } from 'vitest';
import { normalizeCloudMessage, type CloudMessage } from './cloud-webhook.controller.js';

const accountId = '507f1f77bcf86cd799439011';
const tenantId = '507f1f77bcf86cd799439012';

describe('Cloud API inbound normalization', () => {
  it('preserves interactive replies and Meta reply context', () => {
    const message: CloudMessage = { id: 'interactive-id', from: '201001234567', timestamp: '1794000000', type: 'interactive',
      context: { message_id: 'quoted-wa-id' },
      interactive: { type: 'list_reply', list_reply: { id: 'item-4', title: 'Option 4', description: 'Fourth option' } } };
    const normalized = normalizeCloudMessage(accountId, tenantId, message, [
      { wa_id: '201001234567', profile: { name: 'Customer' } }
    ]);
    expect(normalized).toMatchObject({ type: 'interactive', quotedWaMessageId: 'quoted-wa-id', text: 'Option 4', pushName: 'Customer',
      interactive: { kind: 'list_reply', selectedId: 'item-4', selectedTitle: 'Option 4', description: 'Fourth option' } });
  });

  it('distinguishes Ogg voice notes from ordinary audio and retains media references', () => {
    const normalized = normalizeCloudMessage(accountId, tenantId, { id: 'voice-id', from: '201001234567', timestamp: '1794000000',
      type: 'audio', audio: { id: 'cloud-media-id', mime_type: 'audio/ogg; codecs=opus' } });
    expect(normalized).toMatchObject({ type: 'voice', mediaSource: { kind: 'audio', mimeType: 'audio/ogg; codecs=opus',
      cloudMediaId: 'cloud-media-id' } });
  });

  it('normalizes legacy button responses and template metadata', () => {
    const button = normalizeCloudMessage(accountId, tenantId, { id: 'button-id', from: '201001234567', timestamp: '1794000000',
      type: 'button', button: { payload: 'yes', text: 'Yes' } });
    expect(button).toMatchObject({ type: 'interactive', text: 'Yes', interactive: { kind: 'button_reply', selectedId: 'yes' } });
    const template = normalizeCloudMessage(accountId, tenantId, { id: 'template-id', from: '201001234567', timestamp: '1794000000',
      type: 'template', template: { name: 'welcome', language: 'ar', components: [] } });
    expect(template.template).toMatchObject({ name: 'welcome', language: 'ar', componentsJson: '[]' });
  });
});
