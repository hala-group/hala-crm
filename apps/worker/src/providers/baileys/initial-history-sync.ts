/** Keeps the first-pair history request alive across Baileys' QR handshake restart. */
export class InitialHistorySync {
  private readonly pendingUntil = new Map<string, number>();
  /** Accounts that just completed first QR scan and need a reconnect to receive history. */
  private readonly needsReconnect = new Set<string>();
  private static readonly WINDOW_MS = 15 * 60_000;

  useFullHistory(accountId: string, hasSavedIdentity: boolean, now = Date.now()): boolean {
    if (!hasSavedIdentity) this.pendingUntil.set(accountId, now + InitialHistorySync.WINDOW_MS);
    const expiresAt = this.pendingUntil.get(accountId);
    if (expiresAt !== undefined && expiresAt > now) return true;
    this.pendingUntil.delete(accountId);
    return false;
  }

  historyReceived(accountId: string, count: number): void {
    if (count > 0) {
      this.pendingUntil.delete(accountId);
      this.needsReconnect.delete(accountId);
    }
  }

  /**
   * Called after `connection === 'open'` on a fresh QR pairing.
   * Marks the account as needing a reconnect so that creds.me.lid is populated
   * when the next connection attempt receives the HISTORY_SYNC_NOTIFICATION.
   */
  markNeedsReconnect(accountId: string): void {
    this.needsReconnect.add(accountId);
  }

  /**
   * Returns true if the account needs to reconnect to receive history.
   * Clears the flag after reading so it only triggers once.
   */
  consumeNeedsReconnect(accountId: string): boolean {
    const needs = this.needsReconnect.has(accountId);
    this.needsReconnect.delete(accountId);
    return needs;
  }

  clear(accountId: string): void {
    this.pendingUntil.delete(accountId);
    this.needsReconnect.delete(accountId);
  }
}
