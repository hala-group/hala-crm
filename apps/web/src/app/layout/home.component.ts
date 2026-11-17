import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthStore } from '../core/auth.store';
import { PermissionsStore } from '../core/permissions.store';
import { HasPermissionDirective } from '../shared/has-permission.directive';
import { CallAlertsStore } from '../core/call-alerts.store';

@Component({
  selector: 'hala-home',
  imports: [NgOptimizedImage, RouterLink, RouterLinkActive, RouterOutlet, HasPermissionDirective],
  template: `
    <div class="shell">
      <header>
        <a class="brand" routerLink="/" aria-label="Hala CRM">
          <img ngSrc="/assets/imgs/logo.webp" width="44" height="44" alt="" />
          <strong>Hala CRM</strong>
        </a>
        <nav>
          <a routerLink="/users" routerLinkActive="active" *halaHasPermission="'users:read'">المستخدمون</a>
          <a routerLink="/accounts" routerLinkActive="active" *halaHasPermission="'accounts:create'">الأرقام</a>
          @if (permissions.can('conversations:read') || permissions.can('conversations:read_all')) {
            <a routerLink="/inbox" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: false }">المحادثات</a>
          }
          <a routerLink="/calls" routerLinkActive="active" *halaHasPermission="'calls:read'">المكالمات</a>
        </nav>
        <div class="user-nav">
          <a routerLink="/profile" routerLinkActive="active" class="profile-link" title="الملف الشخصي وإعدادات الحساب">
            <span class="user-avatar">{{ userInitials() }}</span>
            <span class="user-name">{{ permissions.me()?.name }}</span>
            <span class="user-role-badge">{{ userRoleLabel() }}</span>
          </a>
          <button type="button" class="btn-logout" (click)="logout()" title="تسجيل الخروج">خروج</button>
        </div>
      </header>
      @if (callAlerts.pushError(); as error) { <p class="call-push-error" role="alert">{{ error }}</p> }
      <aside class="call-alerts" aria-live="polite" aria-label="تنبيهات المكالمات">
        @for (alert of callAlerts.alerts(); track alert.id) {
          <div class="call-alert" role="status">
            <strong>{{ alert.title }}</strong>
            <span>{{ alert.body }}</span>
            <a routerLink="/calls" (click)="callAlerts.dismiss(alert.id)">عرض المكالمات</a>
            <button type="button" (click)="callAlerts.dismiss(alert.id)" aria-label="إغلاق التنبيه">×</button>
          </div>
        }
      </aside>
      <main><router-outlet /></main>
    </div>
  `,
  styles: [`
    .shell { min-height: 100vh; }
    header { position: relative; z-index: 100; display: flex; align-items: center; gap: 2rem; padding: 0.85rem 2rem; color: white; background: #123e35; box-shadow: 0 2px 8px rgba(0,0,0,0.12); }
    .brand { display: inline-flex; align-items: center; gap: .65rem; color: inherit; text-decoration: none; white-space: nowrap; font-size: 1.15rem; }
    .brand img { width: 2.75rem; height: 2.75rem; border-radius: 50%; object-fit: cover; background: white; }
    nav { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
    nav a {
      color: #bbf7d0;
      text-decoration: none;
      padding: 0.45rem 1rem;
      border-radius: 9999px;
      font-weight: 500;
      font-size: 0.95rem;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      border: 1px solid transparent;
    }
    nav a:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.12);
    }
    nav a.active {
      color: #ffffff;
      background: #00a884;
      font-weight: 700;
      box-shadow: 0 2px 8px rgba(0, 168, 132, 0.45);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .user-nav { display: flex; align-items: center; gap: 0.75rem; }
    .profile-link { display: inline-flex; align-items: center; gap: 0.5rem; text-decoration: none; color: inherit; padding: 0.35rem 0.65rem; border-radius: 2rem; background: #1c5247; border: 1px solid #286d5e; transition: all 0.2s ease; }
    .profile-link:hover { background: #266b5c; }
    .profile-link.active { background: #00a884; border-color: rgba(255, 255, 255, 0.3); box-shadow: 0 2px 8px rgba(0, 168, 132, 0.35); }
    .user-avatar { width: 1.85rem; height: 1.85rem; border-radius: 50%; background: #00a884; color: white; display: flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: 700; flex-shrink: 0; }
    .user-name { font-size: 0.875rem; font-weight: 600; max-width: 8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .user-role-badge { font-size: 0.7rem; background: #0b7a5a; color: #a7f3d0; padding: 0.12rem 0.45rem; border-radius: 1rem; font-weight: 600; }
    .btn-logout { position: relative; z-index: 10; background: #1a4a40; border: 1px solid #286d5e; color: #e2e8f0; border-radius: 0.45rem; padding: 0.4rem 0.85rem; cursor: pointer; font-size: 0.85rem; font-weight: 500; transition: all 0.15s ease; }
    .btn-logout:hover { background: #c2410c; border-color: #ea580c; color: white; }
    .call-push-error { margin: .5rem 1rem; color: #a02626; }
    .call-alerts { position: fixed; z-index: 100; inset-block-start: 5.5rem; inset-inline-start: 1rem; display: grid; gap: .5rem; max-width: min(22rem, calc(100vw - 2rem)); }
    .call-alert { display: grid; grid-template-columns: 1fr auto; gap: .3rem .8rem; padding: .85rem 1rem; border: 1px solid #a8cbbb; border-radius: .7rem; background: #fff; color: #19342e; box-shadow: 0 8px 26px #123e352e; }
    .call-alert strong, .call-alert span { grid-column: 1; }
    .call-alert a { grid-column: 1; color: #0d765e; text-decoration: underline; }
    .call-alert button { grid-column: 2; grid-row: 1; align-self: start; min-width: 2rem; }
    main { width: 100%; max-width: none; box-sizing: border-box; margin: 0; padding: 1rem; }

    /* Responsive Header & Navigation */
    @media (max-width: 850px) {
      header {
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 0.65rem;
        padding: 0.75rem 1rem;
      }
      .brand {
        order: 1;
        font-size: 1.05rem;
        gap: 0.5rem;
      }
      .brand img {
        width: 2.25rem;
        height: 2.25rem;
      }
      .user-nav {
        order: 2;
        gap: 0.5rem;
      }
      nav {
        order: 3;
        flex: 0 0 100%;
        overflow-x: auto;
        padding-block: 0.25rem;
        white-space: nowrap;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      nav::-webkit-scrollbar {
        display: none;
      }
      nav a {
        padding: 0.35rem 0.75rem;
        font-size: 0.875rem;
      }
      main {
        padding: 0.75rem 0.5rem;
      }
    }
    @media (max-width: 600px) {
      .user-role-badge {
        display: none;
      }
      .user-name {
        max-width: 5.5rem;
      }
    }
    @media (max-width: 440px) {
      header {
        padding: 0.55rem 0.75rem;
      }
      .brand strong {
        font-size: 0.95rem;
      }
      .brand img {
        width: 2rem;
        height: 2rem;
      }
      .user-name {
        display: none;
      }
      .profile-link {
        padding: 0.2rem;
        border-radius: 50%;
      }
      .btn-logout {
        padding: 0.3rem 0.6rem;
        font-size: 0.8rem;
      }
      main {
        padding: 0.5rem 0.25rem;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomeComponent {
  readonly auth = inject(AuthStore);
  readonly permissions = inject(PermissionsStore);
  readonly callAlerts = inject(CallAlertsStore);

  readonly userInitials = computed(() => {
    const name = this.permissions.me()?.name;
    if (!name) return '؟';
    const parts = name.trim().split(/\s+/);
    const first = parts[0];
    const second = parts[1];
    if (first && second) return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  });

  readonly userRoleLabel = computed(() => {
    const role = this.permissions.me()?.role?.name?.toLowerCase();
    switch (role) {
      case 'owner': return 'مالك';
      case 'admin': return 'مدير';
      case 'agent': return 'موظف';
      default: return role ?? 'مستخدم';
    }
  });

  async logout(): Promise<void> {
    try {
      await this.auth.logout();
    } catch {
      window.location.href = '/login';
    }
  }
}
