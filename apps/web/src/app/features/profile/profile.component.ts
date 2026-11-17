import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormField, form } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { PermissionsStore } from '../../core/permissions.store';
import { AccountsStore } from '../accounts/accounts.store';

@Component({
  selector: 'hala-profile',
  imports: [FormField],
  template: `
    <section class="profile-dashboard">
      <header class="profile-header">
        <div class="header-icon">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
          </svg>
        </div>
        <div class="header-text">
          <h1>الملف الشخصي وإعدادات الحساب</h1>
          <p>عرض تفاصيل حسابك الحالي، الصلاحيات والأرقام المخصصة لك، وتغيير كلمة المرور</p>
        </div>
      </header>

      @if (successMessage()) {
        <div class="alert-success" role="status">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>{{ successMessage() }}</span>
        </div>
      }

      @if (errorMessage()) {
        <div class="alert-error" role="alert">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>{{ errorMessage() }}</span>
        </div>
      }

      <div class="profile-grid">
        <!-- Account Info Card -->
        <div class="card info-card">
          <div class="card-header">
            <h2>بيانات الحساب</h2>
          </div>
          <div class="card-body">
            <div class="user-hero">
              <div class="hero-avatar">
                {{ userInitials() }}
              </div>
              <div class="hero-details">
                <h3>{{ user()?.name || 'مستخدم' }}</h3>
                <span class="hero-email" dir="ltr">{{ user()?.email }}</span>
                <div class="badge-role" [class.admin]="isAdmin()" [class.agent]="isAgent()">
                  {{ roleLabel() }}
                </div>
              </div>
            </div>

            <div class="info-list">
              <div class="info-row">
                <span class="info-label">معرّف المستخدم</span>
                <code class="info-code">{{ user()?.id }}</code>
              </div>
              <div class="info-row">
                <span class="info-label">حالة الحساب</span>
                <span class="status-active">
                  <span class="dot"></span>
                  نشط
                </span>
              </div>
              <div class="info-row assigned-numbers-row">
                <span class="info-label">الأرقام المخصصة</span>
                <div class="numbers-list">
                  @if (isAdmin()) {
                    <span class="number-tag all-tag">
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                      كامل أرقام النظام (صلاحية مدير)
                    </span>
                  } @else if (assignedAccounts().length > 0) {
                    @for (acc of assignedAccounts(); track acc._id) {
                      <span class="number-tag">
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                        <strong>{{ acc.label || 'واتساب' }}</strong>
                        <small dir="ltr">{{ acc.phoneNumber || acc._id }}</small>
                      </span>
                    }
                  } @else {
                    <span class="no-numbers">لم يتم تعيين أرقام لهذا الحساب بعد</span>
                  }
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Change Password Card -->
        <div class="card password-card">
          <div class="card-header">
            <h2>تغيير كلمة المرور</h2>
          </div>
          <div class="card-body">
            <p class="section-desc">لتأمين حسابك، يُرجى إدخال كلمة المرور الحالية ثم كتابة كلمة المرور الجديدة وتأكيدها.</p>

            <form class="password-form" (submit)="changePassword($event)">
              <div class="form-field">
                <label for="current-pwd">كلمة المرور الحالية</label>
                <input
                  id="current-pwd"
                  type="password"
                  placeholder="أدخل كلمة المرور الحالية"
                  autocomplete="current-password"
                  [formField]="fields.currentPassword"
                />
              </div>

              <div class="form-field">
                <label for="new-pwd">كلمة المرور الجديدة</label>
                <input
                  id="new-pwd"
                  type="password"
                  placeholder="كلمة مرور جديدة (6 خانات على الأقل)"
                  autocomplete="new-password"
                  [formField]="fields.newPassword"
                />
              </div>

              <div class="form-field">
                <label for="confirm-pwd">تأكيد كلمة المرور الجديدة</label>
                <input
                  id="confirm-pwd"
                  type="password"
                  placeholder="أعد إدخال كلمة المرور الجديدة"
                  autocomplete="new-password"
                  [formField]="fields.confirmPassword"
                />
              </div>

              <div class="form-action">
                <button type="submit" class="btn-submit" [disabled]="loading()">
                  @if (loading()) {
                    <span class="spinner" aria-hidden="true"></span>
                    <span>جارٍ الحفظ…</span>
                  } @else {
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    <span>تحديث كلمة المرور</span>
                  }
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
    }

    .profile-dashboard {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      max-width: 72rem;
      margin-inline: auto;
      padding: 0.5rem 0.25rem 2.5rem;
    }

    .profile-header {
      display: flex;
      align-items: center;
      gap: 1.25rem;
      background: #ffffff;
      border: 1px solid #e1ebe5;
      border-radius: 1rem;
      padding: 1.25rem 1.75rem;
      box-shadow: 0 2px 8px rgba(18, 62, 53, 0.04);
    }
    .header-icon {
      display: grid;
      place-items: center;
      width: 3rem;
      height: 3rem;
      border-radius: 50%;
      background: #e7f7ef;
      color: #008069;
      flex-shrink: 0;
    }
    .header-icon svg { width: 1.5rem; height: 1.5rem; }
    .header-text h1 {
      margin: 0;
      color: #123e35;
      font-size: 1.45rem;
      font-weight: 700;
    }
    .header-text p {
      margin: 0.25rem 0 0;
      color: #54656f;
      font-size: 0.85rem;
    }

    .alert-success {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0.85rem 1.25rem;
      border-radius: 0.65rem;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      color: #166534;
      font-size: 0.9rem;
      font-weight: 600;
    }
    .alert-success svg { width: 1.25rem; height: 1.25rem; color: #16a34a; flex-shrink: 0; }

    .alert-error {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      padding: 0.85rem 1.25rem;
      border-radius: 0.65rem;
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #991b1b;
      font-size: 0.875rem;
      font-weight: 500;
    }
    .alert-error svg { width: 1.2rem; height: 1.2rem; color: #dc2626; flex-shrink: 0; }

    .profile-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      align-items: start;
    }

    .card {
      background: #ffffff;
      border: 1px solid #e1ebe5;
      border-radius: 1rem;
      box-shadow: 0 4px 16px rgba(18, 62, 53, 0.05);
      overflow: hidden;
    }
    .card-header {
      padding: 1.15rem 1.5rem;
      border-block-end: 1px solid #f0f4f2;
      background: #fcfdfc;
    }
    .card-header h2 {
      margin: 0;
      font-size: 1.1rem;
      font-weight: 700;
      color: #123e35;
    }
    .card-body {
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    /* User Hero */
    .user-hero {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding-block-end: 1.25rem;
      border-block-end: 1px solid #f0f4f2;
    }
    .hero-avatar {
      display: grid;
      place-items: center;
      width: 3.5rem;
      height: 3.5rem;
      border-radius: 50%;
      background: #008069;
      color: #ffffff;
      font-size: 1.25rem;
      font-weight: 700;
      flex-shrink: 0;
      box-shadow: 0 2px 8px rgba(0, 128, 105, 0.25);
    }
    .hero-details h3 {
      margin: 0;
      font-size: 1.15rem;
      font-weight: 700;
      color: #111b21;
    }
    .hero-email {
      display: block;
      margin: 0.15rem 0 0.45rem;
      font-size: 0.85rem;
      color: #54656f;
    }
    .badge-role {
      display: inline-flex;
      padding: 0.2rem 0.65rem;
      border-radius: 1rem;
      font-size: 0.775rem;
      font-weight: 700;
      background: #e0f2fe;
      color: #0284c7;
    }
    .badge-role.admin {
      background: #fef3c7;
      color: #92400e;
    }
    .badge-role.agent {
      background: #e7f7ef;
      color: #008069;
    }

    /* Info List */
    .info-list {
      display: flex;
      flex-direction: column;
      gap: 0.9rem;
    }
    .info-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding-block: 0.35rem;
      font-size: 0.875rem;
    }
    .info-label {
      color: #54656f;
      font-weight: 500;
    }
    .info-code {
      font-family: monospace;
      font-size: 0.825rem;
      background: #f4f6f5;
      padding: 0.2rem 0.5rem;
      border-radius: 0.35rem;
      color: #123e35;
      word-break: break-all;
    }
    .status-active {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      color: #0d765e;
      font-weight: 600;
    }
    .status-active .dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: #00a884;
    }

    /* Assigned Numbers */
    .assigned-numbers-row {
      flex-direction: column;
      align-items: stretch;
      gap: 0.5rem;
      margin-top: 0.35rem;
    }
    .numbers-list {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }
    .number-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.75rem;
      border-radius: 0.5rem;
      background: #f5f8f6;
      border: 1px solid #dce8e2;
      font-size: 0.825rem;
      color: #19342e;
    }
    .number-tag svg { width: 0.95rem; height: 0.95rem; color: #008069; flex-shrink: 0; }
    .number-tag.all-tag {
      background: #edf8f3;
      border-color: #b7e4d0;
      color: #0f765e;
      font-weight: 600;
    }
    .number-tag.all-tag svg { color: #0f765e; }
    .no-numbers {
      font-size: 0.825rem;
      color: #8696a0;
      font-style: italic;
    }

    /* Password Form */
    .section-desc {
      margin: 0;
      font-size: 0.85rem;
      color: #667781;
      line-height: 1.45;
    }
    .password-form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
    }
    .form-field label {
      font-size: 0.85rem;
      font-weight: 600;
      color: #2b443c;
    }
    .form-field input {
      height: 2.75rem;
      padding: 0.55rem 0.85rem;
      border: 1px solid #c8d9cf;
      border-radius: 0.6rem;
      background: #ffffff;
      color: #111b21;
      font-size: 0.9rem;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .form-field input:focus-visible {
      outline: none;
      border-color: #008069;
      box-shadow: 0 0 0 3px rgba(0, 128, 105, 0.15);
    }
    .form-action {
      margin-top: 0.5rem;
    }
    .btn-submit {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      width: 100%;
      height: 2.75rem;
      border: 0;
      border-radius: 0.6rem;
      background: #008069;
      color: #ffffff;
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease, transform 0.05s ease;
    }
    .btn-submit:hover:not(:disabled) {
      background: #006b5b;
    }
    .btn-submit:active:not(:disabled) {
      transform: scale(0.99);
    }
    .btn-submit:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    .btn-submit svg { width: 1.15rem; height: 1.15rem; }
    .spinner {
      width: 1rem;
      height: 1rem;
      border: 2px solid #ffffff60;
      border-top-color: #ffffff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 800px) {
      .profile-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 600px) {
      .profile-header {
        padding: 1rem;
        gap: 0.85rem;
      }
      .header-icon {
        width: 2.5rem;
        height: 2.5rem;
      }
      .header-icon svg {
        width: 1.25rem;
        height: 1.25rem;
      }
      .header-text h1 {
        font-size: 1.2rem;
      }
      .card-body {
        padding: 1rem;
      }
    }
    @media (max-width: 450px) {
      .user-hero {
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 0.75rem;
      }
      .badge-role {
        align-self: center;
      }
      .info-row {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.35rem;
      }
      .info-code {
        width: 100%;
        box-sizing: border-box;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ProfileComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly permissions = inject(PermissionsStore);
  readonly accounts = inject(AccountsStore);

  readonly user = computed(() => this.permissions.me());
  readonly loading = signal(false);
  readonly successMessage = signal('');
  readonly errorMessage = signal('');

  readonly passwordDraft = signal({ currentPassword: '', newPassword: '', confirmPassword: '' });
  readonly fields = form(this.passwordDraft);

  readonly isAdmin = computed(() => {
    const role = this.user()?.role;
    return role?.key === 'admin' || role?.key === 'owner' || (role?.name && ['admin', 'owner', 'مدير'].includes(role.name.toLowerCase()));
  });

  readonly isAgent = computed(() => {
    const role = this.user()?.role;
    return role?.key === 'agent' || (role?.name && ['agent', 'وكيل'].includes(role.name.toLowerCase()));
  });

  readonly roleLabel = computed(() => {
    if (this.isAdmin()) return 'مدير النظام (Admin)';
    if (this.isAgent()) return 'وكيل / خدمة عملاء (Agent)';
    return this.user()?.role?.name || 'مستخدم';
  });

  readonly assignedAccounts = computed(() => {
    const memberships = this.user()?.accountMemberships ?? [];
    const all = this.accounts.accounts();
    if (this.isAdmin()) return all;
    return all.filter(acc => memberships.some(m => m.accountId === acc._id));
  });

  ngOnInit(): void {
    void this.accounts.load().catch(() => {});
  }

  userInitials(): string {
    const name = this.user()?.name;
    if (!name) return '؟';
    const parts = name.trim().split(/\s+/);
    const first = parts[0];
    const second = parts[1];
    if (first && second) return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  async changePassword(event: Event): Promise<void> {
    event.preventDefault();
    this.errorMessage.set('');
    this.successMessage.set('');

    const { currentPassword, newPassword, confirmPassword } = this.passwordDraft();
    if (!currentPassword) {
      this.errorMessage.set('يُرجى إدخال كلمة المرور الحالية.');
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      this.errorMessage.set('يجب ألا تقل كلمة المرور الجديدة عن 6 خانات.');
      return;
    }
    if (newPassword !== confirmPassword) {
      this.errorMessage.set('كلمة المرور الجديدة وتأكيدها غير متطابقين.');
      return;
    }

    this.loading.set(true);
    try {
      await firstValueFrom(
        this.http.post('/api/v1/auth/change-password', { currentPassword, newPassword })
      );
      this.successMessage.set('تم تحديث كلمة المرور بنجاح!');
      this.passwordDraft.set({ currentPassword: '', newPassword: '', confirmPassword: '' });
    } catch (err: unknown) {
      const errorMsg = (err as { error?: { message?: string } })?.error?.message;
      this.errorMessage.set(errorMsg || 'تعذر تحديث كلمة المرور. تحقق من كلمة المرور الحالية.');
    } finally {
      this.loading.set(false);
    }
  }
}
