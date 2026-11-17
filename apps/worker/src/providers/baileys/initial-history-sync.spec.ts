import { describe, expect, it } from 'vitest';
import { InitialHistorySync } from './initial-history-sync.js';

describe('first-pair history mode', () => {
  it('survives the QR restart but leaves established sessions alone', () => {
    const mode = new InitialHistorySync();
    // A stored identity takes precedence even if Baileys' registered flag is false.
    expect(mode.useFullHistory('old', true, 100)).toBe(false);
    expect(mode.useFullHistory('new', false, 100)).toBe(true);
    expect(mode.useFullHistory('new', true, 200)).toBe(true);
    expect(mode.useFullHistory('old', true, 200)).toBe(false);
    mode.historyReceived('new', 0);
    expect(mode.useFullHistory('new', true, 300)).toBe(true);
    mode.historyReceived('new', 12);
    expect(mode.useFullHistory('new', true, 400)).toBe(false);
  });

  it('expires an unanswered request and clears it on logout', () => {
    const mode = new InitialHistorySync();
    expect(mode.useFullHistory('a', false, 100)).toBe(true);
    expect(mode.useFullHistory('a', true, 100 + 15 * 60_000)).toBe(false);
    expect(mode.useFullHistory('b', false, 100)).toBe(true);
    mode.clear('b');
    expect(mode.useFullHistory('b', true, 200)).toBe(false);
  });
});
