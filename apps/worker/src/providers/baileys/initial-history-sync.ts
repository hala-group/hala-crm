/** Keeps the first-pair history request alive across Baileys' QR handshake restart. */
export class InitialHistorySync {
  private readonly pendingUntil = new Map<string, number>();
  private static readonly WINDOW_MS = 15 * 60_000;

  useFullHistory(accountId: string, hasSavedIdentity: boolean, now = Date.now()): boolean {
    if (!hasSavedIdentity) this.pendingUntil.set(accountId, now + InitialHistorySync.WINDOW_MS);
    const expiresAt = this.pendingUntil.get(accountId);
    if (expiresAt !== undefined && expiresAt > now) return true;
    this.pendingUntil.delete(accountId);
    return false;
  }

  historyReceived(accountId: string, count: number): void {
    if (count > 0) this.pendingUntil.delete(accountId);
  }

  clear(accountId: string): void { this.pendingUntil.delete(accountId); }
}
