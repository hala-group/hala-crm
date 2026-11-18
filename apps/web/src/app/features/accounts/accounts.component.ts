import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { createAccountSchema, type AccountLevel, type AccountView } from '@hala/shared';
import { AccountsStore } from './accounts.store';
import { UsersStore } from '../users/users.store';
import { PermissionsStore } from '../../core/permissions.store';
import { HasPermissionDirective } from '../../shared/has-permission.directive';

const PRESET_COLORS = [
  '#008069', // WhatsApp Classic
  '#0284c7', // Sky Blue
  '#7c3aed', // Purple
  '#ea580c', // Orange
  '#db2777', // Pink
  '#059669', // Emerald
  '#123e35', // Deep Forest
  '#475569', // Slate
];

@Component({
  selector: 'hala-accounts',
  imports: [FormField, HasPermissionDirective],
  host: {
    '(document:click)': 'onDocumentClick()',
    '(document:keydown.escape)': 'onEscape()',
  },
  template: `
    <section class="accounts-dashboard" dir="rtl">
      <!-- Dashboard Page Header -->
      <header class="dashboard-header">
        <div class="header-main">
          <div class="header-title-wrap">
            <div class="title-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <rect x="5" y="2" width="14" height="20" rx="2"/>
                <path d="M12 18h.01"/>
              </svg>
            </div>
            <div>
              <div class="title-with-badge">
                <h1 class="page-title">أرقام واتساب</h1>
                <span class="count-badge">{{ accounts.accounts().length }} رقم</span>
              </div>
              <p class="page-subtitle">إدارة خطوط واتساب المتصلة، الربط عبر رمز QR، وتعيين صلاحيات الفريق</p>
            </div>
          </div>

          <div class="header-actions">
            <!-- Quick Stats Pills -->
            <div class="stats-pills">
              <div class="stat-pill">
                <span class="stat-label">الإجمالي</span>
                <strong class="stat-value">{{ totalCount() }}</strong>
              </div>
              <div class="stat-pill active">
                <span class="stat-dot dot-active"></span>
                <span class="stat-label">نشط</span>
                <strong class="stat-value">{{ connectedCount() }}</strong>
              </div>
              @if (disconnectedCount() > 0) {
                <div class="stat-pill pending">
                  <span class="stat-dot dot-pending"></span>
                  <span class="stat-label">غير متصل</span>
                  <strong class="stat-value">{{ disconnectedCount() }}</strong>
                </div>
              }
            </div>

            <!-- Add Number Button -->
            <button
              type="button"
              class="btn-add-account"
              *halaHasPermission="'accounts:create'"
              (click)="toggleCreatePanel($event)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              <span>إضافة رقم جديد</span>
            </button>
          </div>
        </div>
      </header>

      <!-- Alerts & Feedback -->
      @if (error()) {
        <div class="alert alert-error" role="alert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>{{ error() }}</span>
          <button type="button" class="btn-alert-dismiss" (click)="error.set('')">✕</button>
        </div>
      }
      @if (notice()) {
        <div class="alert alert-notice" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>{{ notice() }}</span>
          <button type="button" class="btn-alert-dismiss" (click)="notice.set('')">✕</button>
        </div>
      }

      <!-- Add Account Collapsible Card -->
      @if (showCreatePanel()) {
        <div class="card create-card" *halaHasPermission="'accounts:create'">
          <div class="card-header">
            <div class="card-header-title">
              <div class="header-icon-small">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 5v14m-7-7h14"/>
                </svg>
              </div>
              <div>
                <h2>إضافة رقم واتساب جديد</h2>
                <p>أدخل اسم الرقم واختر المزوّد ولون التمييز لتنظيم الدردشات</p>
              </div>
            </div>
            <button type="button" class="btn-close-card" (click)="showCreatePanel.set(false)" aria-label="إغلاق">✕</button>
          </div>

          <form class="create-form" (submit)="create($event)">
            <div class="form-row">
              <!-- Label Input -->
              <div class="form-field flex-2">
                <label for="acc-label">اسم الرقم <span class="required">*</span></label>
                <input
                  id="acc-label"
                  placeholder="مثال: خدمة العملاء، المبيعات، الرقم المصري"
                  [formField]="createFields.label"
                />
              </div>

              <!-- Provider Select -->
              <div class="form-field flex-1">
                <label for="acc-provider">المزوّد</label>
                <select id="acc-provider" [formField]="createFields.provider">
                  <option value="baileys">واتساب مرتبط (مسح QR)</option>
                  <option value="cloud_api">WhatsApp Cloud API (ميتا الرسمية)</option>
                </select>
              </div>
            </div>

            <!-- Color Palette Row -->
            <div class="color-selection-row">
              <span class="field-label">لون تمييز الرقم:</span>
              <div class="color-palette">
                @for (c of presetColors; track c) {
                  <button
                    type="button"
                    class="color-chip"
                    [style.background-color]="c"
                    [class.selected]="createDraft().color === c"
                    (click)="setColor(c)"
                    [title]="c"
                  >
                    @if (createDraft().color === c) {
                      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    }
                  </button>
                }
                <!-- Custom Color Picker -->
                <label class="custom-color-picker" title="اختيار لون مخصص">
                  <input type="color" [formField]="createFields.color" class="native-color-input" />
                  <span class="picker-label">مخصص</span>
                </label>
              </div>
            </div>

            <!-- Cloud API Fields -->
            @if (createDraft().provider === 'cloud_api') {
              <div class="cloud-fields-card">
                <div class="cloud-info">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                  </svg>
                  <span>أدخل معرّفات حساب Meta Cloud API الخاص بك:</span>
                </div>
                <div class="cloud-fields-grid">
                  <div class="form-field">
                    <label for="acc-phone-id">معرّف رقم Cloud (Phone Number ID)</label>
                    <input id="acc-phone-id" [formField]="createFields.phoneNumberId" placeholder="1029384756..." />
                  </div>
                  <div class="form-field">
                    <label for="acc-waba-id">معرّف WABA (WhatsApp Business Account ID)</label>
                    <input id="acc-waba-id" [formField]="createFields.wabaId" placeholder="987654321..." />
                  </div>
                  <div class="form-field full-width">
                    <label for="acc-token">رمز الوصول الدائم (Permanent Access Token)</label>
                    <input id="acc-token" type="password" autocomplete="off" [formField]="createFields.accessToken" placeholder="EAA..." />
                  </div>
                </div>
              </div>
            }

            <!-- Form Actions -->
            <div class="form-actions">
              <button type="submit" class="btn-submit-create" [disabled]="accounts.loading()">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>حفظ وإضافة الرقم</span>
              </button>
              <button type="button" class="btn-cancel" (click)="showCreatePanel.set(false)">إلغاء</button>
            </div>
          </form>
        </div>
      }

      <!-- Accounts Cards Grid -->
      <div class="accounts-grid">
        @for (account of accounts.accounts(); track account._id) {
          <article class="account-card" [style.--account-accent]="account.color || '#008069'">
            <!-- Card Accent Top Bar -->
            <div class="card-accent-strip"></div>

            <!-- Card Header -->
            <div class="account-card-header">
              <div class="account-avatar" [style.background-color]="account.color || '#008069'">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="5" y="2" width="14" height="20" rx="2"/>
                  <path d="M12 18h.01"/>
                </svg>
              </div>
              <div class="account-meta">
                <div class="account-title-row">
                  <h2 class="account-label">{{ account.label }}</h2>
                </div>
                <div class="account-provider-tag" [class.provider-cloud]="account.provider === 'cloud_api'">
                  <span class="provider-icon">
                    @if (account.provider === 'cloud_api') {
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
                    } @else {
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.1 0l2.1-2.1a5 5 0 0 0-7.1-7.1L10.9 5"/><path d="M14 11a5 5 0 0 0-7.1 0l-2.1 2.1a5 5 0 0 0 7.1 7.1l1.2-1.2"/></svg>
                    }
                  </span>
                  <span>{{ account.provider === 'cloud_api' ? 'Cloud API' : 'واتساب ويب (Baileys)' }}</span>
                </div>
              </div>

              <!-- Status Badge -->
              <div class="status-badge-wrap">
                <span class="status-badge" [class]="'status-' + account.status">
                  <span class="status-dot"></span>
                  <span>{{ formatStatus(account.status) }}</span>
                </span>
              </div>
            </div>

            <!-- Card Body: Phone & Info -->
            <div class="account-card-body">
              <div class="phone-display-row">
                <div class="phone-info">
                  <span class="phone-label">رقم الهاتف المرتبط:</span>
                  @if (account.phoneNumber) {
                    <div class="phone-value-wrap">
                      <strong class="phone-number" dir="ltr">+{{ account.phoneNumber }}</strong>
                      <button
                        type="button"
                        class="btn-copy-number"
                        (click)="copyNumber(account.phoneNumber, account._id, $event)"
                        title="نسخ الرقم"
                      >
                        @if (copiedId() === account._id) {
                          <span class="tooltip-copied">تم النسخ</span>
                        } @else {
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                          </svg>
                        }
                      </button>
                    </div>
                  } @else {
                    <span class="phone-unlinked">لم يرتبط برقم هاتف بعد</span>
                  }
                </div>
              </div>
            </div>

            <!-- Card Actions Bar -->
            <div class="account-card-actions">
              <!-- Primary Action Based on Status -->
              @if (account.status === 'connected') {
                @if (account.provider === 'baileys') {
                  <button
                    type="button"
                    class="btn-action-primary"
                    [disabled]="syncingId() === account._id"
                    (click)="syncHistory(account._id)"
                    title="طلب استيراد سجل الرسائل والدردشات من الهاتف"
                  >
                    <svg [class.spin]="syncingId() === account._id" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                      <path d="M3 3v5h5"/>
                      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                      <path d="M16 21h5v-5"/>
                    </svg>
                    <span>{{ syncingId() === account._id ? 'جارٍ المزامنة…' : 'مزامنة الرسائل' }}</span>
                  </button>
                }
              } @else {
                <button
                  type="button"
                  class="btn-action-primary btn-action-qr"
                  *halaHasPermission="'accounts:connect'"
                  [disabled]="connectingId() === account._id"
                  (click)="handleQrConnect(account._id)"
                  title="مسح رمز الاستجابة السريعة QR للربط"
                >
                  @if (connectingId() === account._id) {
                    <svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                    <span>جارٍ التوليد…</span>
                  } @else {
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="3" width="7" height="7"/>
                      <rect x="14" y="3" width="7" height="7"/>
                      <rect x="14" y="14" width="7" height="7"/>
                      <rect x="3" y="14" width="7" height="7"/>
                    </svg>
                    <span>مسح رمز QR للربط</span>
                  }
                </button>
              }

              <!-- Members & Permissions Button -->
              @if (permissions.can('accounts:members', account._id)) {
                <button
                  type="button"
                  class="btn-action-secondary"
                  (click)="openMembers(account._id, $event)"
                  title="إدارة أعضاء الفريق المصرح لهم بالوصول لهذا الرقم"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                  <span>الأعضاء</span>
                </button>
              }

              <!-- More Options Dropdown Toggle -->
              <div class="menu-container">
                <button
                  type="button"
                  class="btn-action-more"
                  (click)="toggleMenu(account._id, $event)"
                  aria-label="المزيد من الإجراءات"
                  title="المزيد من الإجراءات"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="1"/>
                    <circle cx="12" cy="5" r="1"/>
                    <circle cx="12" cy="19" r="1"/>
                  </svg>
                </button>

                <!-- Dropdown Menu -->
                @if (activeMenuId() === account._id) {
                  <div class="dropdown-menu" (click)="$event.stopPropagation()">
                    @if (permissions.can('accounts:connect', account._id)) {
                      <button
                        type="button"
                        class="menu-item"
                        (click)="operate(account._id, 'disconnect'); closeMenu()"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                          <circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/>
                        </svg>
                        <span>فصل مؤقت</span>
                      </button>

                      <button
                        type="button"
                        class="menu-item"
                        (click)="operate(account._id, 'logout'); closeMenu()"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                        <span>تسجيل خروج واتساب</span>
                      </button>

                      @if (account.provider === 'baileys' && account.status === 'connected') {
                        <button
                          type="button"
                          class="menu-item"
                          (click)="clearChats(account); closeMenu()"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                            <path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/>
                          </svg>
                          <span>مسح الدردشات وإعادة الربط</span>
                        </button>
                      }
                    }

                    @if (permissions.can('accounts:delete', account._id)) {
                      <div class="menu-divider"></div>
                      <button
                        type="button"
                        class="menu-item menu-item-danger"
                        (click)="remove(account); closeMenu()"
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                          <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2M10 11v6m4-6v6"/>
                        </svg>
                        <span>حذف الرقم نهائياً</span>
                      </button>
                    }
                  </div>
                }
              </div>
            </div>
          </article>
        } @empty {
          <div class="empty-state">
            <div class="empty-icon-wrap">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <rect x="5" y="2" width="14" height="20" rx="2"/>
                <path d="M12 18h.01"/>
              </svg>
            </div>
            <h3>لا توجد أرقام مضافة حتى الآن</h3>
            <p>قم بإضافة رقم واتساب وربطه عبر رمز QR لبدء استقبال وإرسال الرسائل والمكالمات في Hala CRM.</p>
            <button
              type="button"
              class="btn-empty-add"
              *halaHasPermission="'accounts:create'"
              (click)="showCreatePanel.set(true)"
            >
              + إضافة أول رقم الآن
            </button>
          </div>
        }
      </div>

      <!-- Members Management Modal -->
      @if (showMembersModal(); as selectedId) {
        <div class="backdrop" role="presentation" (click)="closeMembers()">
          <div class="modal members-modal" role="dialog" aria-modal="true" aria-label="أعضاء الرقم وصلاحياتهم" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <div class="modal-title-wrap">
                <div class="modal-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                    <circle cx="12" cy="7" r="4"/>
                  </svg>
                </div>
                <div>
                  <h2>صلاحيات وصول الأعضاء</h2>
                  <p>تحديد الموظفين المصرح لهم بعرض ومراسلة العملاء عبر هذا الرقم</p>
                </div>
              </div>
              <button type="button" class="btn-modal-close" (click)="closeMembers()" aria-label="إغلاق">✕</button>
            </div>

            <!-- Add Member Sub-Form -->
            <form class="add-member-bar" (submit)="setMember($event, selectedId)">
              <div class="member-field">
                <label for="select-user">الموظف / المستخدم</label>
                <select id="select-user" [formField]="memberFields.userId">
                  <option value="">اختر موظفاً…</option>
                  @for (u of usersStore.users(); track u._id) {
                    <option [value]="u._id">{{ u.name }} ({{ u.email }})</option>
                  }
                </select>
              </div>

              <div class="member-field">
                <label for="select-level">مستوى الصلاحية</label>
                <select id="select-level" [formField]="memberFields.level">
                  <option value="view">👁️ عرض فقط (قراءة دون إرسال)</option>
                  <option value="reply">💬 رد ومراسلة (إرسال واستقبال)</option>
                  <option value="manage">⚙️ إدارة كاملة (ربط وفصل الرقم)</option>
                </select>
              </div>

              <button type="submit" class="btn-add-member-submit">منح الصلاحية</button>
            </form>

            <!-- Members List -->
            <div class="members-list-wrap">
              <h3 class="members-subtitle">الأعضاء المصرح لهم حالياً ({{ accounts.members().length }})</h3>
              <div class="members-list">
                @for (member of accounts.members(); track member._id) {
                  <div class="member-row">
                    <div class="member-info">
                      <div class="member-avatar">{{ getUserInitials(member.userId) }}</div>
                      <div class="member-texts">
                        <strong class="member-name">{{ getUserName(member.userId) }}</strong>
                        <span class="member-email" dir="ltr">{{ getUserEmail(member.userId) }}</span>
                      </div>
                    </div>

                    <div class="member-actions">
                      <span class="level-badge" [class]="'level-' + member.level">
                        {{ formatLevel(member.level) }}
                      </span>
                      <button
                        type="button"
                        class="btn-revoke-member"
                        (click)="removeMember(selectedId, member.userId)"
                        title="سحب صلاحية الوصول"
                      >
                        سحب
                      </button>
                    </div>
                  </div>
                } @empty {
                  <div class="empty-members">
                    <p>لم يتم تخصيص أعضاء محددين بعد. (إذا لم يتم تخصيص أعضاء، تقتصر الصلاحية على مالك الحساب والمدراء).</p>
                  </div>
                }
              </div>
            </div>
          </div>
        </div>
      }

      <!-- WhatsApp QR Code Modal -->
      @if (accounts.qr(); as qr) {
        <div class="backdrop" role="presentation" (click)="accounts.closeQr()">
          <div class="modal qr-modal" role="dialog" aria-modal="true" aria-label="رمز ربط واتساب" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <div class="modal-title-wrap">
                <div class="modal-icon qr-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="7" height="7"/>
                    <rect x="14" y="3" width="7" height="7"/>
                    <rect x="14" y="14" width="7" height="7"/>
                    <rect x="3" y="14" width="7" height="7"/>
                  </svg>
                </div>
                <div>
                  <h2>ربط واتساب عبر رمز QR</h2>
                  <p>امسح الرمز لربط الخط بحسابك في Hala CRM</p>
                </div>
              </div>
              <button type="button" class="btn-modal-close" (click)="accounts.closeQr()" aria-label="إغلاق">✕</button>
            </div>

            <!-- Steps Instruction Guide -->
            <div class="qr-steps">
              <div class="qr-step">
                <span class="step-num">1</span>
                <span>افتح تطبيق <strong>WhatsApp</strong> على هاتفك</span>
              </div>
              <div class="qr-step">
                <span class="step-num">2</span>
                <span>اضغط على <strong>القائمة (⋮)</strong> أو <strong>الإعدادات</strong></span>
              </div>
              <div class="qr-step">
                <span class="step-num">3</span>
                <span>اختر <strong>الأجهزة المرتبطة</strong> ثم <strong>ربط جهاز</strong></span>
              </div>
              <div class="qr-step">
                <span class="step-num">4</span>
                <span>وجّه كاميرا الهاتف نحو الرمز الموضح أدناه</span>
              </div>
            </div>

            <!-- Centered QR Image Frame -->
            <div class="qr-code-frame">
              <img [src]="qr.image" alt="رمز QR لربط واتساب" class="qr-image" width="260" height="260" />
            </div>

            <div class="qr-footer-hint">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <span>يتجدد الرمز تلقائياً — بمجرد المسح سيتصل الرقم مباشرة</span>
            </div>

            <button type="button" class="btn-dismiss-qr" (click)="accounts.closeQr()">إغلاق النافذة</button>
          </div>
        </div>
      }
    </section>
  `,
  styles: [`
    :host {
      display: block;
      width: 100%;
    }

    .accounts-dashboard {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
      max-width: 82rem;
      margin-inline: auto;
      padding: 0.5rem 0.25rem 2.5rem;
    }

    /* Dashboard Header */
    .dashboard-header {
      background: #ffffff;
      border: 1px solid #e1ebe5;
      border-radius: 1.25rem;
      padding: 1.35rem 1.75rem;
      box-shadow: 0 4px 16px rgba(18, 62, 53, 0.04);
    }
    .header-main {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1.5rem;
      flex-wrap: wrap;
    }
    .header-title-wrap {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .title-icon {
      width: 3.25rem;
      height: 3.25rem;
      border-radius: 1rem;
      background: linear-gradient(135deg, #123e35 0%, #008069 100%);
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(0, 128, 105, 0.22);
    }
    .title-icon svg { width: 1.75rem; height: 1.75rem; }
    .title-with-badge {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .page-title {
      margin: 0;
      color: #123e35;
      font-size: 1.55rem;
      font-weight: 800;
      letter-spacing: -0.01em;
    }
    .count-badge {
      font-size: 0.8rem;
      font-weight: 700;
      color: #047857;
      background: #d1fae5;
      padding: 0.2rem 0.65rem;
      border-radius: 9999px;
    }
    .page-subtitle {
      margin: 0.25rem 0 0;
      color: #54656f;
      font-size: 0.875rem;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
    }
    .stats-pills {
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }
    .stat-pill {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.9rem;
      border-radius: 2rem;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      font-size: 0.825rem;
    }
    .stat-pill.active {
      background: #edf8f3;
      border-color: #b7e4d0;
      color: #0d765e;
    }
    .stat-pill.pending {
      background: #fff7ed;
      border-color: #ffedd5;
      color: #c2410c;
    }
    .stat-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
    }
    .dot-active { background: #00a884; }
    .dot-pending { background: #ea580c; }
    .stat-label { color: #64748b; }
    .stat-pill.active .stat-label { color: #0d765e; }
    .stat-pill.pending .stat-label { color: #c2410c; }
    .stat-value { font-weight: 700; font-size: 0.95rem; }

    .btn-add-account {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      height: 2.75rem;
      padding: 0 1.25rem;
      border: none;
      border-radius: 0.75rem;
      background: #008069;
      color: #ffffff;
      font-weight: 700;
      font-size: 0.92rem;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 128, 105, 0.25);
      transition: all 0.15s ease;
    }
    .btn-add-account:hover {
      background: #006b5b;
      transform: translateY(-1px);
    }
    .btn-add-account svg { width: 1.15rem; height: 1.15rem; }

    /* Alerts */
    .alert {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.85rem 1.25rem;
      border-radius: 0.75rem;
      font-size: 0.875rem;
      font-weight: 600;
    }
    .alert svg { width: 1.25rem; height: 1.25rem; flex-shrink: 0; }
    .alert-error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
    .alert-notice { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
    .btn-alert-dismiss {
      margin-inline-start: auto;
      background: transparent;
      border: none;
      font-size: 1.1rem;
      cursor: pointer;
      color: inherit;
      opacity: 0.7;
    }
    .btn-alert-dismiss:hover { opacity: 1; }

    /* Create Card */
    .card {
      background: #ffffff;
      border: 1px solid #e1ebe5;
      border-radius: 1.15rem;
      box-shadow: 0 4px 18px rgba(18, 62, 53, 0.05);
      overflow: hidden;
    }
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid #f0f4f2;
      background: #fcfdfc;
    }
    .card-header-title {
      display: flex;
      align-items: center;
      gap: 0.85rem;
    }
    .header-icon-small {
      width: 2.4rem;
      height: 2.4rem;
      border-radius: 0.65rem;
      background: #e7f7ef;
      color: #008069;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .header-icon-small svg { width: 1.2rem; height: 1.2rem; }
    .card-header h2 { margin: 0; font-size: 1.15rem; font-weight: 700; color: #123e35; }
    .card-header p { margin: 0.15rem 0 0; font-size: 0.825rem; color: #64748b; }
    .btn-close-card {
      background: transparent;
      border: none;
      font-size: 1.2rem;
      color: #94a3b8;
      cursor: pointer;
      padding: 0.35rem;
      border-radius: 0.4rem;
    }
    .btn-close-card:hover { color: #0f172a; background: #f1f5f9; }

    .create-form {
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .form-row {
      display: flex;
      gap: 1.25rem;
      flex-wrap: wrap;
    }
    .flex-1 { flex: 1 1 15rem; }
    .flex-2 { flex: 2 1 20rem; }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }
    .form-field label, .field-label {
      font-size: 0.85rem;
      font-weight: 600;
      color: #334155;
    }
    .required { color: #dc2626; }
    .form-field input, .form-field select {
      height: 2.75rem;
      padding: 0.55rem 0.85rem;
      border: 1px solid #cbd5e1;
      border-radius: 0.6rem;
      font-size: 0.9rem;
      color: #0f172a;
      background: #ffffff;
      outline: none;
      transition: all 0.15s ease;
    }
    .form-field input:focus, .form-field select:focus {
      border-color: #008069;
      box-shadow: 0 0 0 3px rgba(0, 128, 105, 0.12);
    }

    /* Color Selection */
    .color-selection-row {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .color-palette {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      flex-wrap: wrap;
    }
    .color-chip {
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 50%;
      border: 2px solid #ffffff;
      box-shadow: 0 0 0 1px #cbd5e1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.15s ease;
    }
    .color-chip:hover { transform: scale(1.12); }
    .color-chip.selected {
      box-shadow: 0 0 0 2px #0f172a;
      transform: scale(1.08);
    }
    .color-chip svg { width: 1.1rem; height: 1.1rem; }
    .custom-color-picker {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.35rem 0.75rem;
      border: 1px dashed #cbd5e1;
      border-radius: 2rem;
      cursor: pointer;
      font-size: 0.8rem;
      font-weight: 600;
      color: #475569;
      background: #f8fafc;
    }
    .custom-color-picker:hover { background: #f1f5f9; border-color: #94a3b8; }
    .native-color-input {
      width: 1.5rem;
      height: 1.5rem;
      border: none;
      padding: 0;
      background: transparent;
      cursor: pointer;
    }

    /* Cloud fields */
    .cloud-fields-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 0.75rem;
      padding: 1.15rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    .cloud-info {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
      color: #0284c7;
      font-weight: 600;
    }
    .cloud-info svg { width: 1.15rem; height: 1.15rem; }
    .cloud-fields-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .full-width { grid-column: 1 / -1; }

    .form-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-top: 0.5rem;
    }
    .btn-submit-create {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      min-height: 2.75rem;
      padding: 0.5rem 1.5rem;
      border: none;
      border-radius: 0.65rem;
      background: #008069;
      color: #ffffff;
      font-size: 0.92rem;
      font-weight: 700;
      white-space: nowrap;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    .btn-submit-create svg {
      width: 1.15rem;
      height: 1.15rem;
      flex-shrink: 0;
    }
    .btn-submit-create:hover:not(:disabled) { background: #006b5b; }
    .btn-submit-create:disabled { opacity: 0.6; cursor: wait; }
    .btn-cancel {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 2.75rem;
      padding: 0.5rem 1.25rem;
      border: 1px solid #cbd5e1;
      border-radius: 0.65rem;
      background: #ffffff;
      color: #475569;
      font-weight: 600;
      font-size: 0.9rem;
      white-space: nowrap;
      cursor: pointer;
    }
    .btn-cancel:hover { background: #f8fafc; color: #0f172a; }

    /* Accounts Grid */
    .accounts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(23rem, 1fr));
      gap: 1.25rem;
    }

    /* Account Card */
    .account-card {
      position: relative;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 1.25rem;
      display: flex;
      flex-direction: column;
      overflow: visible;
      box-shadow: 0 4px 16px rgba(18, 62, 53, 0.04);
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    }
    .account-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 24px rgba(18, 62, 53, 0.08);
      border-color: #cbd5e1;
    }

    /* Top Accent Line */
    .card-accent-strip {
      height: 5px;
      width: 100%;
      background-color: var(--account-accent, #008069);
      border-top-left-radius: 1.25rem;
      border-top-right-radius: 1.25rem;
    }

    /* Account Card Header */
    .account-card-header {
      padding: 1.25rem 1.25rem 0.85rem;
      display: flex;
      align-items: flex-start;
      gap: 0.85rem;
    }
    .account-avatar {
      width: 3.1rem;
      height: 3.1rem;
      border-radius: 0.85rem;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.12);
    }
    .account-avatar svg { width: 1.6rem; height: 1.6rem; }
    .account-meta {
      flex: 1;
      min-width: 0;
    }
    .account-label {
      margin: 0;
      font-size: 1.2rem;
      font-weight: 800;
      color: #0f172a;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .account-provider-tag {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      margin-top: 0.25rem;
      font-size: 0.775rem;
      font-weight: 600;
      color: #0d765e;
      background: #edf8f3;
      padding: 0.15rem 0.5rem;
      border-radius: 0.4rem;
    }
    .account-provider-tag.provider-cloud {
      color: #0369a1;
      background: #f0f9ff;
    }
    .provider-icon svg { width: 0.85rem; height: 0.85rem; }

    /* Status Badges */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.7rem;
      border-radius: 2rem;
      font-size: 0.78rem;
      font-weight: 700;
      white-space: nowrap;
    }
    .status-badge .status-dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
    }
    .status-connected {
      background: #ecfdf5;
      color: #047857;
      border: 1px solid #a7f3d0;
    }
    .status-connected .status-dot {
      background: #10b981;
      box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.25);
      animation: dot-pulse 2s infinite;
    }
    @keyframes dot-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.2); opacity: 0.7; }
    }
    .status-qr, .status-qr_pending, .status-created {
      background: #fff7ed;
      color: #c2410c;
      border: 1px solid #fed7aa;
    }
    .status-qr .status-dot, .status-qr_pending .status-dot, .status-created .status-dot { background: #ea580c; }
    .status-connecting {
      background: #fefce8;
      color: #a16207;
      border: 1px solid #fef08a;
    }
    .status-connecting .status-dot { background: #eab308; }
    .status-disconnected {
      background: #f1f5f9;
      color: #64748b;
      border: 1px solid #e2e8f0;
    }
    .status-disconnected .status-dot { background: #94a3b8; }
    .status-logged_out, .status-error {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
    }
    .status-logged_out .status-dot, .status-error .status-dot { background: #ef4444; }

    /* Account Card Body */
    .account-card-body {
      padding: 0.5rem 1.25rem 1rem;
      flex: 1;
    }
    .phone-display-row {
      background: #f8fafc;
      border: 1px solid #f1f5f9;
      border-radius: 0.75rem;
      padding: 0.65rem 0.85rem;
    }
    .phone-info {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .phone-label {
      font-size: 0.75rem;
      color: #64748b;
      font-weight: 500;
    }
    .phone-value-wrap {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .phone-number {
      font-size: 1.05rem;
      font-weight: 700;
      color: #1e293b;
      letter-spacing: 0.03em;
    }
    .phone-unlinked {
      font-size: 0.85rem;
      color: #dc2626;
      font-weight: 600;
    }
    .btn-copy-number {
      position: relative;
      background: transparent;
      border: none;
      padding: 0.25rem;
      cursor: pointer;
      color: #94a3b8;
      border-radius: 0.35rem;
      display: flex;
      align-items: center;
      transition: all 0.15s ease;
    }
    .btn-copy-number:hover { color: #008069; background: #e2e8f0; }
    .btn-copy-number svg { width: 0.95rem; height: 0.95rem; }
    .tooltip-copied {
      position: absolute;
      bottom: 110%;
      left: 50%;
      transform: translateX(-50%);
      background: #1e293b;
      color: white;
      font-size: 0.7rem;
      font-weight: 600;
      padding: 0.15rem 0.45rem;
      border-radius: 0.3rem;
      white-space: nowrap;
    }

    /* Account Card Actions Bar */
    .account-card-actions {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.85rem 1.25rem;
      background: #ffffff;
      border-top: 1px solid #f1f5f9;
      border-bottom-left-radius: 1.25rem;
      border-bottom-right-radius: 1.25rem;
    }
    .btn-action-primary {
      flex: 1;
      height: 2.45rem;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      border: 1px solid #bbf7d0;
      border-radius: 0.65rem;
      background: #f0fdf4;
      color: #15803d;
      font-size: 0.85rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-action-primary:hover:not(:disabled) {
      background: #16a34a;
      color: #ffffff;
      border-color: #16a34a;
    }
    .btn-action-primary:disabled { opacity: 0.6; cursor: wait; }
    .btn-action-qr {
      background: #008069;
      color: #ffffff;
      border-color: #008069;
      box-shadow: 0 2px 6px rgba(0, 128, 105, 0.2);
    }
    .btn-action-qr:hover:not(:disabled) {
      background: #006b5b;
      border-color: #006b5b;
    }
    .btn-action-primary svg { width: 1.05rem; height: 1.05rem; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .btn-action-secondary {
      height: 2.45rem;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0 0.85rem;
      border: 1px solid #e2e8f0;
      border-radius: 0.65rem;
      background: #f8fafc;
      color: #334155;
      font-size: 0.825rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-action-secondary:hover {
      background: #e2e8f0;
      color: #0f172a;
    }
    .btn-action-secondary svg { width: 1rem; height: 1rem; color: #64748b; }

    .menu-container {
      position: relative;
    }
    .btn-action-more {
      width: 2.45rem;
      height: 2.45rem;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid #e2e8f0;
      border-radius: 0.65rem;
      background: #ffffff;
      color: #64748b;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .btn-action-more:hover {
      background: #f1f5f9;
      color: #0f172a;
    }
    .btn-action-more svg { width: 1.15rem; height: 1.15rem; }

    /* Dropdown Menu */
    .dropdown-menu {
      position: absolute;
      bottom: calc(100% + 0.5rem);
      left: 0;
      z-index: 50;
      width: 14rem;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 0.75rem;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      padding: 0.4rem;
      display: flex;
      flex-direction: column;
      gap: 0.15rem;
    }
    .menu-item {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      width: 100%;
      padding: 0.55rem 0.75rem;
      border: none;
      border-radius: 0.5rem;
      background: transparent;
      color: #334155;
      font-size: 0.825rem;
      font-weight: 600;
      text-align: right;
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .menu-item:hover {
      background: #f1f5f9;
      color: #0f172a;
    }
    .menu-item svg { width: 1.05rem; height: 1.05rem; color: #64748b; flex-shrink: 0; }
    .menu-item-danger { color: #dc2626; }
    .menu-item-danger svg { color: #dc2626; }
    .menu-item-danger:hover {
      background: #fef2f2;
      color: #b91c1c;
    }
    .menu-divider {
      height: 1px;
      background: #f1f5f9;
      margin: 0.25rem 0;
    }

    /* Empty State */
    .empty-state {
      grid-column: 1 / -1;
      background: #ffffff;
      border: 1px dashed #cbd5e1;
      border-radius: 1.25rem;
      padding: 4.5rem 2rem;
      text-align: center;
    }
    .empty-icon-wrap {
      width: 4.5rem;
      height: 4.5rem;
      border-radius: 50%;
      background: #f1f5f9;
      color: #94a3b8;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.25rem;
    }
    .empty-icon-wrap svg { width: 2.25rem; height: 2.25rem; }
    .empty-state h3 { margin: 0; font-size: 1.25rem; font-weight: 700; color: #1e293b; }
    .empty-state p { margin: 0.4rem 0 1.5rem; font-size: 0.9rem; color: #64748b; max-width: 28rem; margin-inline: auto; }
    .btn-empty-add {
      padding: 0.65rem 1.5rem;
      border-radius: 0.65rem;
      background: #008069;
      color: #ffffff;
      border: none;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 128, 105, 0.25);
    }
    .btn-empty-add:hover { background: #006b5b; }

    /* Modals & Backdrop */
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(11, 20, 26, 0.6);
      backdrop-filter: blur(4px);
      display: grid;
      place-items: center;
      z-index: 100;
      padding: 1rem;
    }
    .modal {
      background: #ffffff;
      border-radius: 1.25rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
      width: 100%;
      max-width: 32rem;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      animation: modal-pop 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes modal-pop {
      from { transform: scale(0.95); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid #f1f5f9;
      background: #fafbfc;
    }
    .modal-title-wrap {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .modal-icon {
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 0.65rem;
      background: #e7f7ef;
      color: #008069;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .modal-icon svg { width: 1.3rem; height: 1.3rem; }
    .qr-icon {
      background: #008069;
      color: #ffffff;
    }
    .modal-header h2 { margin: 0; font-size: 1.15rem; font-weight: 700; color: #0f172a; }
    .modal-header p { margin: 0.15rem 0 0; font-size: 0.8rem; color: #64748b; }
    .btn-modal-close {
      background: transparent;
      border: none;
      font-size: 1.25rem;
      color: #94a3b8;
      cursor: pointer;
      padding: 0.35rem;
      border-radius: 0.4rem;
      line-height: 1;
    }
    .btn-modal-close:hover { color: #0f172a; background: #e2e8f0; }

    /* Members Modal Specifics */
    .members-modal {
      max-width: 36rem;
    }
    .add-member-bar {
      padding: 1.25rem 1.5rem;
      background: #f8fafc;
      border-bottom: 1px solid #f1f5f9;
      display: flex;
      gap: 0.75rem;
      align-items: flex-end;
      flex-wrap: wrap;
    }
    .member-field {
      flex: 1 1 10rem;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .member-field label {
      font-size: 0.8rem;
      font-weight: 600;
      color: #475569;
    }
    .member-field select {
      height: 2.45rem;
      padding: 0.35rem 0.65rem;
      border: 1px solid #cbd5e1;
      border-radius: 0.5rem;
      font-size: 0.85rem;
      background: #ffffff;
    }
    .btn-add-member-submit {
      height: 2.45rem;
      padding: 0 1rem;
      background: #008069;
      color: #ffffff;
      border: none;
      border-radius: 0.5rem;
      font-weight: 700;
      font-size: 0.85rem;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn-add-member-submit:hover { background: #006b5b; }

    .members-list-wrap {
      padding: 1.25rem 1.5rem;
      max-height: 20rem;
      overflow-y: auto;
    }
    .members-subtitle {
      margin: 0 0 0.85rem;
      font-size: 0.9rem;
      font-weight: 700;
      color: #334155;
    }
    .members-list {
      display: flex;
      flex-direction: column;
      gap: 0.65rem;
    }
    .member-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      padding: 0.65rem 0.85rem;
      border: 1px solid #f1f5f9;
      border-radius: 0.65rem;
      background: #ffffff;
    }
    .member-info {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      min-width: 0;
    }
    .member-avatar {
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 50%;
      background: #e0f2fe;
      color: #0369a1;
      font-size: 0.8rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .member-texts {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    .member-name {
      font-size: 0.875rem;
      color: #0f172a;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .member-email {
      font-size: 0.75rem;
      color: #64748b;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .member-actions {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-shrink: 0;
    }
    .level-badge {
      font-size: 0.75rem;
      font-weight: 700;
      padding: 0.2rem 0.55rem;
      border-radius: 1rem;
    }
    .level-view { background: #f1f5f9; color: #475569; }
    .level-reply { background: #dcfce7; color: #15803d; }
    .level-manage { background: #fef3c7; color: #b45309; }
    .btn-revoke-member {
      padding: 0.3rem 0.65rem;
      border: 1px solid #fecaca;
      border-radius: 0.45rem;
      background: #fff8f8;
      color: #b91c1c;
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-revoke-member:hover { background: #fee2e2; }
    .empty-members {
      padding: 1.5rem;
      text-align: center;
      color: #64748b;
      font-size: 0.85rem;
      background: #f8fafc;
      border-radius: 0.65rem;
    }

    /* QR Code Modal Specifics */
    .qr-modal {
      max-width: 25rem;
      padding-bottom: 1.25rem;
      align-items: center;
      text-align: center;
    }
    .qr-modal .modal-header {
      width: 100%;
      box-sizing: border-box;
    }
    .qr-steps {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      padding: 1rem 1.25rem 0.5rem;
      text-align: right;
      width: 100%;
      box-sizing: border-box;
    }
    .qr-step {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      font-size: 0.825rem;
      color: #334155;
    }
    .step-num {
      width: 1.35rem;
      height: 1.35rem;
      border-radius: 50%;
      background: #008069;
      color: #ffffff;
      font-size: 0.75rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .qr-code-frame {
      padding: 0.85rem;
      background: #ffffff;
      border: 2px solid #e2e8f0;
      border-radius: 1.25rem;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
      margin: 0.85rem 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .qr-image {
      display: block;
      max-width: 100%;
      height: auto;
      border-radius: 0.5rem;
    }
    .qr-footer-hint {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.45rem;
      font-size: 0.8rem;
      color: #64748b;
      margin-bottom: 1rem;
    }
    .qr-footer-hint svg { width: 0.95rem; height: 0.95rem; color: #008069; }
    .btn-dismiss-qr {
      width: calc(100% - 2.5rem);
      height: 2.65rem;
      border: 1px solid #cbd5e1;
      border-radius: 0.65rem;
      background: #f8fafc;
      color: #334155;
      font-weight: 600;
      font-size: 0.875rem;
      cursor: pointer;
    }
    .btn-dismiss-qr:hover { background: #e2e8f0; color: #0f172a; }

    /* Responsive Queries */
    @media (max-width: 768px) {
      .dashboard-header { padding: 1.15rem; }
      .header-main { flex-direction: column; align-items: stretch; gap: 1rem; }
      .header-actions { flex-direction: column; align-items: stretch; }
      .stats-pills { width: 100%; justify-content: space-between; }
      .btn-add-account { width: 100%; justify-content: center; }
      .accounts-grid { grid-template-columns: 1fr; }
      .cloud-fields-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 480px) {
      .dashboard-header { padding: 1rem; }
      .title-icon { width: 2.6rem; height: 2.6rem; border-radius: 0.75rem; }
      .title-icon svg { width: 1.35rem; height: 1.35rem; }
      .page-title { font-size: 1.25rem; }
      .account-card-header { padding: 1rem; }
      .account-card-body { padding: 0.5rem 1rem 0.85rem; }
      .account-card-actions { padding: 0.75rem 1rem; flex-wrap: wrap; }
      .btn-action-primary { flex: 1 1 100%; }
      .btn-action-secondary { flex: 1; justify-content: center; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AccountsComponent implements OnInit {
  readonly accounts = inject(AccountsStore);
  readonly usersStore = inject(UsersStore);
  readonly permissions = inject(PermissionsStore);

  readonly error = signal('');
  readonly notice = signal('');
  readonly syncingId = signal<string | null>(null);
  readonly connectingId = signal<string | null>(null);
  readonly showCreatePanel = signal(false);
  readonly activeMenuId = signal<string | null>(null);
  readonly showMembersModal = signal<string | null>(null);
  readonly copiedId = signal<string | null>(null);

  readonly presetColors = PRESET_COLORS;

  readonly createDraft = signal({
    label: '',
    color: '#008069',
    provider: 'baileys' as 'baileys' | 'cloud_api',
    phoneNumberId: '',
    wabaId: '',
    accessToken: ''
  });
  readonly createFields = form(this.createDraft);

  readonly memberDraft = signal<{ userId: string; level: AccountLevel }>({ userId: '', level: 'reply' });
  readonly memberFields = form(this.memberDraft);

  readonly totalCount = computed(() => this.accounts.accounts().length);
  readonly connectedCount = computed(() => this.accounts.accounts().filter(a => a.status === 'connected').length);
  readonly disconnectedCount = computed(() => this.accounts.accounts().filter(a => a.status !== 'connected').length);

  ngOnInit(): void {
    void this.accounts.load().catch(() => this.error.set('تعذر تحميل الأرقام.'));
    void this.usersStore.load().catch(() => {});
  }

  toggleCreatePanel(event: Event): void {
    event.stopPropagation();
    this.showCreatePanel.set(!this.showCreatePanel());
  }

  setColor(color: string): void {
    this.createDraft.update(d => ({ ...d, color }));
  }

  toggleMenu(id: string, event: Event): void {
    event.stopPropagation();
    this.activeMenuId.update(current => current === id ? null : id);
  }

  closeMenu(): void {
    this.activeMenuId.set(null);
  }

  onDocumentClick(): void {
    this.closeMenu();
  }

  onEscape(): void {
    this.closeMenu();
    this.closeMembers();
    this.accounts.closeQr();
  }

  openMembers(id: string, event: Event): void {
    event.stopPropagation();
    this.showMembersModal.set(id);
    void this.accounts.select(id).catch(() => this.error.set('تعذر تحميل أعضاء الرقم.'));
  }

  closeMembers(): void {
    this.showMembersModal.set(null);
  }

  formatStatus(status: AccountView['status']): string {
    switch (status) {
      case 'connected': return 'متصل ونشط';
      case 'qr_pending': return 'بانتظار مسح الرمز';
      case 'connecting': return 'جارٍ الاتصال…';
      case 'created': return 'تم الإنشاء';
      case 'disconnected': return 'غير متصل';
      case 'logged_out': return 'تم تسجيل الخروج';
      case 'error': return 'خطأ في الاتصال';
      default: return status;
    }
  }

  formatLevel(level: AccountLevel): string {
    switch (level) {
      case 'view': return 'عرض فقط';
      case 'reply': return 'رد ومراسلة';
      case 'manage': return 'إدارة كاملة';
      default: return level;
    }
  }

  getUserName(userId: string): string {
    const user = this.usersStore.users().find(u => u._id === userId);
    return user ? user.name : `مستخدم (${userId.slice(-6)})`;
  }

  getUserEmail(userId: string): string {
    const user = this.usersStore.users().find(u => u._id === userId);
    return user ? user.email : '';
  }

  getUserInitials(userId: string): string {
    const name = this.getUserName(userId);
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  copyNumber(phoneNumber: string, accountId: string, event: Event): void {
    event.stopPropagation();
    if (!phoneNumber) return;
    navigator.clipboard.writeText(phoneNumber).then(() => {
      this.copiedId.set(accountId);
      setTimeout(() => {
        if (this.copiedId() === accountId) this.copiedId.set(null);
      }, 2000);
    }).catch(() => {});
  }

  async create(event: Event): Promise<void> {
    event.preventDefault();
    const draft = this.createDraft();
    const parsed = createAccountSchema.safeParse({
      label: draft.label,
      color: draft.color,
      provider: draft.provider,
      cloud: draft.provider === 'cloud_api' ? {
        phoneNumberId: draft.phoneNumberId,
        wabaId: draft.wabaId,
        accessToken: draft.accessToken
      } : undefined
    });
    if (!parsed.success) {
      this.error.set('يرجى التحقق من صحة بيانات الرقم المدخلة.');
      return;
    }
    try {
      await this.accounts.create(parsed.data);
      this.createDraft.set({
        label: '',
        color: '#008069',
        provider: 'baileys',
        phoneNumberId: '',
        wabaId: '',
        accessToken: ''
      });
      this.showCreatePanel.set(false);
      this.error.set('');
      this.notice.set('تمت إضافة رقم الواتساب بنجاح! يمكنك الآن مسح الرمز لربطه.');
    } catch {
      this.error.set('تعذر إضافة الرقم، يرجى المحاولة مجدداً.');
    }
  }

  async handleQrConnect(id: string): Promise<void> {
    this.connectingId.set(id);
    this.error.set('');
    try {
      const existing = await this.accounts.getQr(id);
      if (existing) return;
      await this.accounts.operation(id, 'connect');
      this.notice.set('جارٍ تشغيل الجلسة وتوليد رمز QR للربط... انتظر لحظات.');
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 2000));
        if (this.accounts.qr()?.accountId === id) return;
        const qr = await this.accounts.getQr(id);
        if (qr) return;
      }
    } catch {
      this.error.set('تعذر طلب رمز QR. تأكد من عمل الخادم وحاول مجدداً.');
    } finally {
      this.connectingId.set(null);
    }
  }

  async operate(id: string, kind: 'connect' | 'disconnect' | 'logout'): Promise<void> {
    try {
      await this.accounts.operation(id, kind);
      this.error.set('');
      if (kind === 'disconnect') this.notice.set('تم فصل الرقم مؤقتاً.');
      if (kind === 'logout') this.notice.set('تم تسجيل الخروج من جلسة واتساب.');
    } catch {
      this.error.set('تعذر تغيير حالة الرقم.');
    }
  }

  async syncHistory(id: string): Promise<void> {
    this.syncingId.set(id);
    this.notice.set('');
    try {
      await this.accounts.syncHistory(id);
      this.error.set('');
      this.notice.set('أُرسل طلب جلب الرسائل الأقدم للمحادثات المعروفة. ستظهر الرسائل التي يتيحها واتساب تدريجيًا.');
    } catch {
      this.error.set('تعذر طلب سجل الرسائل. تأكد من اتصال الرقم ثم حاول مجدداً.');
    } finally {
      this.syncingId.set(null);
    }
  }

  async clearChats(account: AccountView): Promise<void> {
    if (!window.confirm(`سيتم حذف محادثات ورسائل الرقم «${account.label}» من Hala CRM، ثم تسجيل خروجه وطلب ربط جديد. هل تريد المتابعة؟`)) return;
    this.syncingId.set(account._id);
    this.notice.set('');
    try {
      await this.accounts.clearChats(account._id);
      this.notice.set('حُذفت المحادثات وبدأ ربط الرقم من جديد. امسح رمز QR الذي يظهر.');
      this.error.set('');
    } catch {
      this.error.set('تعذر مسح المحادثات أو إعادة تشغيل الربط.');
    } finally {
      this.syncingId.set(null);
    }
  }

  async setMember(event: Event, id: string): Promise<void> {
    event.preventDefault();
    const { userId, level } = this.memberDraft();
    if (!/^[0-9a-f]{24}$/i.test(userId)) {
      this.error.set('يرجى اختيار مستخدم صحيح.');
      return;
    }
    try {
      await this.accounts.setMember(id, userId, level);
      this.memberDraft.set({ userId: '', level: 'reply' });
      this.error.set('');
      this.notice.set('تم تحديث صلاحية العضو بنجاح.');
    } catch {
      this.error.set('تعذر حفظ صلاحية العضو.');
    }
  }

  async removeMember(id: string, userId: string): Promise<void> {
    try {
      await this.accounts.removeMember(id, userId);
      this.error.set('');
      this.notice.set('تم سحب صلاحية العضو.');
    } catch {
      this.error.set('تعذر سحب العضوية.');
    }
  }

  async remove(account: AccountView): Promise<void> {
    if (!window.confirm(`سيُحذف الرقم «${account.label}» وجميع محادثاته ورسائله نهائياً من Hala CRM. هل أنت متأكد؟`)) return;
    try {
      await this.accounts.remove(account._id);
      this.error.set('');
      this.notice.set(`تم حذف الرقم «${account.label}» بنجاح.`);
    } catch {
      this.error.set('تعذر حذف الرقم.');
    }
  }
}
