import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CallHistoryStore } from '../inbox/call-history.store';
import { AccountsStore } from '../accounts/accounts.store';
import { type CallView } from '@hala/shared';

type CallFilter = 'all' | 'missed' | 'in' | 'out' | 'video';

@Component({
  selector: 'hala-calls',
  imports: [RouterLink],
  template: `
    <section class="calls-page" dir="rtl">
      <!-- Header & Stats Bar -->
      <header class="page-header">
        <div class="header-main">
          <div class="header-title-wrap">
            <div class="title-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
              </svg>
            </div>
            <div>
              <div class="title-with-badge">
                <h1 class="page-title">سجل المكالمات</h1>
                <span class="count-badge">{{ callsStore.items().length }} مكالمة</span>
              </div>
              <p class="page-subtitle">متابعة كافة المكالمات الواردة، الصادرة والفائتة عبر أرقام واتساب</p>
            </div>
          </div>

          <div class="header-controls">
            <!-- Search Input -->
            <div class="search-box">
              <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
              </svg>
              <input
                type="text"
                placeholder="البحث بالاسم أو الرقم..."
                [value]="searchQuery()"
                (input)="onSearchInput($event)"
                class="search-input"
              />
              @if (searchQuery()) {
                <button type="button" class="btn-clear-search" (click)="searchQuery.set('')" aria-label="مسح البحث">×</button>
              }
            </div>

            <!-- WhatsApp Account Filter -->
            <div class="select-wrapper">
              <select class="account-select" [value]="selectedAccountId()" (change)="onAccountChange($event)">
                <option value="">جميع الأرقام ({{ accountsStore.accounts().length }})</option>
                @for (acc of accountsStore.accounts(); track acc._id) {
                  <option [value]="acc._id">{{ acc.label }} ({{ acc.phoneNumber ?? 'بدون رقم' }})</option>
                }
              </select>
            </div>

            <!-- Refresh Button -->
            <button
              type="button"
              class="btn-refresh"
              (click)="refresh()"
              [disabled]="callsStore.loading()"
              title="تحديث سجل المكالمات"
            >
              <svg [class.spin]="callsStore.loading()" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                <path d="M3 3v5h5"/>
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/>
                <path d="M16 21h5v-5"/>
              </svg>
              <span>تحديث</span>
            </button>
          </div>
        </div>

        <!-- Filter Chips Bar -->
        <nav class="filter-chips" aria-label="فلترة المكالمات">
          <button
            type="button"
            class="chip"
            [class.active]="activeFilter() === 'all'"
            (click)="setFilter('all')"
          >
            <span>الكل</span>
            <span class="chip-count">{{ stats().total }}</span>
          </button>

          <button
            type="button"
            class="chip chip-missed"
            [class.active]="activeFilter() === 'missed'"
            (click)="setFilter('missed')"
          >
            <span class="status-dot dot-missed"></span>
            <span>لم يُرد عليها / فائتة</span>
            <span class="chip-count">{{ stats().missed }}</span>
          </button>

          <button
            type="button"
            class="chip chip-in"
            [class.active]="activeFilter() === 'in'"
            (click)="setFilter('in')"
          >
            <span class="status-dot dot-in"></span>
            <span>واردة مكتملة</span>
            <span class="chip-count">{{ stats().incoming }}</span>
          </button>

          <button
            type="button"
            class="chip chip-out"
            [class.active]="activeFilter() === 'out'"
            (click)="setFilter('out')"
          >
            <span class="status-dot dot-out"></span>
            <span>صادرة</span>
            <span class="chip-count">{{ stats().outgoing }}</span>
          </button>

          <button
            type="button"
            class="chip chip-video"
            [class.active]="activeFilter() === 'video'"
            (click)="setFilter('video')"
          >
            <span class="status-dot dot-video"></span>
            <span>مكالمات فيديو</span>
            <span class="chip-count">{{ stats().video }}</span>
          </button>
        </nav>
      </header>

      <!-- Content Area -->
      <main class="page-content">
        @if (callsStore.error(); as error) {
          <div class="alert-box error" role="alert">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <div>
              <strong>تعذر تحميل سجل المكالمات</strong>
              <p>{{ error }}</p>
            </div>
            <button type="button" class="btn-retry" (click)="refresh()">إعادة المحاولة</button>
          </div>
        }

        @if (callsStore.loading() && !callsStore.items().length) {
          <!-- Loading Skeletons -->
          <div class="calls-grid">
            @for (i of [1, 2, 3, 4, 5, 6]; track i) {
              <div class="call-card skeleton-card">
                <div class="skeleton-header"></div>
                <div class="skeleton-body">
                  <div class="skeleton-avatar"></div>
                  <div class="skeleton-lines">
                    <div class="skeleton-line long"></div>
                    <div class="skeleton-line short"></div>
                  </div>
                </div>
                <div class="skeleton-footer"></div>
              </div>
            }
          </div>
        } @else {
          <!-- Calls Grid -->
          <div class="calls-grid">
            @for (call of filteredCalls(); track call._id) {
              <article class="call-card" [class.missed-border]="isMissed(call)">
                <!-- Card Header: Status, Media Type & Date -->
                <div class="card-header">
                  <div class="call-status-badge" [class]="getStatusClass(call)">
                    <span class="status-icon" [innerHTML]="getStatusIcon(call)"></span>
                    <span class="status-text">{{ getStatusLabel(call) }}</span>
                  </div>

                  <div class="header-meta">
                    <span class="media-badge" [class.is-video]="call.isVideo">
                      @if (call.isVideo) {
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                        </svg>
                        <span>فيديو</span>
                      } @else {
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                        </svg>
                        <span>صوت</span>
                      }
                    </span>
                    <time class="call-time" [title]="call.startedAt">{{ formatRelativeTime(call.startedAt) }}</time>
                  </div>
                </div>

                <!-- Card Body: Contact Info & Account Details -->
                <div class="card-body">
                  <div class="contact-info-row">
                    <div class="contact-avatar" [style.background]="getAvatarColor(call)">
                      {{ getInitials(call) }}
                    </div>

                    <div class="contact-details">
                      <h2 class="contact-name" [title]="getContactName(call)">
                        {{ getContactName(call) }}
                      </h2>

                      @if (getContactPhone(call); as phone) {
                        <div class="phone-row">
                          <span class="phone-number" dir="ltr">{{ phone }}</span>
                          <button
                            type="button"
                            class="btn-copy-phone"
                            (click)="copyPhone(phone, call._id)"
                            [title]="copiedId() === call._id ? 'تم النسخ!' : 'نسخ رقم الهاتف'"
                          >
                            @if (copiedId() === call._id) {
                              <svg class="text-emerald" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <polyline points="20 6 9 17 4 12"/>
                              </svg>
                              <span class="copied-tooltip">تم النسخ</span>
                            } @else {
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                              </svg>
                            }
                          </button>
                        </div>
                      }
                    </div>
                  </div>

                  <!-- Details Pill Row (Account & Duration) -->
                  <div class="call-meta-bar">
                    <!-- WhatsApp Account Badge -->
                    <div class="account-tag" [title]="'رقم واتساب: ' + getAccountLabel(call)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                      </svg>
                      <span class="account-text">{{ getAccountLabel(call) }}</span>
                    </div>

                    <!-- Call Duration -->
                    <div class="duration-tag" [class.duration-missed]="isMissed(call)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                      </svg>
                      <span>{{ formatDuration(call) }}</span>
                    </div>
                  </div>

                  <!-- Exact Time Display -->
                  <div class="exact-time-row">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                    </svg>
                    <span>{{ formatCallTime(call.startedAt) }}</span>
                  </div>
                </div>

                <!-- Card Footer: Quick Actions -->
                <div class="card-footer">
                  <a
                    [routerLink]="getChatRoute(call)"
                    class="btn-open-chat"
                    title="فتح المحادثة والرسائل"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                    </svg>
                    <span>فتح المحادثة</span>
                  </a>

                  @if (getContactPhone(call); as phone) {
                    <a
                      [href]="'https://wa.me/' + cleanPhone(phone)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="btn-wa-link"
                      title="فتح في تطبيق واتساب مباشرة"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981z"/>
                      </svg>
                      <span>واتساب</span>
                    </a>
                  }
                </div>
              </article>
            } @empty {
              <div class="empty-state">
                <div class="empty-icon-wrap">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                </div>
                <h3>لا توجد مكالمات مطابقة</h3>
                <p>
                  @if (searchQuery() || selectedAccountId() || activeFilter() !== 'all') {
                    لم يتم العثور على أي نتائج وفقاً للفلاتر المحددة حالياً.
                  } @else {
                    لم يتم تسجيل أي مكالمات حتى الآن على هذا الحساب.
                  }
                </p>
                @if (searchQuery() || selectedAccountId() || activeFilter() !== 'all') {
                  <button type="button" class="btn-reset-filters" (click)="resetFilters()">إعادة ضبط الفلاتر</button>
                }
              </div>
            }
          </div>
        }
      </main>
    </section>
  `,
  styles: [`
    :host { display: block; width: 100%; box-sizing: border-box; }
    .calls-page { max-width: 1380px; margin: 0 auto; padding: 1.5rem 1rem; color: #1e293b; font-family: inherit; }

    /* Page Header */
    .page-header { background: #ffffff; border-radius: 1.25rem; border: 1px solid #e2e8f0; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 4px 16px rgba(18, 62, 53, 0.05); }
    .header-main { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1.25rem; margin-bottom: 1.25rem; }
    .header-title-wrap { display: flex; align-items: center; gap: 1rem; }
    .title-icon { width: 3.25rem; height: 3.25rem; border-radius: 1rem; background: linear-gradient(135deg, #123e35 0%, #008069 100%); color: white; display: flex; align-items: center; justify-content: center; flex-shrink: 0; box-shadow: 0 4px 12px rgba(0, 128, 105, 0.25); }
    .title-icon svg { width: 1.75rem; height: 1.75rem; }
    .title-with-badge { display: flex; align-items: center; gap: 0.75rem; }
    .page-title { margin: 0; font-size: 1.6rem; font-weight: 800; color: #0f172a; }
    .count-badge { font-size: 0.8rem; font-weight: 700; color: #047857; background: #d1fae5; padding: 0.2rem 0.65rem; border-radius: 9999px; }
    .page-subtitle { margin: 0.25rem 0 0; font-size: 0.9rem; color: #64748b; }

    /* Controls */
    .header-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; }
    .search-box { position: relative; min-width: 16rem; }
    .search-icon { position: absolute; inset-inline-start: 0.85rem; top: 50%; transform: translateY(-50%); width: 1.15rem; height: 1.15rem; color: #94a3b8; pointer-events: none; }
    .search-input { width: 100%; box-sizing: border-box; padding: 0.6rem 0.85rem 0.6rem 2.4rem; border: 1px solid #cbd5e1; border-radius: 0.75rem; font-size: 0.9rem; background: #f8fafc; transition: all 0.2s ease; outline: none; }
    .search-input:focus { border-color: #00a884; background: #ffffff; box-shadow: 0 0 0 3px rgba(0, 168, 132, 0.15); }
    .btn-clear-search { position: absolute; inset-inline-end: 0.65rem; top: 50%; transform: translateY(-50%); background: #e2e8f0; border: none; width: 1.35rem; height: 1.35rem; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #475569; font-size: 0.95rem; line-height: 1; }

    .select-wrapper { min-width: 12rem; }
    .account-select { width: 100%; padding: 0.6rem 0.85rem; border: 1px solid #cbd5e1; border-radius: 0.75rem; font-size: 0.875rem; background: #f8fafc; color: #1e293b; outline: none; cursor: pointer; transition: all 0.2s ease; }
    .account-select:focus { border-color: #00a884; background: #ffffff; box-shadow: 0 0 0 3px rgba(0, 168, 132, 0.15); }

    .btn-refresh { display: inline-flex; align-items: center; gap: 0.45rem; padding: 0.6rem 1.1rem; border-radius: 0.75rem; background: #008069; color: white; border: none; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 2px 8px rgba(0, 128, 105, 0.2); }
    .btn-refresh:hover:not(:disabled) { background: #006c59; transform: translateY(-1px); }
    .btn-refresh:disabled { opacity: 0.7; cursor: not-allowed; }
    .btn-refresh svg { width: 1.1rem; height: 1.1rem; }
    .spin { animation: spin 1s linear infinite; }
    @keyframes spin { 100% { transform: rotate(360deg); } }

    /* Filter Chips */
    .filter-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; padding-top: 1rem; border-top: 1px solid #f1f5f9; }
    .chip { display: inline-flex; align-items: center; gap: 0.45rem; padding: 0.45rem 0.95rem; border-radius: 9999px; background: #f1f5f9; border: 1px solid #e2e8f0; color: #475569; font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: all 0.15s ease; }
    .chip:hover { background: #e2e8f0; color: #1e293b; }
    .chip.active { background: #123e35; color: #ffffff; border-color: #123e35; box-shadow: 0 2px 8px rgba(18, 62, 53, 0.25); }
    .chip-count { font-size: 0.75rem; padding: 0.1rem 0.45rem; border-radius: 9999px; background: rgba(0, 0, 0, 0.08); font-weight: 700; }
    .chip.active .chip-count { background: rgba(255, 255, 255, 0.25); color: #ffffff; }

    .status-dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; }
    .dot-missed { background: #ef4444; }
    .dot-in { background: #10b981; }
    .dot-out { background: #3b82f6; }
    .dot-video { background: #8b5cf6; }

    /* Alerts */
    .alert-box { display: flex; align-items: center; gap: 1rem; padding: 1rem 1.25rem; border-radius: 1rem; margin-bottom: 1.5rem; }
    .alert-box.error { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
    .alert-box svg { width: 1.5rem; height: 1.5rem; flex-shrink: 0; }
    .alert-box strong { display: block; font-size: 0.95rem; }
    .alert-box p { margin: 0.2rem 0 0; font-size: 0.85rem; }
    .btn-retry { margin-inline-start: auto; padding: 0.4rem 0.85rem; border-radius: 0.5rem; background: #dc2626; color: white; border: none; font-size: 0.85rem; font-weight: 600; cursor: pointer; }

    /* Grid */
    .calls-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 1.25rem; }

    /* Call Card */
    .call-card { background: #ffffff; border-radius: 1.15rem; border: 1px solid #e2e8f0; display: flex; flex-direction: column; overflow: hidden; transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03); }
    .call-card:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(18, 62, 53, 0.08); border-color: #cbd5e1; }
    .call-card.missed-border { border-inline-start: 4px solid #ef4444; }

    /* Card Header */
    .card-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.9rem 1.15rem; background: #fafbfc; border-bottom: 1px solid #f1f5f9; }
    .call-status-badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.25rem 0.65rem; border-radius: 9999px; font-size: 0.78rem; font-weight: 700; }
    .call-status-badge .status-icon { display: flex; align-items: center; justify-content: center; width: 0.95rem; height: 0.95rem; }
    .call-status-badge .status-icon svg { width: 100%; height: 100%; }

    .status-badge-missed { background: #fee2e2; color: #b91c1c; }
    .status-badge-rejected { background: #ffe4e6; color: #be123c; }
    .status-badge-in { background: #dcfce7; color: #15803d; }
    .status-badge-out { background: #dbeafe; color: #1d4ed8; }
    .status-badge-ringing { background: #fef3c7; color: #b45309; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }

    .header-meta { display: flex; align-items: center; gap: 0.6rem; }
    .media-badge { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.72rem; font-weight: 600; color: #64748b; background: #f1f5f9; padding: 0.2rem 0.5rem; border-radius: 0.4rem; }
    .media-badge svg { width: 0.85rem; height: 0.85rem; }
    .media-badge.is-video { background: #f3e8ff; color: #7e22ce; }
    .call-time { font-size: 0.78rem; color: #64748b; font-weight: 500; }

    /* Card Body */
    .card-body { padding: 1.15rem; flex: 1; display: flex; flex-direction: column; gap: 0.85rem; }
    .contact-info-row { display: flex; align-items: center; gap: 0.85rem; }
    .contact-avatar { width: 3rem; height: 3rem; border-radius: 50%; color: white; display: flex; align-items: center; justify-content: center; font-size: 1.05rem; font-weight: 700; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.12); }
    .contact-details { min-width: 0; flex: 1; }
    .contact-name { margin: 0; font-size: 1rem; font-weight: 700; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .phone-row { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.25rem; }
    .phone-number { font-size: 0.82rem; font-weight: 600; color: #475569; letter-spacing: 0.02em; }
    .btn-copy-phone { background: none; border: none; padding: 0.2rem; cursor: pointer; color: #94a3b8; border-radius: 0.35rem; display: flex; align-items: center; position: relative; transition: all 0.15s ease; }
    .btn-copy-phone:hover { color: #008069; background: #f0fdf4; }
    .btn-copy-phone svg { width: 0.95rem; height: 0.95rem; }
    .text-emerald { color: #059669; }
    .copied-tooltip { position: absolute; bottom: 100%; inset-inline-start: 50%; transform: translateX(-50%); background: #1e293b; color: white; font-size: 0.7rem; font-weight: 600; padding: 0.15rem 0.45rem; border-radius: 0.3rem; white-space: nowrap; pointer-events: none; }

    /* Meta bar */
    .call-meta-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; background: #f8fafc; padding: 0.45rem 0.75rem; border-radius: 0.65rem; border: 1px solid #f1f5f9; }
    .account-tag { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; font-weight: 600; color: #334155; min-width: 0; }
    .account-tag svg { width: 0.85rem; height: 0.85rem; color: #008069; flex-shrink: 0; }
    .account-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .duration-tag { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.78rem; font-weight: 700; color: #059669; background: #ecfdf5; padding: 0.15rem 0.5rem; border-radius: 0.4rem; }
    .duration-tag svg { width: 0.85rem; height: 0.85rem; }
    .duration-tag.duration-missed { color: #dc2626; background: #fef2f2; }

    .exact-time-row { display: flex; align-items: center; gap: 0.35rem; font-size: 0.78rem; color: #64748b; }
    .exact-time-row svg { width: 0.85rem; height: 0.85rem; color: #94a3b8; }

    /* Card Footer */
    .card-footer { display: flex; align-items: center; gap: 0.65rem; padding: 0.85rem 1.15rem; background: #ffffff; border-top: 1px solid #f1f5f9; }
    .btn-open-chat { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 0.45rem; padding: 0.55rem 0.85rem; border-radius: 0.65rem; background: #008069; color: #ffffff; text-decoration: none; font-size: 0.85rem; font-weight: 700; transition: all 0.15s ease; box-shadow: 0 2px 6px rgba(0, 128, 105, 0.2); }
    .btn-open-chat:hover { background: #006c59; transform: translateY(-1px); }
    .btn-open-chat svg { width: 1.05rem; height: 1.05rem; }

    .btn-wa-link { display: inline-flex; align-items: center; justify-content: center; gap: 0.35rem; padding: 0.55rem 0.75rem; border-radius: 0.65rem; background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; text-decoration: none; font-size: 0.82rem; font-weight: 600; transition: all 0.15s ease; }
    .btn-wa-link:hover { background: #16a34a; color: white; border-color: #16a34a; }
    .btn-wa-link svg { width: 1rem; height: 1rem; }

    /* Empty state */
    .empty-state { grid-column: 1 / -1; background: #ffffff; border-radius: 1.25rem; border: 1px dashed #cbd5e1; padding: 4rem 2rem; text-align: center; }
    .empty-icon-wrap { width: 4.5rem; height: 4.5rem; border-radius: 50%; background: #f1f5f9; color: #94a3b8; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.25rem; }
    .empty-icon-wrap svg { width: 2.25rem; height: 2.25rem; }
    .empty-state h3 { margin: 0; font-size: 1.25rem; font-weight: 700; color: #1e293b; }
    .empty-state p { margin: 0.4rem 0 1.25rem; font-size: 0.9rem; color: #64748b; }
    .btn-reset-filters { padding: 0.55rem 1.25rem; border-radius: 0.65rem; background: #123e35; color: white; border: none; font-size: 0.875rem; font-weight: 600; cursor: pointer; transition: all 0.15s ease; }
    .btn-reset-filters:hover { background: #008069; }

    /* Skeletons */
    .skeleton-card { border-color: #f1f5f9; }
    .skeleton-header { height: 2.5rem; background: #f8fafc; }
    .skeleton-body { padding: 1.15rem; display: flex; gap: 0.85rem; align-items: center; }
    .skeleton-avatar { width: 3rem; height: 3rem; border-radius: 50%; background: #e2e8f0; animation: pulse 1.5s infinite; }
    .skeleton-lines { flex: 1; display: flex; flex-direction: column; gap: 0.5rem; }
    .skeleton-line { height: 0.85rem; border-radius: 0.25rem; background: #e2e8f0; animation: pulse 1.5s infinite; }
    .skeleton-line.long { width: 75%; }
    .skeleton-line.short { width: 45%; }
    .skeleton-footer { height: 3rem; background: #f8fafc; border-top: 1px solid #f1f5f9; }

    @media (max-width: 768px) {
      .calls-page { padding: 1rem 0.5rem; }
      .header-main { flex-direction: column; align-items: stretch; }
      .header-controls { flex-direction: column; align-items: stretch; }
      .search-box, .select-wrapper { width: 100%; min-width: 0; }
      .btn-refresh { justify-content: center; }
      .calls-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 640px) {
      .page-header {
        padding: 1rem;
        border-radius: 1rem;
        margin-bottom: 1rem;
      }
      .header-title-wrap {
        gap: 0.75rem;
      }
      .title-icon {
        width: 2.6rem;
        height: 2.6rem;
        border-radius: 0.75rem;
      }
      .title-icon svg {
        width: 1.35rem;
        height: 1.35rem;
      }
      .page-title {
        font-size: 1.25rem;
      }
      .filter-chips {
        flex-wrap: nowrap;
        overflow-x: auto;
        padding-bottom: 0.4rem;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
      }
      .filter-chips::-webkit-scrollbar {
        display: none;
      }
      .chip {
        flex-shrink: 0;
        padding: 0.35rem 0.75rem;
        font-size: 0.8rem;
      }
      .card-header {
        padding: 0.75rem 1rem;
      }
      .card-body {
        padding: 1rem;
      }
      .card-footer {
        padding: 0.75rem 1rem;
        flex-wrap: wrap;
      }
      .btn-wa-link {
        flex: 1;
      }
    }
    @media (max-width: 420px) {
      .call-meta-bar {
        flex-direction: column;
        align-items: flex-start;
        gap: 0.4rem;
      }
      .account-tag {
        max-width: 100%;
      }
      .contact-avatar {
        width: 2.5rem;
        height: 2.5rem;
        font-size: 0.95rem;
      }
      .contact-name {
        font-size: 0.95rem;
      }
      .phone-number {
        font-size: 0.78rem;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class CallsComponent {
  readonly callsStore = inject(CallHistoryStore);
  readonly accountsStore = inject(AccountsStore);

  readonly searchQuery = signal<string>('');
  readonly selectedAccountId = signal<string>('');
  readonly activeFilter = signal<CallFilter>('all');
  readonly copiedId = signal<string | null>(null);

  constructor() {
    void this.callsStore.load();
    void this.accountsStore.load();
  }

  readonly stats = computed(() => {
    const all = this.callsStore.items();
    let missed = 0;
    let incoming = 0;
    let outgoing = 0;
    let video = 0;

    for (const call of all) {
      if (call.status === 'missed' || call.status === 'rejected') {
        missed++;
      } else if (call.direction === 'in') {
        incoming++;
      } else if (call.direction === 'out') {
        outgoing++;
      }
      if (call.isVideo) {
        video++;
      }
    }

    return { total: all.length, missed, incoming, outgoing, video };
  });

  readonly filteredCalls = computed(() => {
    let list = this.callsStore.items();
    const query = this.searchQuery().trim().toLowerCase();
    const accountId = this.selectedAccountId();
    const filter = this.activeFilter();

    // Filter by WhatsApp account
    if (accountId) {
      list = list.filter(call => call.accountId === accountId);
    }

    // Filter by type / status
    if (filter === 'missed') {
      list = list.filter(call => call.status === 'missed' || call.status === 'rejected');
    } else if (filter === 'in') {
      list = list.filter(call => call.direction === 'in' && call.status !== 'missed' && call.status !== 'rejected');
    } else if (filter === 'out') {
      list = list.filter(call => call.direction === 'out');
    } else if (filter === 'video') {
      list = list.filter(call => call.isVideo);
    }

    // Filter by search query
    if (query) {
      list = list.filter(call => {
        const contactName = this.getContactName(call).toLowerCase();
        const contactPhone = this.getContactPhone(call).toLowerCase();
        const accountLabel = this.getAccountLabel(call).toLowerCase();
        return contactName.includes(query) || contactPhone.includes(query) || accountLabel.includes(query);
      });
    }

    return list;
  });

  refresh(): void {
    void this.callsStore.load();
    void this.accountsStore.load();
  }

  setFilter(filter: CallFilter): void {
    this.activeFilter.set(filter);
  }

  resetFilters(): void {
    this.searchQuery.set('');
    this.selectedAccountId.set('');
    this.activeFilter.set('all');
  }

  onSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.searchQuery.set(target.value);
  }

  onAccountChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.selectedAccountId.set(target.value);
  }

  isMissed(call: CallView): boolean {
    return call.status === 'missed' || call.status === 'rejected';
  }

  getStatusClass(call: CallView): string {
    if (call.status === 'missed') return 'status-badge-missed';
    if (call.status === 'rejected') return 'status-badge-rejected';
    if (call.status === 'ringing') return 'status-badge-ringing';
    if (call.direction === 'in') return 'status-badge-in';
    return 'status-badge-out';
  }

  getStatusLabel(call: CallView): string {
    if (call.status === 'missed') return 'مكالمة فائتة';
    if (call.status === 'rejected') return 'مكالمة مرفوضة';
    if (call.status === 'ringing') return 'جاري الاتصال...';
    if (call.direction === 'in') return 'مكالمة واردة';
    return 'مكالمة صادرة';
  }

  getStatusIcon(call: CallView): string {
    if (call.status === 'missed' || call.status === 'rejected') {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    }
    if (call.status === 'ringing') {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
    }
    if (call.direction === 'in') {
      return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="17 6 7 16"/><polyline points="7 6 7 16 17 16"/></svg>`;
    }
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="7 18 17 8"/><polyline points="7 8 17 8 17 18"/></svg>`;
  }

  getContactName(call: CallView): string {
    if (call.contact?.displayName) return call.contact.displayName;
    if (call.contact?.pushName) return call.contact.pushName;
    if (call.contact?.phoneE164) return call.contact.phoneE164;
    if (call.contact?.waId) return call.contact.waId.replace(/@.*$/, '');
    return 'جهة اتصال غير معروفة';
  }

  getContactPhone(call: CallView): string {
    if (call.contact?.phoneE164) return call.contact.phoneE164;
    if (call.contact?.waId) return call.contact.waId.replace(/@.*$/, '');
    return '';
  }

  cleanPhone(phone: string): string {
    return phone.replace(/[^0-9]/g, '');
  }

  getAccountLabel(call: CallView): string {
    if (call.account?.label) {
      return call.account.phoneNumber ? `${call.account.label} (${call.account.phoneNumber})` : call.account.label;
    }
    const found = this.accountsStore.accounts().find(a => a._id === call.accountId);
    if (found) {
      return found.phoneNumber ? `${found.label} (${found.phoneNumber})` : found.label;
    }
    return 'رقم واتساب';
  }

  getInitials(call: CallView): string {
    const name = this.getContactName(call);
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  getAvatarColor(call: CallView): string {
    const colors = ['#008069', '#0d9488', '#0284c7', '#6366f1', '#8b5cf6', '#d97706', '#dc2626'];
    const name = this.getContactName(call);
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colors.length;
    return colors[index] || '#008069';
  }

  formatCallTime(isoString: string): string {
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return isoString;
      return d.toLocaleDateString('ar-EG', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return isoString;
    }
  }

  formatRelativeTime(isoString: string): string {
    try {
      const d = new Date(isoString);
      const diffMs = Date.now() - d.getTime();
      const diffSec = Math.floor(diffMs / 1000);
      if (diffSec < 60) return 'الآن';
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) return `منذ ${diffMin} دقيقة`;
      const diffHours = Math.floor(diffMin / 60);
      if (diffHours < 24) return `منذ ${diffHours} ساعة`;
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays === 1) return 'أمس';
      if (diffDays < 7) return `منذ ${diffDays} أيام`;
      return d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
    } catch {
      return '';
    }
  }

  formatDuration(call: CallView): string {
    if (call.status === 'missed') return 'لم يتم الرد';
    if (call.status === 'rejected') return 'تم الرفض';
    if (call.status === 'ringing') return 'جاري الاتصال...';
    if (!call.endedAt) return call.status === 'accepted' ? 'جارية...' : 'مكتملة';
    try {
      const start = new Date(call.startedAt).getTime();
      const end = new Date(call.endedAt).getTime();
      const diffSec = Math.max(0, Math.round((end - start) / 1000));
      if (diffSec < 60) return `${diffSec} ثانية`;
      const mins = Math.floor(diffSec / 60);
      const secs = diffSec % 60;
      return `${mins}:${secs < 10 ? '0' : ''}${secs} دقيقة`;
    } catch {
      return 'مكتملة';
    }
  }

  getChatRoute(call: CallView): string[] {
    if (call.conversationId) {
      return ['/inbox', call.conversationId];
    }
    return ['/inbox'];
  }

  copyPhone(phone: string, callId: string): void {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(phone);
      this.copiedId.set(callId);
      setTimeout(() => {
        if (this.copiedId() === callId) {
          this.copiedId.set(null);
        }
      }, 2000);
    }
  }
}
