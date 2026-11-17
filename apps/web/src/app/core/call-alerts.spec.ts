import { describe, expect, it } from 'vitest';
import { callAlert } from './call-alerts';

describe('call alerts', () => {
  it('makes separate, clear alerts for incoming and missed calls', () => {
    const event = { callId: 'call-1', accountId: 'account-1', isVideo: true };
    const incoming = callAlert(event, 'incoming');
    const missed = callAlert(event, 'missed');
    expect(incoming).toMatchObject({ id: 'incoming:call-1', title: 'مكالمة واردة', body: 'مكالمة فيديو عبر واتساب' });
    expect(missed).toMatchObject({ id: 'missed:call-1', title: 'مكالمة فائتة' });
  });
});
