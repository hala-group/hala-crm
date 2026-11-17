export interface CallEvent {
  callId: string;
  accountId: string;
  isVideo: boolean;
}

export interface CallAlert extends CallEvent {
  id: string;
  kind: 'incoming' | 'missed';
  title: string;
  body: string;
}

export function callAlert(event: CallEvent, kind: CallAlert['kind']): CallAlert {
  return {
    ...event,
    id: `${kind}:${event.callId}`,
    kind,
    title: kind === 'incoming' ? 'مكالمة واردة' : 'مكالمة فائتة',
    body: event.isVideo ? 'مكالمة فيديو عبر واتساب' : 'مكالمة صوتية عبر واتساب'
  };
}
