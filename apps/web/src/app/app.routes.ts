import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { permissionGuard } from './core/permission.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/auth/login.component').then(m => m.LoginComponent) },
  { path: 'accept-invite', loadComponent: () => import('./features/auth/accept-invite.component').then(m => m.AcceptInviteComponent) },
  {
    path: '', canActivate: [authGuard], loadComponent: () => import('./layout/home.component').then(m => m.HomeComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'inbox' },
      { path: 'dashboard', loadComponent: () => import('./features/home/home-dashboard.component').then(m => m.HomeDashboardComponent) },
      { path: 'inbox', canActivate: [permissionGuard('conversations:read')], loadComponent: () => import('./features/inbox/inbox.component').then(m => m.InboxComponent) },
      { path: 'inbox/:conversationId', canActivate: [permissionGuard('conversations:read')], loadComponent: () => import('./features/inbox/inbox.component').then(m => m.InboxComponent) },
      { path: 'calls', canActivate: [permissionGuard('calls:read')], loadComponent: () => import('./features/calls/calls.component').then(m => m.CallsComponent) },
      { path: 'accounts', canActivate: [permissionGuard('accounts:create')], loadComponent: () => import('./features/accounts/accounts.component').then(m => m.AccountsComponent) },
      { path: 'users', canActivate: [permissionGuard('users:read')], loadComponent: () => import('./features/users/users.component').then(m => m.UsersComponent) },
      { path: 'roles', canActivate: [permissionGuard('roles:read')], loadComponent: () => import('./features/roles/roles.component').then(m => m.RolesComponent) },
      { path: 'audit', canActivate: [permissionGuard('audit:read')], loadComponent: () => import('./features/audit/audit.component').then(m => m.AuditComponent) },
      { path: 'profile', loadComponent: () => import('./features/profile/profile.component').then(m => m.ProfileComponent) }
    ]
  },
  { path: '**', redirectTo: '' }
];
