import { describe, expect, it, vi } from 'vitest';

vi.mock('./core/auth.guard', () => ({ authGuard: vi.fn() }));
vi.mock('./core/permission.guard', () => ({ permissionGuard: vi.fn(() => vi.fn()) }));

import { routes } from './app.routes';

describe('app routes', () => {
  it('opens the inbox at the root and keeps the dashboard at its own route', () => {
    const appShell = routes.find(route => route.path === '');
    const root = appShell?.children?.find(route => route.path === '' && route.pathMatch === 'full');

    expect(root?.redirectTo).toBe('inbox');
    expect(appShell?.children?.some(route => route.path === 'dashboard')).toBe(true);
  });
});
