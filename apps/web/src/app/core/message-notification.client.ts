/** Close only this signed-in recipient's notifications in the existing registration. */
export function closeMessageNotifications(me: { id: string; tenantId: string } | null, conversationId?: string, accountId?: string): void {
  if (!me || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    navigator.serviceWorker.controller?.postMessage({ type: 'HALA_CLOSE_MESSAGE_NOTIFICATIONS',
      tenantId: me.tenantId, recipientId: me.id, ...(conversationId ? { conversationId } : {}), ...(accountId ? { accountId } : {}) });
  } catch { /* A terminating worker must not interfere with reading or ending a session. */ }
}
