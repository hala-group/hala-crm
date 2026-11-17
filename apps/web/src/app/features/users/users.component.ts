import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { createUserSchema } from '@hala/shared';
import { RolesStore } from '../roles/roles.store';
import { UsersStore } from './users.store';
import { HasPermissionDirective } from '../../shared/has-permission.directive';
import { PermissionsStore } from '../../core/permissions.store';

@Component({
  selector: 'hala-users',
  imports: [FormField, HasPermissionDirective],
  template: `
    <section class="users-dashboard">
      <!-- Page Header -->
      <header class="dashboard-header">
        <div class="header-content">
          <div class="title-wrap">
            <h1>المستخدمون والصلاحيات</h1>
            <p class="subtitle">إدارة أعضاء الفريق وتعيين الأدوار ومتابعة حالات الدعوات</p>
          </div>
          <div class="stats-pills">
            <div class="stat-pill">
              <span class="stat-label">الإجمالي</span>
              <strong class="stat-value">{{ totalCount() }}</strong>
            </div>
            <div class="stat-pill active">
              <span class="stat-label">النشطون</span>
              <strong class="stat-value">{{ activeCount() }}</strong>
            </div>
            @if (suspendedCount() > 0) {
              <div class="stat-pill suspended">
                <span class="stat-label">المعلقون</span>
                <strong class="stat-value">{{ suspendedCount() }}</strong>
              </div>
            }
          </div>
        </div>
      </header>

      @if (error()) {
        <div class="alert-error" role="alert">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>{{ error() }}</span>
        </div>
      }

      @if (successMessage()) {
        <div class="alert-success" role="status">
          <div class="alert-success-icon">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          </div>
          <div class="success-content">
            <strong>تم إنشاء الحساب وتفعيله بنجاح!</strong>
            <span>كلمة المرور الافتراضية للحساب هي <code>123456</code>. يمكن للمستخدم تسجيل الدخول فوراً وتغييرها من ملفه الشخصي.</span>
          </div>
          <button type="button" class="btn-dismiss" (click)="successMessage.set('')" aria-label="إغلاق">✕</button>
        </div>
      }

      <!-- Add User Panel -->
      <div class="card invite-card" *halaHasPermission="'users:create'">
        <div class="card-header">
          <div class="header-icon">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
          </div>
          <div>
            <h2>إضافة مستخدم جديد</h2>
            <p>أدخل بيانات المستخدم لإنشاء حسابه مباشرة بكلمة مرور افتراضية (123456)</p>
          </div>
        </div>

        <form class="invite-form" (submit)="create($event)">
          <div class="form-field">
            <label for="inv-name">الاسم الكامل</label>
            <input id="inv-name" placeholder="مثال: أحمد محمد" [formField]="fields.name" />
          </div>

          <div class="form-field">
            <label for="inv-email">البريد الإلكتروني</label>
            <input id="inv-email" type="email" placeholder="name@company.com" [formField]="fields.email" />
          </div>

          <div class="form-field">
            <label for="inv-role">الدور والصلاحيات</label>
            <select id="inv-role" [formField]="fields.roleId">
              <option value="">اختر دوراً…</option>
              @for (role of assignableRoles(); track role._id) {
                <option [value]="role._id">{{ roleLabel(role.name) }}</option>
              }
            </select>
          </div>

          <div class="form-action">
            <button type="submit" class="btn-primary" [disabled]="users.loading()">
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
              <span>إضافة المستخدم</span>
            </button>
          </div>
        </form>
      </div>

      <!-- Members Data Table Card -->
      <div class="card members-card">
        <div class="card-header">
          <div class="header-icon">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
          </div>
          <div>
            <h2>أعضاء الفريق</h2>
            <p>قائمة المستخدمين المسجلين في النظام، صلاحياتهم وحالات حساباتهم</p>
          </div>
        </div>

        <div class="table-container">
          <table class="desktop-table">
            <thead>
              <tr>
                <th scope="col" class="th-user">المستخدم</th>
                <th scope="col" class="th-role">الدور</th>
                <th scope="col" class="th-status">الحالة</th>
                <th scope="col" class="th-actions">الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              @for (user of users.users(); track user._id) {
                <tr class="user-row" [class.suspended-row]="user.status === 'suspended'">
                  <!-- User Column -->
                  <td class="td-user">
                    <div class="user-profile">
                      <div class="avatar" [attr.aria-hidden]="true">
                        {{ userInitials(user.name) }}
                      </div>
                      <div class="user-meta">
                        <span class="user-name">{{ user.name }}</span>
                        <span class="user-email" dir="ltr">{{ user.email }}</span>
                      </div>
                    </div>
                  </td>

                  <!-- Role Column -->
                  <td class="td-role">
                    <div class="role-selector-wrap">
                      <select
                        class="role-dropdown"
                        aria-label="تغيير الدور"
                        [disabled]="!permissions.can('users:update') || user.roleId === ownerRoleId()"
                        [value]="user.roleId"
                        (change)="changeRole(user._id, $event)"
                      >
                        @for (role of tableRoles(user.roleId); track role._id) {
                          <option [value]="role._id">{{ roleLabel(role.name) }}</option>
                        }
                      </select>
                    </div>
                  </td>

                  <!-- Status Column -->
                  <td class="td-status">
                    @switch (user.status) {
                      @case ('active') {
                        <span class="status-badge active">
                          <span class="status-dot"></span>
                          نشط
                        </span>
                      }
                      @case ('suspended') {
                        <span class="status-badge suspended">
                          <span class="status-dot"></span>
                          معلق
                        </span>
                      }
                      @case ('invited') {
                        <span class="status-badge invited">
                          <span class="status-dot"></span>
                          مدعو
                        </span>
                      }
                    }
                  </td>

                  <!-- Actions Column -->
                  <td class="td-actions">
                    <div class="actions-group">
                      @if (user.status === 'active') {
                        <button
                          type="button"
                          class="btn-action btn-suspend"
                          *halaHasPermission="'users:update'"
                          (click)="suspend(user._id)"
                          title="تعليق الحساب مؤقتاً"
                        >
                          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/>
                          </svg>
                          <span>تعليق</span>
                        </button>
                      }
                      @if (user.status === 'suspended') {
                        <button
                          type="button"
                          class="btn-action btn-activate"
                          *halaHasPermission="'users:update'"
                          (click)="activate(user._id)"
                          title="إعادة تفعيل الحساب"
                        >
                          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                          <span>تفعيل</span>
                        </button>
                      }
                      <button
                        type="button"
                        class="btn-action btn-danger"
                        *halaHasPermission="'users:delete'"
                        (click)="remove(user._id)"
                        title="حذف المستخدم نهائياً"
                      >
                        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6m4-6v6"/>
                        </svg>
                        <span>حذف</span>
                      </button>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
    }

    .users-dashboard {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      max-width: 80rem;
      margin-inline: auto;
      padding: 0.5rem 0.25rem 2.5rem;
    }

    /* Dashboard Header */
    .dashboard-header {
      background: #ffffff;
      border: 1px solid #e1ebe5;
      border-radius: 1rem;
      padding: 1.25rem 1.75rem;
      box-shadow: 0 2px 8px rgba(18, 62, 53, 0.04);
    }
    .header-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1.5rem;
      flex-wrap: wrap;
    }
    .title-wrap h1 {
      margin: 0;
      color: #123e35;
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .subtitle {
      margin: 0.3rem 0 0;
      color: #54656f;
      font-size: 0.875rem;
    }
    .stats-pills {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .stat-pill {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.45rem 1rem;
      border-radius: 2rem;
      background: #f5f8f6;
      border: 1px solid #dfe7e3;
    }
    .stat-pill.active {
      background: #edf8f3;
      border-color: #b7e4d0;
      color: #0d765e;
    }
    .stat-pill.suspended {
      background: #fef7ed;
      border-color: #fcd34d;
      color: #b45309;
    }
    .stat-label {
      font-size: 0.8rem;
      color: #54656f;
    }
    .stat-pill.active .stat-label { color: #0d765e; }
    .stat-pill.suspended .stat-label { color: #b45309; }
    .stat-value {
      font-size: 1.05rem;
      font-weight: 700;
    }

    /* Common Card Styles */
    .card {
      background: #ffffff;
      border: 1px solid #e1ebe5;
      border-radius: 1rem;
      box-shadow: 0 4px 18px rgba(18, 62, 53, 0.05);
      overflow: hidden;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1.25rem 1.75rem;
      border-block-end: 1px solid #f0f4f2;
      background: #fcfdfc;
    }
    .header-icon {
      display: grid;
      place-items: center;
      width: 2.6rem;
      height: 2.6rem;
      border-radius: 0.75rem;
      background: #e7f7ef;
      color: #008069;
      flex-shrink: 0;
    }
    .header-icon svg { width: 1.35rem; height: 1.35rem; }
    .card-header h2 {
      margin: 0;
      font-size: 1.15rem;
      font-weight: 600;
      color: #123e35;
    }
    .card-header p {
      margin: 0.2rem 0 0;
      font-size: 0.825rem;
      color: #667781;
    }

    /* Invite Form (Desktop Horizontal Grid) */
    .invite-form {
      display: grid;
      grid-template-columns: 1.3fr 1.6fr 1.3fr auto;
      gap: 1.25rem;
      align-items: end;
      padding: 1.5rem 1.75rem;
    }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }
    .form-field label {
      font-size: 0.85rem;
      font-weight: 600;
      color: #2b443c;
    }
    .form-field input,
    .form-field select {
      height: 2.75rem;
      padding: 0.55rem 0.85rem;
      border: 1px solid #c8d9cf;
      border-radius: 0.6rem;
      background: #ffffff;
      color: #111b21;
      font-size: 0.9rem;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .form-field input:focus-visible,
    .form-field select:focus-visible {
      outline: none;
      border-color: #008069;
      box-shadow: 0 0 0 3px rgba(0, 128, 105, 0.15);
    }
    .form-action .btn-primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      height: 2.75rem;
      padding: 0 1.5rem;
      border: 0;
      border-radius: 0.6rem;
      background: #008069;
      color: #ffffff;
      font-size: 0.92rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s ease, transform 0.05s ease;
    }
    .btn-primary:hover:not(:disabled) {
      background: #006b5b;
    }
    .btn-primary:active:not(:disabled) {
      transform: scale(0.98);
    }
    .btn-primary:disabled {
      opacity: 0.65;
      cursor: not-allowed;
    }
    .btn-primary svg {
      width: 1.15rem;
      height: 1.15rem;
    }

    /* Invitation Result Banner */
    .invitation-result {
      margin: 0 1.75rem 1.5rem;
      padding: 1.2rem 1.4rem;
      border-radius: 0.75rem;
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
    }
    .invitation-info {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .info-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      color: #166534;
      font-weight: 700;
      font-size: 0.95rem;
    }
    .info-badge svg { width: 1.2rem; height: 1.2rem; color: #16a34a; }
    .invitation-info p {
      margin: 0;
      font-size: 0.85rem;
      color: #15803d;
    }
    .token-box {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      background: #ffffff;
      padding: 0.5rem 0.75rem;
      border: 1px solid #86efac;
      border-radius: 0.5rem;
    }
    .token-code {
      flex: 1;
      font-family: monospace;
      font-size: 0.95rem;
      font-weight: 600;
      color: #14532d;
      word-break: break-all;
    }
    .btn-copy {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.45rem 0.9rem;
      border: 1px solid #16a34a;
      border-radius: 0.45rem;
      background: #16a34a;
      color: #ffffff;
      font-size: 0.825rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
    }
    .btn-copy:hover {
      background: #15803d;
    }
    .btn-copy.copied {
      background: #0f765e;
      border-color: #0f765e;
    }
    .btn-copy svg { width: 1rem; height: 1rem; }

    /* Desktop Table Layout */
    .table-container {
      width: 100%;
      overflow-x: auto;
    }
    .desktop-table {
      width: 100%;
      border-collapse: collapse;
      text-align: start;
    }
    .desktop-table th {
      padding: 1rem 1.5rem;
      background: #fafcfb;
      color: #4b6358;
      font-size: 0.825rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-block-end: 1px solid #e5ede8;
      white-space: nowrap;
    }
    .desktop-table td {
      padding: 1.1rem 1.5rem;
      border-block-end: 1px solid #f0f4f2;
      vertical-align: middle;
    }
    .user-row {
      transition: background 0.12s ease;
    }
    .user-row:hover {
      background: #fbfdfc;
    }
    .user-row:last-child td {
      border-block-end: none;
    }
    .suspended-row {
      background: #fffdfa;
    }

    /* User Profile Info */
    .user-profile {
      display: flex;
      align-items: center;
      gap: 0.9rem;
    }
    .avatar {
      display: grid;
      place-items: center;
      width: 2.65rem;
      height: 2.65rem;
      border-radius: 50%;
      background: #e0f2fe;
      color: #0284c7;
      font-weight: 700;
      font-size: 0.92rem;
      flex-shrink: 0;
      box-shadow: inset 0 0 0 1px rgba(2, 132, 199, 0.2);
    }
    .user-meta {
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }
    .user-name {
      font-weight: 600;
      font-size: 0.95rem;
      color: #111b21;
    }
    .user-email {
      font-size: 0.825rem;
      color: #667781;
      text-align: start;
    }

    /* Role Dropdown Column */
    .role-selector-wrap {
      display: inline-block;
      width: 11rem;
      max-width: 100%;
    }
    .role-dropdown {
      width: 100%;
      height: 2.45rem;
      padding: 0.35rem 0.75rem;
      border: 1px solid #cfe0d7;
      border-radius: 0.5rem;
      background: #ffffff;
      color: #19342e;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: border-color 0.15s ease;
    }
    .role-dropdown:hover:not(:disabled) {
      border-color: #008069;
    }
    .role-dropdown:disabled {
      opacity: 0.7;
      cursor: not-allowed;
      background: #f7faf8;
    }

    /* Status Badges */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      padding: 0.35rem 0.75rem;
      border-radius: 2rem;
      font-size: 0.8rem;
      font-weight: 600;
      white-space: nowrap;
    }
    .status-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
    }
    .status-badge.active {
      background: #e7f7ef;
      color: #0b7a5a;
    }
    .status-badge.active .status-dot {
      background: #00a884;
    }
    .status-badge.suspended {
      background: #fef3c7;
      color: #92400e;
    }
    .status-badge.suspended .status-dot {
      background: #d97706;
    }
    .status-badge.invited {
      background: #e0f2fe;
      color: #0369a1;
    }
    .status-badge.invited .status-dot {
      background: #0284c7;
    }

    /* Actions Column Group */
    .actions-group {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .btn-action {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.4rem 0.75rem;
      border-radius: 0.45rem;
      border: 1px solid transparent;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      background: transparent;
      transition: all 0.12s ease;
    }
    .btn-action svg {
      width: 0.95rem;
      height: 0.95rem;
    }
    .btn-suspend {
      border-color: #fed7aa;
      background: #fffaf5;
      color: #c2410c;
    }
    .btn-suspend:hover {
      background: #ffedd5;
      border-color: #fdba74;
      color: #9a3412;
    }
    .btn-activate {
      border-color: #bbf7d0;
      background: #f0fdf4;
      color: #15803d;
    }
    .btn-activate:hover {
      background: #dcfce7;
      border-color: #86efac;
      color: #166534;
    }
    .btn-danger {
      border-color: #fecaca;
      background: #fff8f8;
      color: #b91c1c;
    }
    .btn-danger:hover {
      background: #fee2e2;
      border-color: #f87171;
      color: #991b1b;
    }

    /* Error Alert */
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
    .alert-error svg {
      width: 1.2rem;
      height: 1.2rem;
      color: #dc2626;
      flex-shrink: 0;
    }

    /* Success Alert */
    .alert-success {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.85rem;
      padding: 1rem 1.25rem;
      border-radius: 0.65rem;
      background: #f0fdf4;
      border: 1px solid #86efac;
      color: #166534;
      font-size: 0.875rem;
    }
    .alert-success-icon {
      width: 2rem;
      height: 2rem;
      border-radius: 50%;
      background: #dcfce7;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .alert-success-icon svg {
      width: 1.2rem;
      height: 1.2rem;
      color: #16a34a;
    }
    .success-content {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      flex: 1;
    }
    .success-content strong {
      font-size: 0.95rem;
      color: #14532d;
    }
    .success-content span {
      color: #166534;
      font-size: 0.85rem;
      line-height: 1.4;
    }
    .success-content code {
      background: #dcfce7;
      padding: 0.15rem 0.45rem;
      border-radius: 0.35rem;
      font-family: monospace;
      font-weight: 700;
      color: #14532d;
    }
    .btn-dismiss {
      background: transparent;
      border: none;
      font-size: 1.1rem;
      color: #15803d;
      cursor: pointer;
      padding: 0.2rem 0.5rem;
      border-radius: 0.25rem;
      line-height: 1;
    }
    .btn-dismiss:hover {
      background: #dcfce7;
    }

    /* Responsive Adaptation for Tablets and Phones */
    @media (max-width: 900px) {
      .invite-form {
        grid-template-columns: 1fr 1fr;
      }
      .form-action {
        grid-column: span 2;
      }
      .form-action .btn-primary {
        width: 100%;
      }
    }
    @media (max-width: 650px) {
      .header-content {
        flex-direction: column;
        align-items: stretch;
        gap: 1rem;
      }
      .stats-pills {
        display: flex;
        flex-wrap: wrap;
        width: 100%;
        gap: 0.5rem;
      }
      .stat-pill {
        flex: 1 1 auto;
        justify-content: center;
        padding: 0.4rem 0.75rem;
      }
      .invite-form {
        grid-template-columns: 1fr;
        padding: 1rem;
      }
      .form-action {
        grid-column: span 1;
      }
      .dashboard-header {
        padding: 1rem;
      }
      .card-header {
        padding: 1rem;
      }
      .table-container {
        -webkit-overflow-scrolling: touch;
      }
      .desktop-table {
        min-width: 36rem;
      }
      .desktop-table th,
      .desktop-table td {
        padding: 0.75rem 0.85rem;
      }
      .invitation-result {
        margin: 0 1rem 1rem;
        padding: 1rem;
      }
      .token-box {
        flex-direction: column;
        align-items: stretch;
        gap: 0.5rem;
      }
      .btn-copy {
        justify-content: center;
      }
    }
    @media (max-width: 440px) {
      .users-dashboard {
        padding: 0.25rem 0.15rem 2rem;
      }
      .title-wrap h1 {
        font-size: 1.25rem;
      }
      .card-header h2 {
        font-size: 1.05rem;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UsersComponent implements OnInit {
  readonly users = inject(UsersStore);
  readonly roles = inject(RolesStore);
  readonly permissions = inject(PermissionsStore);
  readonly draft = signal({ name: '', email: '', roleId: '' });
  readonly fields = form(this.draft);
  readonly error = signal('');
  readonly successMessage = signal('');

  readonly totalCount = computed(() => this.users.users().length);
  readonly activeCount = computed(() => this.users.users().filter(u => u.status === 'active').length);
  readonly suspendedCount = computed(() => this.users.users().filter(u => u.status === 'suspended').length);

  readonly assignableRoles = computed(() =>
    this.roles.roles().filter(r => ['admin', 'agent'].includes(r.name.toLowerCase()))
  );

  readonly ownerRoleId = computed(() =>
    this.roles.roles().find(r => r.name.toLowerCase() === 'owner')?._id
  );

  tableRoles(currentRoleId: string) {
    const assignable = this.assignableRoles();
    if (assignable.some(r => r._id === currentRoleId)) {
      return assignable;
    }
    const current = this.roles.roles().find(r => r._id === currentRoleId);
    return current ? [current, ...assignable] : assignable;
  }

  roleLabel(name: string): string {
    switch (name?.toLowerCase()) {
      case 'owner': return 'مالك النظام (Owner)';
      case 'admin': return 'مسؤول (Admin)';
      case 'agent': return 'وكيل / موظف (Agent)';
      default: return name;
    }
  }

  ngOnInit(): void {
    void this.users.load().catch(() => this.error.set('تعذر تحميل المستخدمين.'));
    void this.roles.load().catch(() => this.error.set('تعذر تحميل الأدوار.'));
  }

  userInitials(name: string): string {
    if (!name) return '؟';
    const parts = name.trim().split(/\s+/);
    const first = parts[0];
    const second = parts[1];
    if (first && second) return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  async create(event: Event): Promise<void> {
    event.preventDefault();
    const parsed = createUserSchema.safeParse(this.draft());
    if (!parsed.success) {
      this.error.set('يرجى التأكد من ملء الاسم، والبريد الإلكتروني، واختيار الدور.');
      return;
    }
    try {
      await this.users.create(parsed.data);
      this.draft.set({ name: '', email: '', roleId: '' });
      this.error.set('');
      this.successMessage.set('تم إنشاء الحساب بنجاح! كلمة المرور الافتراضية هي 123456');
    } catch {
      this.error.set('تعذر إضافة المستخدم أو البريد الإلكتروني مسجل مسبقاً.');
    }
  }

  async changeRole(id: string, event: Event): Promise<void> {
    const roleId = (event.target as HTMLSelectElement).value;
    try {
      await this.users.update(id, roleId);
      this.error.set('');
    } catch {
      this.error.set('تعذر تغيير الدور.');
      await this.users.load();
    }
  }

  async suspend(id: string): Promise<void> {
    try {
      await this.users.suspend(id);
      this.error.set('');
    } catch {
      this.error.set('تعذر تعليق المستخدم أو هو آخر مالك.');
    }
  }

  async activate(id: string): Promise<void> {
    try {
      await this.users.activate(id);
      this.error.set('');
    } catch {
      this.error.set('تعذر تفعيل المستخدم.');
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.users.remove(id);
      this.error.set('');
    } catch {
      this.error.set('تعذر حذف المستخدم أو هو آخر مالك.');
    }
  }
}
