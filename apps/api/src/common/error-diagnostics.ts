/** Keep diagnostic codes and source locations, excluding messages, payloads and URLs. */
export function errorDiagnostics(error: unknown): { name: string; code?: string; frames?: string[] } {
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  const name = /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'Error';
  const code = /^(?:HOSTINGER_STORAGE_DELETE_\d{3}|E[A-Z_]+|Invalid storage key)$/.test(error.message)
    ? error.message : undefined;
  const frames = error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 8)
    .map(line => line.replace(/https?:\/\/[^\s)]+/g, '[url]'));
  return { name, code, frames };
}
