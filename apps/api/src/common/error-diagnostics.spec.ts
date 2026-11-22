import { describe, expect, it } from 'vitest';
import { errorDiagnostics } from './error-diagnostics.js';

describe('safe error diagnostics', () => {
  it('keeps storage failure codes and stack locations without exposing exception messages or URLs', () => {
    const error = new Error('customer content and credentials');
    error.stack = 'Error: customer content and credentials\n    at handler (file:///app/service.js:2:1)\n    at fetch (https://private.invalid/file?token=secret:3:1)';
    const diagnostics = JSON.stringify(errorDiagnostics(error));
    expect(diagnostics).toContain('service.js:2:1');
    expect(diagnostics).not.toContain('credentials');
    expect(diagnostics).not.toContain('secret');
    expect(errorDiagnostics(new Error('HOSTINGER_STORAGE_DELETE_503')).code).toBe('HOSTINGER_STORAGE_DELETE_503');
  });
});
