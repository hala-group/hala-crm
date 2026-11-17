import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PermissionsStore } from '../../core/permissions.store';

@Component({
  selector: 'hala-home-dashboard',
  imports: [RouterLink],
  template: `
    <section class="dashboard" aria-labelledby="dashboard-title">
      <div>
        @if (permissions.me(); as me) {
          <h1>مرحبًا، {{ me.name }}</h1>
          <p>الدور: {{ me.role.name }}</p>
        }
        <h2 id="dashboard-title">ابدأ من هنا</h2>
        <p>اختر قسماً للمتابعة في Hala CRM.</p>
      </div>

      <div class="cards">
        @if (permissions.can('conversations:read') || permissions.can('conversations:read_all')) {
          <a class="card" routerLink="/inbox">
            <span class="icon-wrap" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z"/></svg></span>
            <strong>المحادثات</strong>
            <span>اعرض المحادثات والرسائل الواردة والصادرة.</span>
          </a>
        }
        @if (permissions.can('accounts:read')) {
          <a class="card" routerLink="/accounts">
            <span class="icon-wrap" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M11 18h2"/></svg></span>
            <strong>أرقام واتساب</strong>
            <span>تابع حالة الأرقام وإعدادات الوصول إليها.</span>
          </a>
        }
        @if (permissions.can('calls:read')) {
          <a class="card" routerLink="/calls">
            <span class="icon-wrap" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.96.35 1.9.69 2.8a2 2 0 0 1-.45 2.11L8.08 9.92a16 16 0 0 0 6 6l1.29-1.27a2 2 0 0 1 2.11-.45c.9.34 1.84.57 2.8.69A2 2 0 0 1 22 16.92Z"/></svg></span>
            <strong>المكالمات</strong>
            <span>راجع سجل المكالمات الواردة والفائتة.</span>
          </a>
        }
        @if (permissions.can('users:read')) {
          <a class="card" routerLink="/users">
            <span class="icon-wrap" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
            <strong>المستخدمون</strong>
            <span>أدر مستخدمي الشركة ودعواتهم.</span>
          </a>
        }
        @if (permissions.can('roles:read')) {
          <a class="card" routerLink="/roles">
            <span class="icon-wrap" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><path d="M12 15v3"/></svg></span>
            <strong>الأدوار والصلاحيات</strong>
            <span>راجع أدوار المستخدمين وصلاحياتهم.</span>
          </a>
        }
        @if (permissions.can('audit:read')) {
          <a class="card" routerLink="/audit">
            <span class="icon-wrap" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="18" rx="2"/><path d="M9 4V2h6v2M8 10h8M8 14h8M8 18h5"/></svg></span>
            <strong>سجل التدقيق</strong>
            <span>راجع سجل العمليات الحساسة.</span>
          </a>
        }
      </div>
    </section>
  `,
  styles: [`
    .dashboard { display: grid; gap: 1.25rem; }
    h2 { margin: 0 0 .35rem; }
    p { margin: 0; color: #557069; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: 1rem; }
    .card { display: grid; align-content: start; gap: .65rem; min-height: 10rem; padding: 1.25rem; border: 1px solid #d7e5df; border-radius: 1rem; background: white; color: #19342e; text-decoration: none; box-shadow: 0 8px 28px #123e3508; transition: transform .15s ease, box-shadow .15s ease; }
    .card:hover, .card:focus-visible { transform: translateY(-2px); box-shadow: 0 10px 28px #123e3518; }
    .icon-wrap { display: grid; place-items: center; width: 2.75rem; height: 2.75rem; border-radius: .75rem; background: #edf6f2; color: #16715d; }
    .icon { width: 1.5rem; height: 1.5rem; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HomeDashboardComponent {
  readonly permissions = inject(PermissionsStore);
}
