import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  OnInit,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { contactPhoneNumber, type CallView, type ConversationView, type MessageSearchResultView } from '@hala/shared';
import { InboxStore, type FilterTab } from './inbox.store';
import { CallHistoryStore } from './call-history.store';
import { MessagesStore } from './messages.store';
import { MediaPreviewComponent } from './media-preview.component';
import { AccountsStore } from '../accounts/accounts.store';
import { ComposerComponent } from './composer.component';
import { ContactAvatarComponent } from './contact-avatar.component';
import { EmojiPickerComponent } from './emoji-picker.component';
import { ComposerStore } from './composer.store';
import { PermissionsStore } from '../../core/permissions.store';
import { RealtimeService } from '../../core/realtime.service';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { type MessageView, subject } from '@hala/shared';
import { FormField, form, required } from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { DatePipe } from '@angular/common';
import { closeMessageNotifications } from '../../core/message-notification.client';
import {
  conversationPreview,
  conversationTimeFormat,
  messageDayKey,
  messageDayLabel,
  messageStatusLabel,
  messageTypeLabel,
  missingMessageContent,
  visibleMessages,
} from './message-display';

type TimelineContentEntry = { kind: 'message'; id: string; timestamp: string; message: MessageView }
  | { kind: 'call'; id: string; timestamp: string; call: CallView };
type TimelineEntry = TimelineContentEntry
  | { kind: 'date'; id: string; timestamp: string; label: string; firstInTimeline: boolean };

function fallbackAccountColor(id: string): string {
  const colors = ['#008069', '#0284c7', '#9333ea', '#d97706', '#db2777', '#4f46e5'];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return colors[(hash >>> 0) % colors.length]!;
}

export function getTagColor(tag: string): { bg: string; text: string; border: string } {
  const palettes = [
    { bg: '#e0f2fe', text: '#0369a1', border: '#bae6fd' },
    { bg: '#dcfce7', text: '#15803d', border: '#bbf7d0' },
    { bg: '#fef3c7', text: '#b45309', border: '#fde68a' },
    { bg: '#f3e8ff', text: '#7e22ce', border: '#e9d5ff' },
    { bg: '#ffe4e6', text: '#be123c', border: '#fecdd3' },
    { bg: '#ccfbf1', text: '#0f766e', border: '#99f6e4' },
    { bg: '#ffedd5', text: '#c2410c', border: '#fed7aa' },
  ];
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = (hash << 5) - hash + tag.charCodeAt(i);
  return palettes[Math.abs(hash) % palettes.length] ?? palettes[0]!;
}

@Component({
  selector: 'hala-inbox',
  imports: [ScrollingModule, FormField, MediaPreviewComponent, ComposerComponent, ContactAvatarComponent, EmojiPickerComponent, DatePipe],
  host: {
    '(document:click)': 'onDocumentClick($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
  template: `
    <section class="inbox" dir="rtl" [class.has-selection]="!!selected()">
      <aside class="inbox-list">
        <div class="list-toolbar">
        <div class="list-header">
          <h2>البريد الوارد</h2>
        </div>
        <button class="new-chat-toggle" type="button" aria-label="محادثة جديدة" title="محادثة جديدة" [attr.aria-expanded]="showNewChat()" aria-controls="new-chat-panel" (click)="showNewChat.set(!showNewChat())">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11v8a2 2 0 0 1-2 2H5l-4 2V5a2 2 0 0 1 2-2h10M19 1v8M15 5h8" /></svg>
          <span>محادثة جديدة</span>
        </button>
          <div class="search-box">
            <input
              aria-label="بحث"
              placeholder="بحث في المحادثات أو الرسائل..."
              [value]="search()"
              (input)="setSearch($event)"
            />
            @if (search()) {
              <button class="clear-search-btn" type="button" (click)="clearSearch()" aria-label="مسح البحث">✕</button>
            }
          </div>
            <details #accountFilter class="filter-select" name="inbox-filter">
              <summary [attr.aria-label]="'تصفية حسب الرقم: ' + selectedAccountLabel()" [title]="selectedAccountLabel()">
                <span class="account-color" [class.all-accounts-color]="!accountId()" [style.background]="selectedAccountColor()" aria-hidden="true"></span>
                <span class="selected-account-label">{{ selectedAccountLabel() }}</span>
              </summary>
              <div class="filter-dropdown-backdrop" (click)="accountFilter.open = false"></div>
              <div class="filter-options">
                <button
                  type="button"
                  [attr.aria-pressed]="accountId() === ''"
                  (click)="setAccountId('')"
                >
                  <span class="account-color all-accounts-color" aria-hidden="true"></span>
                  <span class="account-option-label">كل الأرقام</span>
                  @if (!accountId()) { <span class="account-check" aria-hidden="true">✓</span> }
                </button>
                @for (account of accounts.accounts(); track account._id) {
                  <button
                    type="button"
                    [attr.aria-pressed]="accountId() === account._id"
                    (click)="setAccountId(account._id)"
                  >
                    <span class="account-color" [style.background]="accountColor(account._id)" aria-hidden="true"></span>
                    <span class="account-option-label">{{ account.label }}@if (account.phoneNumber) { <small dir="ltr">{{ account.phoneNumber }}</small> }</span>
                    @if (accountId() === account._id) { <span class="account-check" aria-hidden="true">✓</span> }
                  </button>
                }
              </div>
            </details>
            @if (search().trim().length >= 2) {
              <button
                type="button"
                class="search-messages-toggle"
                [class.active]="searchMode() === 'messages'"
                (click)="toggleSearchMode()"
                title="البحث في نصوص الرسائل"
              >
                {{ searchMode() === 'messages' ? 'المحادثات' : '🔍 بالرسائل' }}
              </button>
            }
        </div>
        @if (showNewChat()) {
          <div class="new-chat" id="new-chat-panel">
            <select [formField]="newChatFields.accountId" aria-label="رقم الإرسال">
              <option value="">اختر الرقم</option>
              @for (account of accounts.accounts(); track account._id) {
                @if (canSendAccount(account._id)) {
                  <option [value]="account._id">{{ account.label }}</option>
                }
              }
            </select>
            <input [formField]="newChatFields.to" placeholder="رقم المستلم" />
            <textarea [formField]="newChatFields.text" placeholder="الرسالة الأولى"></textarea>
            <button type="button" (click)="sendNewChat()">بدء المحادثة</button>
            @if (newChatError()) { <p role="alert">{{ newChatError() }}</p> }
          </div>
        }

        @if (searchMode() === 'messages') {
          <div class="message-search-panel">
            <div class="search-panel-header">
              <span>نتائج الرسائل لكلمة "<strong>{{ search() }}</strong>"</span>
              @if (inbox.searchingMessages()) {
                <span class="searching-spinner">جارٍ البحث…</span>
              } @else {
                <span>({{ inbox.messageSearchResults().length }} نتيجة)</span>
              }
            </div>
            @if (!inbox.searchingMessages() && inbox.messageSearchResults().length === 0) {
              <div class="conversation-state">
                <p>لا توجد رسائل مطابقة لهذا النص.</p>
              </div>
            }
            <div class="search-results-list">
              @for (result of inbox.messageSearchResults(); track result.message._id) {
                <button type="button" class="search-result-item" (click)="openMessageResult(result)">
                  <div class="result-top">
                    <strong dir="auto">{{ result.contactName }}</strong>
                    <small>{{ result.message.timestamp | date: 'dd/MM/yyyy HH:mm' }}</small>
                  </div>
                  <p class="result-snippet">{{ result.message.text || result.message.caption }}</p>
                </button>
              }
            </div>
          </div>
        } @else {
          <div class="filter-tabs-bar" role="tablist" aria-label="تصفية المحادثات">
            <button
              type="button"
              class="tab-chip"
              [class.active]="inbox.filterTab() === 'all' && !inbox.selectedTag()"
              (click)="onSelectTab('all')"
            >
              الكل
            </button>
            <button
              type="button"
              class="tab-chip"
              [class.active]="inbox.filterTab() === 'unread'"
              (click)="onSelectTab('unread')"
            >
              غير مقروء
            </button>
            <button
              type="button"
              class="tab-chip"
              [class.active]="inbox.filterTab() === 'assigned_me'"
              (click)="onSelectTab('assigned_me')"
            >
              مسندة لي
            </button>
            <button
              type="button"
              class="tab-chip"
              [class.active]="inbox.filterTab() === 'archived'"
              (click)="onSelectTab('archived')"
            >
              المؤرشفة
            </button>

            @if (inbox.availableTags().length > 0) {
              <details #tagFilterDetails class="tag-filter-dropdown">
                <summary class="tab-chip tag-chip-trigger" [class.active]="!!inbox.selectedTag()">
                  {{ inbox.selectedTag() ? ('وسم: ' + inbox.selectedTag()) : 'الوسوم ▾' }}
                </summary>
                <div class="tag-dropdown-backdrop" (click)="tagFilterDetails.open = false"></div>
                <div class="tag-filter-menu">
                  <button type="button" (click)="onSelectTag(null); tagFilterDetails.open = false">كل الوسوم</button>
                  @for (tag of inbox.availableTags(); track tag) {
                    <button type="button" (click)="onSelectTag(tag); tagFilterDetails.open = false">
                      <span class="color-dot" [style.background]="tagColor(tag).text"></span>
                      {{ tag }}
                    </button>
                  }
                </div>
              </details>
            }
          </div>
          @if (inbox.selectedTag()) {
            <div class="active-tag-banner">
              <span>تصفية بالوسم: <strong>{{ inbox.selectedTag() }}</strong></span>
              <button type="button" (click)="onSelectTag(null)" aria-label="إلغاء التصفية بالوسم">✕ إلغاء</button>
            </div>
          }

          @if (inbox.items().length > 0) {
            <cdk-virtual-scroll-viewport
              itemSize="76"
              class="conversations"
              aria-label="قائمة المحادثات"
              [attr.aria-busy]="inbox.loading()"
            >
              <button
                type="button"
                class="conversation"
                *cdkVirtualFor="let item of conversationItems(); trackBy: trackConversation"
                (click)="select(item)"
                (contextmenu)="onConversationContextMenu(item, $event)"
                [class.active]="inbox.selectedId() === item._id"
                [class.unread]="item.unreadCount > 0"
              >
                <hala-contact-avatar [conversation]="item" aria-hidden="true" />
                <span class="conversation-main">
                  <span class="conversation-topline">
                    <span class="conversation-title-group">
                      <strong dir="auto">{{ item.contactName }}</strong>
                      @if (!accountId() && accounts.accounts().length > 1) {
                        <span class="account-badge" [title]="'مرتبط بـ: ' + accountLabel(item.accountId)">{{ accountLabel(item.accountId) }}</span>
                      }
                    </span>
                    <small>{{
                      activityTime(item) | date: conversationTimeFormat(activityTime(item))
                    }}</small>
                  </span>
                  <span class="conversation-bottomline">
                    <span class="conversation-preview">
                      @if (!latestCall(item) && item.lastMessageDirection === 'out') {
                        @switch (item.lastMessageStatus) {
                          @case ('pending') {
                            <svg
                              class="preview-receipt pending"
                              role="img"
                              aria-label="قيد الإرسال"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.5"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <circle cx="8" cy="8" r="6" />
                              <path d="M8 4.5V8l2.3 1.4" />
                            </svg>
                          }
                          @case ('failed') {
                            <svg
                              class="preview-receipt failed"
                              role="img"
                              aria-label="فشل الإرسال"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.5"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <circle cx="8" cy="8" r="6" />
                              <path d="M8 4.5v4M8 11.2h.01" />
                            </svg>
                          }
                          @case ('sent') {
                            <svg
                              class="preview-receipt"
                              role="img"
                              aria-label="أُرسلت"
                              viewBox="0 0 18 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.8"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="m3 8 3 3 6-6" />
                            </svg>
                          }
                          @default {
                            <svg
                              class="preview-receipt"
                              [class.read]="item.lastMessageStatus === 'read'"
                              role="img"
                              [attr.aria-label]="item.lastMessageStatus === 'read' ? 'قُرئت' : 'وصلت'"
                              viewBox="0 0 24 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.8"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="m2 8 3 3 6-6M9 11l1 1 9-9" />
                            </svg>
                          }
                        }
                      }
                      <span>{{ conversationPreviewWithCalls(item) }}</span>
                    </span>
                    <span class="conversation-bottom-meta">
                      @if (item.tags && item.tags.length > 0) {
                        <span class="conversation-tags">
                          @for (tag of item.tags.slice(0, 2); track tag) {
                            <span class="tag-pill" [style.background]="tagColor(tag).bg" [style.color]="tagColor(tag).text" [style.borderColor]="tagColor(tag).border">
                              {{ tag }}
                            </span>
                          }
                          @if (item.tags.length > 2) {
                            <span class="tag-pill tag-more">+{{ item.tags.length - 2 }}</span>
                          }
                        </span>
                      }
                      <span class="conversation-meta-indicators">
                        @if (item.unreadCount > 0) {
                          <b
                            class="unread-count"
                            [attr.aria-label]="item.unreadCount + ' رسائل غير مقروءة'"
                            >{{ item.unreadCount > 99 ? '99+' : item.unreadCount }}</b
                          >
                        }
                        <button
                          type="button"
                          class="row-action-btn"
                          (click)="toggleReadStatus(item, $event)"
                          [attr.aria-label]="item.unreadCount > 0 ? 'تحديد كمقروء' : 'تحديد كغير مقروء'"
                          [title]="item.unreadCount > 0 ? 'تحديد كمقروء' : 'تحديد كغير مقروء'"
                        >
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            width="14"
                            height="14"
                          >
                            @if (item.unreadCount > 0) {
                              <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
                            } @else {
                              <circle cx="8" cy="8" r="4.5" />
                            }
                          </svg>
                        </button>
                      </span>
                    </span>
                  </span>
                </span>
              </button>
            </cdk-virtual-scroll-viewport>
          @if (inbox.loading()) {
            <p class="list-feedback loading-feedback" role="status" aria-live="polite">
              جارٍ تحديث المحادثات…
            </p>
          }
          @if (inbox.error()) {
            <div class="list-feedback error-feedback" role="alert">
              <span>{{ inbox.error() }}</span>
              <button type="button" (click)="retryInbox()">إعادة المحاولة</button>
            </div>
          } @else if (inbox.cursor()) {
            <button
              class="load-more"
              type="button"
              [disabled]="inbox.loading()"
              (click)="inbox.load(false)"
            >
              {{ inbox.loading() ? 'جارٍ التحميل…' : 'عرض محادثات أقدم' }}
            </button>
          }
        } @else {
          <div class="conversation-state" [attr.aria-busy]="inbox.loading()" aria-live="polite">
            @if (inbox.loading()) {
              <span class="state-spinner" aria-hidden="true"></span>
              <p>جارٍ تحميل المحادثات…</p>
            } @else if (inbox.error()) {
              <p class="state-error" role="alert">{{ inbox.error() }}</p>
              <button type="button" (click)="retryInbox()">إعادة المحاولة</button>
            } @else {
              <svg class="state-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <circle cx="10.8" cy="10.8" r="6.8" />
                <path d="m16 16 4.5 4.5" />
              </svg>
              <h3>{{ hasConversationFilters() ? 'لا توجد نتائج' : 'لا توجد محادثات بعد' }}</h3>
              <p>
                {{
                  hasConversationFilters()
                    ? 'جرّب تغيير البحث أو اختيار رقم آخر.'
                    : 'ستظهر المحادثات هنا عند وصول الرسائل.'
                }}
              </p>
            }
          </div>
        }
        }
      </aside>
      <article class="thread">
        @if (selected(); as conversation) {
          <div class="thread-header">
            <div class="thread-person">
              <button
                class="mobile-back"
                type="button"
                (click)="closeConversation()"
                aria-label="العودة إلى قائمة المحادثات"
                title="العودة إلى قائمة المحادثات"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M4 12h16M13 5l7 7-7 7" />
                </svg>
              </button>
              <hala-contact-avatar class="thread" [conversation]="conversation" aria-hidden="true" />
              <div class="thread-title">
                <div class="thread-title-row">
                  <h2 dir="auto">{{ conversation.contactName }}</h2>
                  @if (accounts.accounts().length > 1) {
                    <span class="account-badge thread-account-badge" [title]="'الرقم المرتبط: ' + accountLabel(conversation.accountId)">{{ accountLabel(conversation.accountId) }}</span>
                  }
                </div>
                @if (contactPhoneNumber(conversation.contactWaId); as phone) {
                  <span dir="ltr">{{ phone }}</span>
                } @else {
                  <span>جهة اتصال واتساب</span>
                }
              </div>
            </div>
            <div class="thread-controls">
              @if (conversation.status === 'archived') {
                <span class="archived-badge">مؤرشفة</span>
              }
              <details #threadActionsMenu class="thread-actions-menu">
                <summary
                  #threadActionsTrigger
                  class="quiet-button icon-button"
                  aria-label="خيارات المحادثة"
                  title="خيارات المحادثة"
                  aria-controls="thread-actions-panel"
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="1.8" />
                    <circle cx="12" cy="12" r="1.8" />
                    <circle cx="12" cy="19" r="1.8" />
                  </svg>
                </summary>
                <div id="thread-actions-panel" class="thread-actions-panel">
                  @if (permissions.can('conversations:read', conversation.accountId)) {
                    <button class="thread-action-item" type="button"
                      (click)="closeThreadActionsMenu(); toggleInChatSearch()"
                      [attr.aria-pressed]="inChatSearchOpen()">
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                      </svg>
                      <span>بحث في هذه المحادثة</span>
                    </button>
                  }
                  @if (permissions.can('conversations:archive', conversation.accountId)) {
                    <button class="thread-action-item" type="button"
                      (click)="closeThreadActionsMenu(); toggleArchiveConversation(conversation)">
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <rect width="20" height="5" x="2" y="3" rx="1" />
                        <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4" />
                      </svg>
                      <span>{{ conversation.status === 'archived' ? 'إلغاء الأرشفة' : 'أرشفة المحادثة' }}</span>
                    </button>
                  }
                  @if (permissions.can('conversations:read', conversation.accountId)) {
                    <button class="thread-action-item" type="button"
                      (click)="closeThreadActionsMenu(); toggleReadStatus(conversation)">
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="4" [attr.fill]="conversation.unreadCount > 0 ? 'none' : 'currentColor'" />
                        <path d="M21.5 12a9.5 9.5 0 1 1-19 0 9.5 9.5 0 0 1 19 0Z" />
                      </svg>
                      <span>{{ conversation.unreadCount > 0 ? 'تحديد كمقروء' : 'تحديد كغير مقروء' }}</span>
                    </button>
                  }
                  @if (permissions.can('contacts:read', conversation.accountId)) {
                    <button class="thread-action-item contact-info-action" type="button"
                      (click)="closeThreadActionsMenu(); openContactDetails()"
                      [attr.aria-expanded]="showContactDetails()" aria-controls="contact-details">
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="8" r="3.5" /><path d="M5 21a7 7 0 0 1 14 0M19 5h3m-1.5-1.5v3" />
                      </svg>
                      <span>بيانات جهة الاتصال</span>
                    </button>
                  }
                </div>
              </details>
            </div>
          </div>
          @if (inChatSearchOpen()) {
            <div class="in-chat-search-bar" role="search" aria-label="بحث داخل المحادثة">
              <input
                #inChatSearchInput
                type="text"
                placeholder="بحث في رسائل هذه المحادثة..."
                [value]="inChatSearchQuery()"
                (input)="setInChatSearchQuery($event)"
                (keydown.enter)="nextInChatMatch()"
                (keydown.escape)="closeInChatSearch()"
              />
              <div class="search-counter">
                @if (inChatMatches().length > 0) {
                  <span>{{ inChatMatchIndex() + 1 }} من {{ inChatMatches().length }}</span>
                } @else if (inChatSearchQuery().trim()) {
                  <span>لا توجد نتائج</span>
                }
              </div>
              <button type="button" class="search-nav-btn" [disabled]="inChatMatches().length === 0" (click)="prevInChatMatch()" title="السابق (Shift+Enter)">▲</button>
              <button type="button" class="search-nav-btn" [disabled]="inChatMatches().length === 0" (click)="nextInChatMatch()" title="التالي (Enter)">▼</button>
              <button type="button" class="search-nav-btn close-btn" (click)="closeInChatSearch()" title="إغلاق (Esc)">✕</button>
            </div>
          }
          <div #messagesPane class="messages" [attr.aria-busy]="messages.loading()" (scroll)="onMessagesScroll()">
            <div class="message-flow">
              @if (messages.error() && displayMessages().length > 0) {
                <div class="history-feedback" role="alert">
                  <span>{{ messages.error() }}</span>
                  <button type="button" (click)="messages.load()">إعادة المحاولة</button>
                </div>
              }
              @if (messages.cursor()) {
                <button
                  class="older-messages"
                  type="button"
                  [disabled]="messages.loading()"
                  (click)="messages.load()"
                >
                  {{ messages.loading() ? 'جارٍ تحميل الرسائل…' : 'رسائل أقدم' }}
                </button>
              }
              @if (timelineItems().length === 0 && messages.loading()) {
                <div class="thread-state" role="status" aria-live="polite">
                  <span class="state-spinner" aria-hidden="true"></span>
                  <p>جارٍ تحميل الرسائل…</p>
                </div>
              } @else if (timelineItems().length === 0 && messages.error()) {
                <div class="thread-state">
                  <h3>تعذر فتح المحادثة</h3>
                  <p>تحقق من الاتصال ثم أعد المحاولة.</p>
                  <button type="button" (click)="messages.load()">إعادة المحاولة</button>
                </div>
              } @else if (timelineItems().length === 0) {
                <div class="thread-state">
                  <svg class="state-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none">
                    <path d="M7 8h10a4 4 0 0 1 0 8h-2" />
                    <path d="m9 5-3 3 3 3M12 12h.01" />
                  </svg>
                  <h3>لا توجد رسائل بعد</h3>
                  <p>يمكنك بدء المحادثة بكتابة رسالة في الأسفل.</p>
                </div>
              }
              @for (entry of timelineItems(); track entry.id) {
                @if (entry.kind === 'date') {
                  <div class="message-day-divider" [class.first-in-timeline]="entry.firstInTimeline" role="separator">
                    <span>{{ entry.label }}</span>
                  </div>
                } @else if (entry.kind === 'call') {
                  <div class="call-timeline-entry" [class.missed]="entry.call.status === 'missed'">
                    <span aria-hidden="true">☎</span>
                    <strong>{{ callLabel(entry.call) }}</strong>
                    <time>{{ entry.call.startedAt | date: 'dd/MM/yyyy HH:mm' }}</time>
                  </div>
                } @else {
                @let message = entry.message;
                @let quoted = getQuotedMessage(message);
                <div [id]="'msg-' + message._id" [attr.data-message-id]="message._id" class="message" [class.search-highlight]="isMessageHighlighted(message._id)" [class.outgoing]="message.direction === 'out'" [class.poll-vote-message]="message.type === 'poll_vote'" [class.audio-message]="message.type === 'voice' || message.type === 'audio'" [class.media-message]="message.type === 'image' || message.type === 'video' || message.type === 'sticker' || message.type === 'document'" [class.has-reactions]="getMessageReactions(message).length > 0" [class.is-active]="activeMessageId() === message._id" (click)="onMessageClick(message._id, $event)">
                  @if (message.quotedWaMessageId) {
                    <div
                      class="quoted-box"
                      [class.quoted-out]="quoted?.direction === 'out'"
                      (click)="quoted ? jumpToMessage(quoted._id) : null"
                      role="button"
                      tabindex="0"
                      aria-label="الانتقال إلى الرسالة المردود عليها"
                    >
                      <strong class="quoted-author">{{ quoted ? getQuotedSenderName(quoted, conversation) : 'رسالة سابقة' }}</strong>
                      <span class="quoted-text">{{ quoted ? getQuotedSnippet(quoted) : 'رسالة تم الرد عليها' }}</span>
                    </div>
                  }
                  @if (message.type !== 'text' && message.type !== 'voice' && message.type !== 'audio' && !message.mediaId) {
                    <small class="message-kind">{{ messageTypeLabel(message.type) }}</small>
                  }
                  @if (message.text) {
                    <p>{{ message.text }}</p>
                  }
                  @if (message.forwarded) {
                    <p class="message-detail-line forwarded-message-indicator">
                      <svg
                        role="img"
                        aria-label="رسالة محوّلة"
                        title="رسالة محوّلة"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="m14 5 7 7-7 7" />
                        <path d="M21 12H10a6 6 0 0 0-6 6v1" />
                      </svg>
                    </p>
                  }
                  @if (message.mentions?.length) { <p class="message-detail-line">إشارات: {{ message.mentions.length }}</p> }
                  @if (message.type === 'location' && message.location) {
                    <p class="message-detail-line">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" />
                        <circle cx="12" cy="10" r="2.5" /></svg
                      >{{ message.location.lat }}, {{ message.location.lng }}
                    </p>
                  }
                  @if (message.type === 'contacts' && message.contacts) {
                    @for (card of message.contacts; track $index) {
                      <p class="message-detail-line">
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <circle cx="9" cy="8" r="3.5" />
                          <path
                            d="M3 20a6 6 0 0 1 12 0M16 5.5a3.5 3.5 0 0 1 0 6.8M18 15a5 5 0 0 1 3 4.5"
                          /></svg
                        >{{ card.name }} · {{ card.phones.join('، ') }}
                      </p>
                    }
                  }
                  @if (message.type === 'poll' && message.poll) {
                    <p class="message-detail-line">
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <path d="M4 19V5M4 19h17M8 15v-3M13 15V8M18 15V5" /></svg
                      >{{ message.poll.question }}
                    </p>
                  }
                  @if (message.type === 'poll_vote' && message.pollVote) {
                    <p class="message-detail-line">صوّت على استطلاع
                      @if (message.pollVote.selectedOptions?.length) { · {{ message.pollVote.selectedOptions.join('، ') }} }
                      @else { · لم تتوفر تفاصيل الاختيار }
                    </p>
                  }
                  @if (message.type === 'interactive' && message.interactive) {
                    @if (message.interactive.title) { <p class="message-detail-line">{{ message.interactive.title }}</p> }
                    @if (message.interactive.body) { <p>{{ message.interactive.body }}</p> }
                    @if (message.interactive.selectedTitle) {
                      <p class="message-detail-line">الاختيار: {{ message.interactive.selectedTitle }}</p>
                    }
                    @if (message.interactive.description) { <p class="message-detail-line">{{ message.interactive.description }}</p> }
                    @if (message.interactive.responseJson) { <pre class="message-detail-line">{{ message.interactive.responseJson }}</pre> }
                  }
                  @if (message.type === 'template' && message.template) {
                    @if (message.template.body) { <p>{{ message.template.body }}</p> }
                    @if (message.template.name) { <p class="message-detail-line">القالب: {{ message.template.name }}</p> }
                    @if (message.template.language) { <p class="message-detail-line">اللغة: {{ message.template.language }}</p> }
                    @if (message.template.componentsJson) { <pre class="message-detail-line">{{ message.template.componentsJson }}</pre> }
                  }
                  @if (message.mediaId) {
                    @defer (on viewport) {
                      <hala-media-preview [id]="message.mediaId" [kind]="message.type" [outgoing]="message.direction === 'out'" />
                    } @placeholder {
                      <span>مرفق</span>
                    }
                  }
                  @if (message.caption) {
                    <p class="media-caption">{{ message.caption }}</p>
                  }
                  @if (
                    !message.text &&
                    !message.caption &&
                    !(message.type === 'location' && message.location) &&
                    !(message.type === 'contacts' && message.contacts?.length) &&
                    !(message.type === 'poll' && message.poll?.question) &&
                    !(message.type === 'poll_vote' && message.pollVote?.targetWaMessageId) &&
                    !(message.type === 'interactive' && message.interactive) &&
                    !(message.type === 'template' && message.template) &&
                    !message.mediaId
                  ) {
                    <p>{{ missingMessageContent(message) }}</p>
                  }
                  @if (message.failureReason) {
                    <p role="alert">{{ message.failureReason }}</p>
                  }
                  <div class="actions">
                    @if (canSend(conversation)) {
                      <button
                        type="button"
                        class="action-btn react-btn"
                        [class.has-reacted]="!!getUserReaction(message)"
                        (click)="toggleReactionPicker(message._id, $event)"
                        aria-label="تفاعل"
                        title="تفاعل"
                      >
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <path d="M8 14s1.5 2 4 2 4-2 4-2" />
                          <line x1="9" y1="9" x2="9.01" y2="9" stroke-width="2.5" />
                          <line x1="15" y1="9" x2="15.01" y2="9" stroke-width="2.5" />
                        </svg>
                      </button>
                      <button type="button" (click)="composer.reply(message._id)" aria-label="الرد على الرسالة" title="الرد على الرسالة"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 7 7v3"/></svg></button>
                    }
                    @if (
                      canSend(conversation) ||
                      canDelete(conversation) ||
                      (message.direction === 'out' && canEdit(conversation))
                    ) {
                      <details class="message-menu" (toggle)="onMessageMenuToggle($event)">
                        <summary aria-label="إجراءات الرسالة" title="إجراءات الرسالة">
                          <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="5" cy="12" r="1.7" />
                            <circle cx="12" cy="12" r="1.7" />
                            <circle cx="19" cy="12" r="1.7" />
                          </svg>
                        </summary>
                        <div class="message-menu-items">
                          @if (canSend(conversation)) {
                            <button type="button" (click)="forwardId.set(message._id)">
                              تحويل
                            </button>
                          }
                          @if (
                            message.direction === 'out' &&
                            canEdit(conversation) &&
                            message.type === 'text' &&
                            !message.revokedAt
                          ) {
                            <button
                              type="button"
                              (click)="editingId.set(message._id); editText.set(message.text ?? '')"
                            >
                              تعديل
                            </button>
                          }
                          @if (message.status === 'failed' && canSend(conversation)) {
                            <button type="button" (click)="retry(message)">إعادة المحاولة</button>
                          }
                          @if (canDelete(conversation)) {
                            <button type="button" (click)="remove(message, 'me')">إخفاء لدي</button>
                            @if (message.direction === 'out' && !message.revokedAt) {
                              <button
                                class="danger"
                                type="button"
                                (click)="remove(message, 'everyone')"
                              >
                                حذف للجميع
                              </button>
                            }
                          }
                        </div>
                      </details>
                    }
                  </div>
                  @if (reactionPickerMessageId() === message._id) {
                    <div class="reaction-picker" (click)="$event.stopPropagation()">
                      @for (emoji of quickEmojis; track emoji) {
                        <button
                          type="button"
                          class="reaction-emoji-btn"
                          [class.active]="getUserReaction(message) === emoji"
                          (click)="reactToMessage(message, emoji)"
                          [attr.aria-label]="emoji"
                        >{{ emoji }}</button>
                      }
                      <button
                        type="button"
                        class="reaction-more-btn"
                        (click)="toggleCustomEmojiPicker($event)"
                        aria-label="المزيد من التفاعلات"
                        title="المزيد من الرموز التعبيرية"
                      >+</button>
                      @if (showCustomEmojiPicker()) {
                        <div class="custom-emoji-popover" (click)="$event.stopPropagation()">
                          <hala-emoji-picker (emojiSelected)="onCustomEmojiSelected(message, $event)" />
                        </div>
                      }
                    </div>
                  }
                  @if (editingId() === message._id) {
                    <input [value]="editText()" (input)="onEditInput($event)" />
                    <button type="button" (click)="edit(message)">حفظ التعديل</button>
                  }
                  @if (forwardId() === message._id) {
                    <select #targets multiple aria-label="محادثات التحويل">
                      @for (target of inbox.items(); track target._id) {
                        <option [value]="target._id" dir="auto">{{ target.contactName }}</option>
                      }
                    </select>
                    <button type="button" (click)="forward(message, targets)">تحويل</button>
                  }
                  <footer class="message-meta">
                    <span class="message-edits">
                      @if (message.editedAt) {
                        تم التعديل
                      }
                      @if (message.revokedAt) {
                        حُذفت للجميع
                      }
                    </span>
                    <span class="message-stamp">
                      @if (message.timestamp) {
                        <time>{{ message.timestamp | date: 'HH:mm' }}</time>
                      }
                      @if (message.direction === 'out') {
                        @switch (message.status) {
                          @case ('pending') {
                            <svg
                              class="receipt pending"
                              role="img"
                              [attr.aria-label]="messageStatusLabel(message.status)"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.5"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <circle cx="8" cy="8" r="6" />
                              <path d="M8 4.5V8l2.3 1.4" />
                            </svg>
                          }
                          @case ('failed') {
                            <svg
                              class="receipt failed"
                              role="img"
                              [attr.aria-label]="messageStatusLabel(message.status)"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.5"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <circle cx="8" cy="8" r="6" />
                              <path d="M8 4.5v4M8 11.2h.01" />
                            </svg>
                          }
                          @case ('sent') {
                            <svg
                              class="receipt"
                              role="img"
                              [attr.aria-label]="messageStatusLabel(message.status)"
                              viewBox="0 0 18 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.8"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="m3 8 3 3 6-6" />
                            </svg>
                          }
                          @default {
                            <svg
                              class="receipt"
                              [class.read]="message.status === 'read'"
                              role="img"
                              [attr.aria-label]="messageStatusLabel(message.status)"
                              viewBox="0 0 24 16"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.8"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                            >
                              <path d="m2 8 3 3 6-6M9 11l1 1 9-9" />
                            </svg>
                          }
                        }
                      }
                    </span>
                  </footer>
                  @let reactions = getMessageReactions(message);
                  @if (reactions.length > 0) {
                    <div
                      class="reaction-badge"
                      [class.outgoing]="message.direction === 'out'"
                      [attr.title]="getReactionTooltip(reactions)"
                      (click)="onReactionBadgeClick(message, reactions, $event)"
                      (keydown.enter)="onReactionBadgeClick(message, reactions, $event)"
                      role="button"
                      tabindex="0"
                      aria-label="تفاعلات الرسالة"
                    >
                      @for (r of reactions; track r.emoji) {
                        <span class="reaction-emoji-item" [class.user-reacted]="r.hasUser">
                          <span class="reaction-char">{{ r.emoji }}</span>
                          @if (r.count > 1) {
                            <span class="reaction-count">{{ r.count }}</span>
                          }
                        </span>
                      }
                    </div>
                  }
                </div>
                }
              }
            </div>
          </div>
          @if (realtime.typing()?.conversationId === conversation._id) {
            <p>يكتب الآن…</p>
          }
          @if (actionError()) {
            <p role="alert">{{ actionError() }}</p>
          }
          <hala-composer [conversation]="conversation" />
        } @else {
          <div class="empty-thread">
            <div class="empty-thread-content">
              <svg class="empty-thread-illustration" viewBox="0 0 320 188" fill="none" aria-hidden="true">
                <rect x="50" y="24" width="220" height="135" rx="10" fill="#e9edef" stroke="#d1d7db" stroke-width="2"/>
                <rect x="62" y="36" width="196" height="110" rx="4" fill="#ffffff"/>
                <rect x="62" y="36" width="196" height="18" fill="#f0f2f5"/>
                <circle cx="72" cy="45" r="3" fill="#ea4335" opacity="0.7"/>
                <circle cx="80" cy="45" r="3" fill="#fbbc05" opacity="0.7"/>
                <circle cx="88" cy="45" r="3" fill="#34a853" opacity="0.7"/>
                <rect x="74" y="66" width="70" height="16" rx="6" fill="#f0f2f5"/>
                <rect x="160" y="88" width="85" height="16" rx="6" fill="#d9fdd3"/>
                <rect x="74" y="110" width="95" height="16" rx="6" fill="#f0f2f5"/>
                <path d="M30 160h260c6 0 10 4 8 10l-3 6c-1 3-4 5-8 5H43c-4 0-7-2-8-5l-3-6c-2-6 2-10 8-10z" fill="#d1d7db"/>
                <rect x="135" y="160" width="50" height="5" rx="2.5" fill="#aebac1"/>
                <rect x="220" y="70" width="48" height="92" rx="8" fill="#ffffff" stroke="#00a884" stroke-width="2.5"/>
                <rect x="224" y="76" width="40" height="74" rx="4" fill="#efeae2"/>
                <rect x="228" y="86" width="22" height="8" rx="3" fill="#ffffff"/>
                <rect x="238" y="98" width="22" height="8" rx="3" fill="#d9fdd3"/>
                <rect x="228" y="110" width="25" height="8" rx="3" fill="#ffffff"/>
                <circle cx="244" cy="156" r="3" fill="#00a884"/>
              </svg>
              <h2>واتساب ويب - Hala CRM</h2>
              <p>أرسل واستقبل الرسائل دون الحاجة لإبقاء هاتفك متصلاً بالإنترنت.<br>اختر محادثة من القائمة لعرض الرسائل والتواصل.</p>
              @if (actionError()) {
                <p class="error-msg" role="alert">{{ actionError() }}</p>
              }
            </div>
            <div class="empty-thread-footer">
              <svg class="lock-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
              </svg>
              <span>رسائلك ومكالماتك مشفرة تماماً بين الطرفين</span>
            </div>
          </div>
        }
      </article>
      @if (showContactDetails()) {
        <button
          class="details-backdrop"
          type="button"
          (click)="closeContactDetails()"
          aria-label="إغلاق بيانات جهة الاتصال"
        ></button>
      }
      <aside
        id="contact-details"
        class="details"
        [class.open]="showContactDetails()"
        [class.media-open]="detailsPanel() === 'media'"
        (keydown.escape)="closeContactDetails()"
      >
        @if (selected(); as conversation) {
          <div class="details-heading">
            @if (detailsPanel() === 'media') {
              <button class="quiet-button icon-button details-back-button" type="button" (click)="showContactInfo()"
                aria-label="العودة إلى معلومات جهة الاتصال" title="رجوع">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-7-7 7 7-7 7" /></svg>
              </button>
              <h3>الوسائط والمستندات</h3>
            } @else { <h3>معلومات جهة الاتصال</h3> }
            <button
              #detailsCloseButton
              class="quiet-button icon-button details-close-button"
              type="button"
              (click)="closeContactDetails()"
              aria-label="إغلاق بيانات جهة الاتصال"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          @if (detailsPanel() === 'contact') {
            <div class="contact-profile">
              <hala-contact-avatar class="detail" [conversation]="conversation" aria-hidden="true" />
              <strong class="contact-name" dir="auto">{{ conversation.contactName }}</strong>
              <span>{{ conversation.contactPhoneE164 || contactPhoneNumber(conversation.contactWaId) || 'جهة اتصال واتساب' }}</span>
            </div>

            <div class="details-section tags-section">
              <h4>الوسوم والتصنيفات</h4>
              <div class="tags-container">
                @for (tag of conversation.tags || []; track tag) {
                  <span class="tag-badge" [style.background]="tagColor(tag).bg" [style.color]="tagColor(tag).text" [style.borderColor]="tagColor(tag).border">
                    <span>{{ tag }}</span>
                    <button type="button" (click)="removeTag(conversation, tag)" title="إزالة الوسم">✕</button>
                  </span>
                }
                @if (!conversation.tags || conversation.tags.length === 0) {
                  <p class="no-tags-hint">لا توجد وسوم مخصصة لهذه المحادثة بعد.</p>
                }
              </div>
              <div class="add-tag-box">
                <input
                  #newTagInput
                  type="text"
                  placeholder="أدخل وسماً جديداً..."
                  (keydown.enter)="addTag(conversation, newTagInput.value); newTagInput.value = ''"
                />
                <button type="button" (click)="addTag(conversation, newTagInput.value); newTagInput.value = ''">
                  + إضافة
                </button>
              </div>
              @if (suggestedTags(conversation).length > 0) {
                <div class="tag-suggestions">
                  <span class="suggestions-label">وسوم مقترحة:</span>
                  @for (suggested of suggestedTags(conversation); track suggested) {
                    <button type="button" class="tag-suggestion-chip" (click)="addTag(conversation, suggested)">
                      + {{ suggested }}
                    </button>
                  }
                </div>
              }
            </div>

            <dl>
              <div>
                <dt>رقم واتساب</dt>
                @if (conversation.contactPhoneE164 || contactPhoneNumber(conversation.contactWaId); as phone) {
                  <dd dir="ltr">{{ phone }}</dd>
                } @else {
                  <dd>غير متاح</dd>
                }
              </div>
              <div>
                <dt>الرقم المرتبط</dt>
                <dd>{{ accountLabel(conversation.accountId) }}</dd>
              </div>
              <div>
                <dt>الحالة</dt>
                <dd>{{ conversation.profileStatus === 'pending' ? 'جارٍ التحديث…' : conversation.contactAbout || 'غير متاحة' }}</dd>
              </div>
              <div>
                <dt>المجموعات المشتركة</dt>
                <dd>
                  @if (conversation.profileStatus === 'pending') { جارٍ التحديث… }
                  @else if (conversation.commonGroups?.length) {
                    @for (group of conversation.commonGroups; track group.id) { <p>{{ group.name }}</p> }
                  } @else { لا توجد مجموعات مشتركة أو تعذر عرضها }
                </dd>
              </div>
            </dl>
            <button class="profile-media-link" type="button" (click)="openMediaPanel(conversation._id)">
              <span>الوسائط والمستندات</span>
              <span aria-hidden="true">←</span>
            </button>

            <div class="details-section actions-section">
              <h4>إجراءات المحادثة</h4>
              <button
                type="button"
                class="archive-action-btn"
                [class.unarchive]="conversation.status === 'archived'"
                (click)="toggleArchiveConversation(conversation)"
              >
                @if (conversation.status === 'archived') {
                  <span>📂 إلغاء أرشفة المحادثة</span>
                } @else {
                  <span>📁 أرشفة هذه المحادثة</span>
                }
              </button>
            </div>
          } @else {
            <section class="profile-media" aria-label="الوسائط والمستندات">
              @if (profileMediaLoading() && profileMediaItems().length === 0) { <p>جارٍ تحميل الوسائط…</p> }
              @else if (profileMediaError()) { <p role="alert">تعذر تحميل الوسائط</p> }
              @else if (profileMediaItems().length === 0) { <p>لا توجد وسائط في هذه المحادثة</p> }
              <div class="profile-media-grid">
                @for (item of profileMediaItems(); track item._id) {
                  <div class="profile-media-item">
                    @if (item.mediaId) {
                      @defer (on viewport) { <hala-media-preview [id]="item.mediaId" [kind]="item.type" /> }
                      @placeholder { <span>مرفق</span> }
                    }
                    <small>{{ messageTypeLabel(item.type) }} · {{ item.timestamp | date: 'shortDate' }}</small>
                  </div>
                }
                </div>
              @if (profileMediaCursor()) {
                <button type="button" [disabled]="profileMediaLoading()" (click)="loadProfileMedia(conversation._id)">عرض المزيد</button>
              }
            </section>
          }
        }
      </aside>
    </section>
  `,
  styles: [
    `
      .inbox {
        position: relative;
        --ink: #111b21;
        --muted: var(--wa-muted);
        --line: var(--wa-border);
        --accent: var(--wa-green);
        --active: var(--wa-active);
        display: grid;
        grid-template-columns: minmax(20rem, 26rem) minmax(0, 1fr) minmax(17rem, 22rem);
        gap: 0;
        height: calc(100dvh - var(--shell-header-height, 4.5rem) - 2 * var(--shell-content-padding, 1rem));
        min-height: 34rem;
        overflow: hidden;
        border: 1px solid var(--wa-border);
        border-radius: 0.4rem;
        background: #fff;
        color: var(--ink);
        box-shadow: 0 1px 3px #0b141a18;
      }
      .call-timeline-entry { align-self: center; display: flex; align-items: center; gap: .5rem; padding: .45rem .8rem; border-radius: .7rem; background: #e8f1ed; color: #274b40; font-size: .85rem; }
      .call-timeline-entry.missed { background: #fce9e8; color: #a52b2b; }
      .call-timeline-entry time { color: inherit; opacity: .75; }
      .inbox > aside:not(.details),
      .inbox > article {
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 0;
        border-radius: 0;
        background: #fff;
        box-shadow: none;
      }
      .inbox > aside.details,
      .inbox > .details {
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior-y: contain;
        scrollbar-width: thin;
        scrollbar-color: #cbd5e1 transparent;
        border: 0;
        border-radius: 0;
        background: #fff;
        box-shadow: none;
      }
      .inbox > aside.details::-webkit-scrollbar,
      .inbox > .details::-webkit-scrollbar {
        width: 6px;
      }
      .inbox > aside.details::-webkit-scrollbar-track,
      .inbox > .details::-webkit-scrollbar-track {
        background: transparent;
      }
      .inbox > aside.details::-webkit-scrollbar-thumb,
      .inbox > .details::-webkit-scrollbar-thumb {
        background: #cbd5e1;
        border-radius: 3px;
      }
      .inbox > aside.details::-webkit-scrollbar-thumb:hover,
      .inbox > .details::-webkit-scrollbar-thumb:hover {
        background: #94a3b8;
      }
      .inbox > .inbox-list,
      .inbox > .thread {
        border-inline-end: 1px solid var(--wa-border);
      }
      .inbox-list {
        padding: 0;
      }
      .list-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.6rem;
        margin: 0;
        padding: 0;
        grid-column: 1;
        grid-row: 1;
        background: var(--wa-header);
      }
      .list-header h2 {
        margin: 0;
        font-size: 1.12rem;
      }
      .new-chat-toggle {
        grid-column: 2;
        grid-row: 1;
        display: inline-flex;
        justify-content: center;
        align-items: center;
        gap: .4rem;
        min-height: 2.3rem;
        font-size: 0.82rem;
        white-space: nowrap;
      }
      .new-chat-toggle svg { display: none; }
      .list-toolbar {
        position: relative;
        z-index: 35;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 0.45rem .5rem;
        margin: 0;
        padding: .65rem .75rem;
        border-block-end: 1px solid #e9edef;
        background: var(--wa-header);
      }
      .search-box {
        grid-column: 1 / -1;
        grid-row: 2;
        position: relative;
        display: flex;
        align-items: center;
        width: 100%;
      }
      .search-box input {
        width: 100%;
        min-height: 2.35rem;
        padding: 0.45rem 2rem 0.45rem 0.75rem;
        border: 1px solid #d1d7db;
        border-radius: 0.45rem;
        background: #fff;
        font-size: 0.82rem;
      }
      .clear-search-btn {
        position: absolute;
        inset-inline-end: 0.45rem;
        width: 1.4rem;
        height: 1.4rem;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        border-radius: 50%;
        background: #e2e8f0;
        color: #64748b;
        font-size: 0.7rem;
        cursor: pointer;
      }
      .list-toolbar > .filter-select { grid-column: 1 / -1; grid-row: 3; min-width: 0; }
      .list-toolbar:has(.search-messages-toggle) > .filter-select { grid-column: 1; }
      .search-messages-toggle {
        grid-row: 3;
        grid-column: 2;
        min-height: 2.35rem;
        padding: 0.4rem 0.65rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.45rem;
        background: #fff;
        color: #0284c7;
        font-size: 0.78rem;
        font-weight: 500;
        cursor: pointer;
        white-space: nowrap;
      }
      .search-messages-toggle:hover {
        background: #f0f9ff;
      }
      .search-messages-toggle.active {
        background: #0284c7;
        color: #fff;
        border-color: #0284c7;
      }
      .filter-tabs-bar {
        position: relative;
        z-index: 30;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.4rem;
        padding: 0.5rem 0.75rem;
        background: #fff;
        border-block-end: 1px solid #e9edef;
      }
      .tab-chip {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.35rem 0.75rem;
        border: 1px solid #e2e8f0;
        border-radius: 2rem;
        background: #f8fafc;
        color: #475569;
        font-size: 0.78rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .tab-chip:hover {
        background: #f1f5f9;
        border-color: #cbd5e1;
      }
      .tab-chip.active {
        background: #008069;
        color: #fff;
        border-color: #008069;
        box-shadow: 0 1px 3px rgba(0, 128, 105, 0.25);
      }
      .tag-filter-dropdown {
        position: relative;
        display: inline-block;
      }
      .tag-filter-dropdown[open] {
        z-index: 40;
      }
      .tag-chip-trigger {
        list-style: none;
        cursor: pointer;
      }
      .tag-chip-trigger::-webkit-details-marker { display: none; }
      .tag-dropdown-backdrop {
        position: fixed;
        inset: 0;
        z-index: 45;
        background: transparent;
      }
      .tag-filter-menu {
        position: absolute;
        z-index: 50;
        top: calc(100% + 0.35rem);
        inset-inline-end: 0;
        min-width: 11rem;
        max-height: 15rem;
        overflow-y: auto;
        background: #fff;
        border: 1px solid #cbd5e1;
        border-radius: 0.5rem;
        padding: 0.35rem;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.18), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
        display: grid;
        gap: 0.25rem;
      }
      .tag-filter-menu button {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        padding: 0.45rem 0.65rem;
        border-radius: 0.35rem;
        background: transparent;
        color: #1e293b;
        font-size: 0.8rem;
        text-align: start;
        border: none;
        cursor: pointer;
      }
      .tag-filter-menu button:hover {
        background: #f1f5f9;
      }
      .color-dot {
        width: 0.55rem;
        height: 0.55rem;
        border-radius: 50%;
        display: inline-block;
      }
      .active-tag-banner {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.35rem 0.75rem;
        background: #f0fdf4;
        border-block-end: 1px solid #bbf7d0;
        font-size: 0.78rem;
        color: #166534;
      }
      .active-tag-banner button {
        background: transparent;
        border: none;
        color: #dc2626;
        cursor: pointer;
        font-size: 0.75rem;
        padding: 0.15rem 0.4rem;
        border-radius: 0.25rem;
      }
      .active-tag-banner button:hover {
        background: #fee2e2;
      }
      .conversation-bottom-meta {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        flex: none;
      }
      .conversation-tags {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        flex: none;
      }
      .tag-pill {
        display: inline-flex;
        align-items: center;
        padding: 0.08rem 0.35rem;
        border-radius: 4px;
        font-size: 0.65rem;
        font-weight: 600;
        border: 1px solid;
        line-height: 1.2;
        white-space: nowrap;
      }
      .tag-pill.tag-more {
        background: #f1f5f9;
        color: #64748b;
        border-color: #cbd5e1;
      }
      .in-chat-search-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.85rem;
        background: #f8fafc;
        border-block-end: 1px solid #e2e8f0;
        animation: inChatSlideDown 0.15s ease;
      }
      @keyframes inChatSlideDown {
        from { opacity: 0; transform: translateY(-0.5rem); }
        to { opacity: 1; transform: translateY(0); }
      }
      .in-chat-search-bar input {
        flex: 1;
        min-width: 0;
        min-height: 2.1rem;
        padding: 0.3rem 0.6rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.4rem;
        font-size: 0.82rem;
        background: #fff;
      }
      .search-counter {
        font-size: 0.75rem;
        color: #64748b;
        white-space: nowrap;
        min-width: 4.5rem;
        text-align: center;
      }
      .search-nav-btn {
        width: 2rem;
        height: 2rem;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid #cbd5e1;
        border-radius: 0.35rem;
        background: #fff;
        color: #334155;
        font-size: 0.75rem;
        cursor: pointer;
      }
      .search-nav-btn:hover:not(:disabled) {
        background: #f1f5f9;
      }
      .search-nav-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .search-nav-btn.close-btn {
        color: #dc2626;
        border-color: #fecdd3;
      }
      .message.search-highlight {
        outline: 2.5px solid #f59e0b !important;
        background-color: #fef3c7 !important;
        animation: pulseHighlight 1.5s ease infinite alternate;
      }
      @keyframes pulseHighlight {
        from { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.4); }
        to { box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.15); }
      }
      .details-section {
        padding: 0.85rem 1.25rem;
        box-sizing: border-box;
        width: 100%;
        text-align: start;
      }
      .details-section h4 {
        margin: 0 0 0.6rem;
        font-size: 0.85rem;
        font-weight: 600;
        color: #475569;
      }
      .tags-section {
        border-block-end: 1px solid #e6eee9;
      }
      .actions-section {
        border-block-start: 1px solid #e9edef;
        margin-block-start: auto;
        padding-block-end: 1.5rem;
      }
      .tags-container {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        margin-block-end: 0.6rem;
      }
      .tag-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.2rem 0.55rem;
        border-radius: 1rem;
        font-size: 0.75rem;
        font-weight: 600;
        border: 1px solid;
      }
      .tag-badge button {
        background: transparent;
        border: none;
        color: inherit;
        opacity: 0.65;
        cursor: pointer;
        padding: 0;
        font-size: 0.7rem;
        display: flex;
        align-items: center;
      }
      .tag-badge button:hover { opacity: 1; }
      .no-tags-hint {
        margin: 0;
        font-size: 0.78rem;
        color: #94a3b8;
      }
      .add-tag-box {
        display: flex;
        gap: 0.4rem;
      }
      .add-tag-box input {
        flex: 1;
        min-width: 0;
        min-height: 2.1rem;
        padding: 0.3rem 0.6rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.4rem;
        font-size: 0.8rem;
      }
      .add-tag-box button {
        min-height: 2.1rem;
        padding: 0.3rem 0.75rem;
        font-size: 0.8rem;
        white-space: nowrap;
      }
      .tag-suggestions {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        flex-wrap: wrap;
        margin-block-start: 0.5rem;
      }
      .suggestions-label {
        font-size: 0.72rem;
        color: #64748b;
      }
      .tag-suggestion-chip {
        padding: 0.15rem 0.45rem;
        border-radius: 0.8rem;
        border: 1px dashed #cbd5e1;
        background: #f8fafc;
        color: #475569;
        font-size: 0.7rem;
        cursor: pointer;
      }
      .tag-suggestion-chip:hover {
        background: #f1f5f9;
        border-color: #008069;
        color: #008069;
      }
      .archive-action-btn {
        width: 100%;
        min-height: 2.4rem;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.4rem;
        padding: 0.5rem 1rem;
        border-radius: 0.45rem;
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        color: #334155;
        font-size: 0.82rem;
        font-weight: 500;
        cursor: pointer;
      }
      .archive-action-btn:hover {
        background: #f1f5f9;
      }
      .archive-action-btn.unarchive {
        background: #f0fdf4;
        border-color: #86efac;
        color: #166534;
      }
      .archived-badge {
        display: inline-block;
        padding: 0.2rem 0.55rem;
        border-radius: 0.35rem;
        background: #fef3c7;
        color: #92400e;
        border: 1px solid #fde68a;
        font-size: 0.75rem;
        font-weight: 600;
      }
      .message-search-panel {
        display: flex;
        flex-direction: column;
        flex: 1;
        overflow-y: auto;
        background: #fff;
      }
      .search-panel-header {
        padding: 0.55rem 0.85rem;
        background: #f8fafc;
        border-block-end: 1px solid #e2e8f0;
        font-size: 0.78rem;
        color: #64748b;
        display: flex;
        justify-content: space-between;
      }
      .search-results-list {
        display: grid;
        gap: 0.2rem;
        padding: 0.4rem;
      }
      .search-result-item {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        padding: 0.65rem 0.8rem;
        border-radius: 0.45rem;
        border: 1px solid transparent;
        background: #fff;
        text-align: start;
        cursor: pointer;
        transition: background 0.15s ease;
      }
      .search-result-item:hover {
        background: #f1f5f9;
        border-color: #cbd5e1;
      }
      .result-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .result-top strong {
        font-size: 0.85rem;
        color: #0f172a;
      }
      .result-top small {
        font-size: 0.72rem;
        color: #94a3b8;
      }
      .result-snippet {
        margin: 0;
        font-size: 0.8rem;
        color: #475569;
        line-height: 1.35;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .filter-select {
        position: relative;
      }
      .filter-select[open] {
        z-index: 100;
      }
      .filter-select summary {
        display: flex;
        align-items: center;
        min-height: 2.6rem;
        overflow: hidden;
        padding: 0.6rem 0.8rem;
        border: 1px solid #d1d7db;
        border-radius: 0.45rem;
        background: #fff;
        color: var(--ink);
        cursor: pointer;
        list-style: none;
        white-space: nowrap;
        text-overflow: ellipsis;
        gap: .55rem;
      }
      .selected-account-label { overflow: hidden; text-overflow: ellipsis; }
      .account-color { display: inline-block; width: 1rem; height: 1rem; flex: 0 0 1rem; border-radius: 50%; background: #008069; border: 1px solid #0002; box-shadow: 0 0 0 2px #fff; }
      .all-accounts-color { background: conic-gradient(#008069 0deg 90deg, #0284c7 90deg 180deg, #9333ea 180deg 270deg, #d97706 270deg); }
      .account-option-label { min-width: 0; overflow-wrap: anywhere; }
      .account-option-label small { display: block; margin-block-start: .15rem; color: #667781; font-size: .75rem; text-align: start; }
      .account-check { margin-inline-start: auto; font-weight: 700; }
      .filter-select summary::-webkit-details-marker {
        display: none;
      }
      .filter-select summary::after {
        content: '';
        width: 0.5rem;
        height: 0.5rem;
        margin-inline-start: auto;
        border-inline-end: 2px solid var(--wa-green);
        border-block-end: 2px solid var(--wa-green);
        transform: rotate(45deg);
        transition: transform 0.2s ease;
      }
      .filter-select[open] summary::after {
        transform: rotate(-135deg);
      }
      .filter-select[open] summary,
      .filter-select summary:focus-visible {
        border-color: var(--wa-green);
        outline: 2px solid color-mix(in srgb, var(--wa-green) 24%, transparent);
        outline-offset: 1px;
      }
      .filter-dropdown-backdrop {
        position: fixed;
        inset: 0;
        z-index: 95;
        background: transparent;
      }
      .filter-options {
        position: absolute;
        z-index: 100;
        inset-inline: 0;
        top: calc(100% + 0.35rem);
        display: grid;
        gap: 0.2rem;
        max-height: 16rem;
        overflow-y: auto;
        padding: 0.35rem;
        border: 1px solid #cbd5e1;
        border-radius: 0.55rem;
        background: #fff;
        box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.18), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      }
      .filter-options button {
        display: flex;
        align-items: center;
        gap: .65rem;
        padding: 0.7rem 0.8rem;
        border-radius: 0.45rem;
        background: transparent;
        color: #19342e;
        text-align: start;
        border: none;
        cursor: pointer;
        font-size: 0.88rem;
      }
      .filter-options button:hover,
      .filter-options button:focus-visible {
        background: #f5f6f6;
      }
      .filter-options button[aria-pressed='true'] {
        background: #e7fce3;
        color: #005c4b;
        font-weight: 600;
      }
      .new-chat {
        display: grid;
        gap: 0.55rem;
        margin: 0.25rem 0.75rem 0.75rem;
        padding: 0.75rem;
        border: 1px solid var(--line);
        border-radius: 0.55rem;
        background: #f7f8fa;
      }
      input,
      select,
      button {
        font: inherit;
      }
      .conversations {
        display: block;
        width: 100%;
        height: 100%;
        flex: 1 1 0%;
        min-height: 0;
        overflow-x: hidden;
      }
      .messages {
        flex: 1;
        min-height: 0;
        overflow-x: hidden;
      }
      .conversation-state,
      .thread-state {
        display: grid;
        flex: 1;
        min-height: 10rem;
        align-content: center;
        justify-items: center;
        gap: 0.45rem;
        padding: 1.25rem;
        color: var(--muted);
        text-align: center;
      }
      .conversation-state h3,
      .thread-state h3,
      .conversation-state p,
      .thread-state p {
        margin: 0;
      }
      .conversation-state h3,
      .thread-state h3 {
        color: var(--ink);
        font-size: 0.98rem;
      }
      .state-icon {
        width: 2rem;
        height: 2rem;
        margin-block-end: 0.25rem;
        stroke: var(--wa-green);
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .state-spinner {
        width: 1.6rem;
        height: 1.6rem;
        border: 2px solid #d9eee7;
        border-block-start-color: var(--wa-green);
        border-radius: 50%;
        animation: state-spin 0.8s linear infinite;
      }
      @keyframes state-spin {
        to {
          transform: rotate(1turn);
        }
      }
      .conversation-state button,
      .thread-state button,
      .list-feedback button,
      .history-feedback button {
        min-height: 2.25rem;
        padding: 0.4rem 0.8rem;
        border: 1px solid #cfe4da;
        border-radius: 0.45rem;
        background: #fff;
        color: var(--wa-green-dark);
        cursor: pointer;
      }
      .state-error {
        color: #a62030;
      }
      .list-feedback,
      .history-feedback {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 0.55rem;
        margin: 0.55rem 0.75rem;
        padding: 0.65rem;
        border-radius: 0.5rem;
        color: var(--muted);
        text-align: center;
        font-size: 0.82rem;
      }
      .error-feedback,
      .history-feedback {
        border: 1px solid #f0c8c8;
        background: #fff7f7;
        color: #8c2430;
      }
      .loading-feedback {
        margin-block: 0.35rem;
        padding-block: 0.35rem;
      }
      .load-more {
        flex: none;
        margin: 0.4rem 0.75rem 0.65rem;
      }
      .load-more:disabled,
      .older-messages:disabled {
        cursor: wait;
        opacity: 0.7;
      }
      .conversation {
        width: 100%;
        height: 76px;
        box-sizing: border-box;
        overflow: hidden;
        display: grid;
        grid-template-columns: 3.15rem minmax(0, 1fr);
        align-items: center;
        gap: 0.8rem;
        padding: 0.5rem 0.8rem;
        border: 0;
        border-inline-start: 3px solid transparent;
        border-block-end: 1px solid #e9edef;
        border-radius: 0;
        background: #fff;
        color: var(--ink);
        text-align: start;
        cursor: pointer;
      }
      .conversation:hover {
        background: #f5f6f6;
      }
      .conversation.active {
        border-inline-start-color: var(--accent);
        background: var(--active);
        color: var(--ink);
      }
      .conversation:focus-visible {
        position: relative;
        z-index: 1;
        outline: 2px solid var(--wa-green);
        outline-offset: -2px;
      }
      .conversation-main {
        display: grid;
        min-width: 0;
        gap: 0.35rem;
      }
      .conversation-topline,
      .conversation-bottomline {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .conversation-title-group {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        min-width: 0;
        overflow: hidden;
      }
      .account-badge {
        flex: none;
        display: inline-block;
        padding: 0.08rem 0.35rem;
        font-size: 0.65rem;
        font-weight: 500;
        line-height: 1.2;
        border-radius: 4px;
        background: #f0fdf4;
        color: #166534;
        border: 1px solid #bbf7d0;
        white-space: nowrap;
      }
      .conversation-topline strong {
        min-width: 0;
        overflow: hidden;
        font-size: 0.92rem;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .conversation-topline small {
        flex: none;
        color: var(--muted);
        font-size: 0.7rem;
        direction: ltr;
      }
      .conversation-bottomline {
        align-items: center;
      }
      .conversation-preview {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        align-items: center;
        gap: 0.25rem;
        overflow: hidden;
        color: var(--muted);
        font-size: 0.8rem;
        line-height: 1.4;
        white-space: nowrap;
      }
      .conversation-preview > span:last-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .preview-receipt {
        flex: none;
        width: 1.05rem;
        height: 0.85rem;
        color: #8696a0;
      }
      .preview-receipt.read {
        color: #53bdeb;
      }
      .preview-receipt.failed {
        color: #ea0038;
      }
      .preview-receipt.pending {
        color: #8696a0;
      }
      .sent-prefix {
        flex: none;
        color: #54656d;
      }
      .unread-count {
        display: grid;
        flex: none;
        min-width: 1.2rem;
        height: 1.2rem;
        place-items: center;
        padding-inline: 0.3rem;
        border-radius: 999px;
        background: var(--wa-green);
        color: #fff;
        font-size: 0.68rem;
        font-weight: 600;
        line-height: 1;
      }
      .conversation.unread .conversation-topline strong {
        font-weight: 700;
        color: #111b21;
      }
      .conversation.unread .conversation-topline small {
        color: var(--wa-green);
        font-weight: 600;
      }
      .conversation.unread .conversation-preview {
        color: #111b21;
        font-weight: 500;
      }
      .conversation-meta-indicators {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        flex: none;
      }
      .row-action-btn {
        display: none;
        align-items: center;
        justify-content: center;
        width: 1.4rem;
        height: 1.4rem;
        padding: 0;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: #8696a0;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
      }
      .conversation:hover .row-action-btn,
      .conversation:focus-within .row-action-btn {
        display: inline-flex;
      }
      .row-action-btn:hover {
        background: #e9edef;
        color: var(--wa-green);
      }
      .thread {
        background: var(--wa-chat);
      }
      .thread-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 0.6rem 1rem;
        min-height: 4.35rem;
        padding: 0.55rem 0.85rem;
        border-block-end: 1px solid #dfe5e7;
        background: var(--wa-header);
      }
      .thread-person {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 0.7rem;
      }
      .mobile-back {
        display: none;
        flex: none;
        width: 2.35rem;
        min-width: 2.35rem;
        height: 2.35rem;
        place-items: center;
        padding: 0.45rem;
        border-radius: 50%;
        background: transparent;
        color: var(--wa-green-dark);
      }
      .mobile-back svg {
        width: 1.3rem;
        height: 1.3rem;
      }
      .mobile-back:hover {
        background: #e9edef;
      }
      .mobile-back:focus-visible {
        outline: 2px solid var(--wa-green);
        outline-offset: 2px;
      }
      .thread-title {
        display: grid;
        min-width: 0;
        gap: 0.12rem;
      }
      .thread-title-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        min-width: 0;
      }
      .thread-account-badge {
        font-size: 0.72rem;
        padding: 0.12rem 0.45rem;
      }
      .thread-title span {
        overflow: hidden;
        color: var(--muted);
        font-size: 0.72rem;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .thread-header h2 {
        margin: 0;
        overflow: hidden;
        font-size: 1rem;
        line-height: 1.35;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .thread-controls {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.5rem;
      }
      .thread-actions-menu {
        position: relative;
        flex: none;
      }
      .thread-actions-menu[open] {
        z-index: 120;
      }
      .thread-actions-menu summary {
        list-style: none;
        cursor: pointer;
      }
      .thread-actions-menu summary::-webkit-details-marker {
        display: none;
      }
      .thread-actions-menu summary:focus-visible {
        outline: 2px solid var(--wa-green);
        outline-offset: 2px;
      }
      .thread-actions-panel {
        position: absolute;
        inset-block-start: calc(100% + 0.35rem);
        inset-inline-end: 0;
        z-index: 120;
        display: grid;
        width: max-content;
        min-width: 13rem;
        max-width: min(19rem, calc(100vw - 1rem));
        padding: 0.3rem;
        border: 1px solid var(--line);
        border-radius: 0.65rem;
        background: #fff;
        box-shadow: 0 8px 24px #0b141a26;
      }
      .thread-action-item {
        display: flex;
        width: 100%;
        min-width: 0;
        min-height: 2.65rem;
        align-items: center;
        gap: 0.65rem;
        padding: 0.55rem 0.65rem;
        border: 0;
        border-radius: 0.4rem;
        background: transparent;
        color: var(--ink);
        cursor: pointer;
        font: inherit;
        font-size: 0.85rem;
        text-align: start;
      }
      .thread-action-item:hover,
      .thread-action-item:focus-visible {
        background: #f1f5f4;
      }
      .thread-action-item:focus-visible {
        outline: 2px solid var(--wa-green);
        outline-offset: -2px;
      }
      .thread-action-item svg {
        width: 1.15rem;
        height: 1.15rem;
        flex: none;
        color: var(--accent);
      }
      .thread-controls label {
        display: grid;
        gap: 0.2rem;
        min-width: 9rem;
        color: var(--muted);
        font-size: 0.75rem;
      }
      .thread-controls select {
        min-height: 2.35rem;
        padding-block: 0.4rem;
        font-size: 0.85rem;
      }
      .quiet-button {
        min-height: 2.25rem;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--accent);
        font-size: 0.8rem;
      }
      .quiet-button:hover {
        background: #f5f6f6;
      }
      .icon-button {
        display: grid;
        width: 2.45rem;
        min-width: 2.45rem;
        place-items: center;
        padding: 0.45rem;
      }
      .icon-button svg {
        width: 1.2rem;
        height: 1.2rem;
      }
      .thread-action-item.contact-info-action {
        display: none;
      }
      .messages {
        padding: 1rem 1.25rem;
        overflow-y: auto;
        overflow-anchor: none;
        background-color: var(--wa-chat);
      }
      .message-flow {
        display: flex;
        flex-direction: column;
        min-height: 100%;
        width: min(100%, 56rem);
        margin-inline: auto;
      }
      .message-day-divider {
        display: flex;
        flex: none;
        justify-content: center;
        margin-block: 0.75rem 0.45rem;
      }
      .message-day-divider.first-in-timeline {
        margin-block-start: auto;
      }
      .message-day-divider span {
        padding: 0.28rem 0.7rem;
        border: 1px solid #dfe5e7;
        border-radius: 999px;
        background: #fff;
        color: #54656f;
        box-shadow: 0 1px 1px #0b141a12;
        font-size: 0.72rem;
        line-height: 1.35;
      }
      .older-messages {
        align-self: center;
        margin: 0.25rem 0 1rem;
        border: 1px solid var(--line);
        background: #fff;
        color: var(--accent);
      }
      .history-feedback {
        align-self: center;
        max-width: min(100%, 40rem);
      }
      .message {
        position: relative;
        align-self: flex-end;
        width: fit-content;
        min-width: 5rem;
        max-width: min(78%, 32rem);
        margin: 2px 0;
        padding: 6px 9px 7px;
        border: 0;
        border-radius: 7.5px;
        background: #fff;
        color: #111b21;
        box-shadow: 0 1px 0.5px rgba(11, 20, 26, 0.13);
        overflow-wrap: anywhere;
      }
      .message:first-of-type {
        margin-block-start: auto;
      }
      .message.outgoing {
        align-self: flex-start;
        background: var(--wa-green-soft);
        border-top-right-radius: 0;
      }
      .message.outgoing::before {
        content: '';
        position: absolute;
        top: 0;
        right: -8px;
        width: 8px;
        height: 13px;
        background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 13' width='8' height='13'%3E%3Cpath opacity='0.13' fill='%23000' d='M5.188 1H0v11.193l6.467-8.625C7.526 2.156 6.958 1 5.188 1z'/%3E%3Cpath fill='%23d9fdd3' d='M5.188 0H0v11.193l6.467-8.625C7.526 1.156 6.958 0 5.188 0z'/%3E%3C/svg%3E") no-repeat;
      }
      .message:not(.outgoing) {
        border-top-left-radius: 0;
      }
      .message:not(.outgoing)::before {
        content: '';
        position: absolute;
        top: 0;
        left: -8px;
        width: 8px;
        height: 13px;
        background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 13' width='8' height='13'%3E%3Cpath opacity='0.13' fill='%23000' d='M2.812 1h5.188v11.193L1.533 3.568C.474 2.156 1.042 1 2.812 1z'/%3E%3Cpath fill='%23ffffff' d='M2.812 0h5.188v11.193L1.533 2.568C.474 1.156 1.042 0 2.812 0z'/%3E%3C/svg%3E") no-repeat;
      }
      .message.poll-vote-message { max-width: min(65%, 22rem); }
      .message.audio-message {
        width: fit-content;
        min-width: 19rem;
        max-width: min(88%, 23.5rem);
        padding: 4px 6px 4px;
      }
      .message.media-message,
      .message:has(hala-media-preview) {
        width: min(100%, 23rem);
        max-width: min(85%, 23rem);
        padding: 4px 4px 6px;
      }
      .quoted-box {
        display: grid;
        gap: 0.15rem;
        margin-block-end: 0.35rem;
        padding: 0.32rem 0.55rem 0.38rem;
        border-radius: 0.4rem;
        border-inline-start: 4px solid #00a884;
        background: rgba(0, 0, 0, 0.05);
        color: #54656f;
        font-size: 0.8rem;
        cursor: pointer;
        user-select: none;
        transition: background-color 0.15s ease;
      }
      .message.outgoing .quoted-box {
        border-inline-start-color: #008069;
        background: rgba(0, 0, 0, 0.06);
      }
      .message.outgoing .quoted-box.quoted-out {
        border-inline-start-color: #00a884;
      }
      .quoted-box:hover {
        background: rgba(0, 0, 0, 0.1);
      }
      .quoted-author {
        font-size: 0.76rem;
        font-weight: 600;
        color: #008069;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .quoted-box.quoted-out .quoted-author {
        color: #00a884;
      }
      .quoted-text {
        font-size: 0.8rem;
        line-height: 1.3;
        color: #54656f;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .message.flash-highlight {
        animation: flashBubble 1.2s ease;
      }
      @keyframes flashBubble {
        0%, 100% { filter: none; }
        30%, 65% { filter: brightness(0.9); box-shadow: 0 0 0 3px #00a88488; }
      }
      .message small {
        display: block;
        color: var(--muted);
        font-size: 0.7rem;
        direction: ltr;
        text-align: start;
      }
      .message .message-kind {
        margin-block-end: 0.2rem;
        direction: rtl;
        text-align: start;
      }
      .message p {
        margin: 0;
        font-size: 0.8875rem;
        line-height: 1.38;
        color: #111b21;
        white-space: pre-wrap;
      }
      .message .media-caption {
        margin-block-start: 0.35rem;
        margin-block-end: 0.1rem;
        padding-inline: 0.25rem;
      }
      .message .message-detail-line {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin-top: 0.2rem;
      }
      .message .forwarded-message-indicator {
        min-height: 1.05rem;
      }
      .message-detail-line svg {
        flex: none;
        width: 1.05rem;
        height: 1.05rem;
        color: var(--muted);
      }
      .message-meta {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.25rem;
        min-height: 0.95rem;
        margin-block-start: 0.15rem;
        margin-inline-start: 0.5rem;
        color: var(--muted);
        font-size: 0.6875rem;
        line-height: 1;
        float: inline-end;
      }
      .message-edits {
        margin-inline-end: auto;
      }
      .message-stamp {
        display: inline-flex;
        align-items: center;
        gap: 0.2rem;
        direction: ltr;
      }
      .message-stamp time {
        font-size: 0.6875rem;
        color: #667781;
        white-space: nowrap;
      }
      .receipt {
        width: 1rem;
        height: 0.75rem;
        color: #8696a0;
      }
      .receipt.read {
        color: #53bdeb;
      }
      .receipt.failed {
        color: #ea0038;
      }
      .message .actions {
        position: absolute;
        z-index: 4;
        top: 2px;
        display: flex;
        flex-wrap: nowrap;
        gap: 0.15rem;
        opacity: 0;
        pointer-events: none;
        transform: none;
        transition: opacity 0.12s ease;
      }
      .message .actions::before {
        content: '';
        position: absolute;
        inset: -8px -14px;
        z-index: -1;
      }
      .message.outgoing .actions {
        right: calc(100% + 4px);
        left: auto;
      }
      .message:not(.outgoing) .actions {
        left: calc(100% + 4px);
        right: auto;
      }
      .message:hover .actions,
      .message:focus-within .actions,
      .message.is-active .actions,
      .message:has(details[open]) .actions {
        opacity: 1;
        pointer-events: auto;
      }
      .message .actions button {
        display: grid;
        place-items: center;
        width: 1.65rem;
        height: 1.65rem;
        min-height: 1.65rem;
        padding: 0.25rem;
        border: 0;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.75);
        color: #54656f;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
        backdrop-filter: blur(2px);
      }
      .message .actions button svg { width: 0.95rem; height: 0.95rem; }
      .message .actions button:hover {
        background: #fff;
        color: #111b21;
      }
      .message-menu summary {
        display: grid;
        place-items: center;
        width: 1.65rem;
        height: 1.65rem;
        min-width: 1.65rem;
        min-height: 1.65rem;
        border: 0;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.75);
        color: #54656f;
        cursor: pointer;
        line-height: 1;
        list-style: none;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
        backdrop-filter: blur(2px);
      }
      .message-menu summary:hover {
        background: #fff;
        color: #111b21;
      }
      .message-menu summary svg {
        width: 0.95rem;
        height: 0.95rem;
      }
      .message-menu summary::-webkit-details-marker {
        display: none;
      }
      .message-menu summary:focus-visible {
        outline: 2px solid #00a884;
        outline-offset: 2px;
      }
      .message-menu-items {
        display: grid;
        width: max-content;
        min-width: 8.5rem;
        max-width: min(15rem, 80vw);
        margin-block-start: 0.25rem;
        padding: 0.35rem 0;
        border: 0;
        border-radius: 0.35rem;
        background: #fff;
        box-shadow: 0 2px 5px rgba(11, 20, 26, 0.26), 0 4px 12px rgba(11, 20, 26, 0.18);
      }
      .message .actions .message-menu-items button {
        width: 100%;
        height: auto;
        min-height: 2rem;
        padding: 0.45rem 1rem;
        border: 0;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        backdrop-filter: none;
        color: #111b21;
        font-size: 0.82rem;
        justify-content: flex-start;
        text-align: start;
      }
      .message .actions .message-menu-items button:hover {
        background: #f5f6f6;
      }
      .message .actions .message-menu-items button.danger {
        color: #ea0038;
      }
      .message .actions .message-menu-items button.danger:hover {
        background: #fef0f2;
      }
      .message.has-reactions {
        margin-block-end: 14px;
      }
      .reaction-badge {
        position: absolute;
        bottom: -11px;
        z-index: 3;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        padding: 1.5px 5.5px;
        border-radius: 12px;
        background: #ffffff;
        box-shadow: 0 1px 3px rgba(11, 20, 26, 0.2), 0 1px 1px rgba(11, 20, 26, 0.08);
        border: 1px solid rgba(11, 20, 26, 0.06);
        cursor: pointer;
        user-select: none;
        font-size: 0.82rem;
        line-height: 1.2;
        transition: transform 0.12s ease, box-shadow 0.12s ease;
      }
      .reaction-badge:hover {
        transform: scale(1.08);
        box-shadow: 0 2px 6px rgba(11, 20, 26, 0.28);
      }
      .message.outgoing .reaction-badge {
        right: 8px;
        left: auto;
      }
      .message:not(.outgoing) .reaction-badge {
        left: 8px;
        right: auto;
      }
      .reaction-emoji-item {
        display: inline-flex;
        align-items: center;
        gap: 2px;
      }
      .reaction-emoji-item.user-reacted {
        font-weight: bold;
      }
      .reaction-char {
        display: inline-block;
        font-size: 0.95rem;
      }
      .reaction-count {
        font-size: 0.72rem;
        font-weight: 600;
        color: #667781;
      }
      .message:has(.reaction-picker) {
        z-index: 30;
      }
      .message:has(.reaction-picker) .actions {
        opacity: 1;
        pointer-events: auto;
      }
      .react-btn.has-reacted {
        color: #00a884;
      }
      .reaction-picker {
        position: absolute;
        bottom: calc(100% + 6px);
        z-index: 25;
        display: inline-flex;
        align-items: center;
        white-space: nowrap;
        gap: 3px;
        padding: 3px 6px;
        background: #ffffff;
        border-radius: 2rem;
        box-shadow: 0 4px 14px rgba(11, 20, 26, 0.2), 0 1px 3px rgba(11, 20, 26, 0.1);
        border: 1px solid rgba(11, 20, 26, 0.08);
        animation: reactionPopIn 0.16s cubic-bezier(0.1, 0.9, 0.2, 1);
      }
      @keyframes reactionPopIn {
        from { opacity: 0; transform: scale(0.85) translateY(6px); }
        to { opacity: 1; transform: scale(1) translateY(0); }
      }
      .message.outgoing .reaction-picker {
        right: 0;
        left: auto;
      }
      .message:not(.outgoing) .reaction-picker {
        left: 0;
        right: auto;
      }
      .reaction-emoji-btn {
        display: grid;
        place-items: center;
        width: 2rem;
        height: 2rem;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        font-size: 1.25rem;
        line-height: 1;
        cursor: pointer;
        transition: transform 0.12s ease, background-color 0.12s ease;
      }
      .reaction-emoji-btn:hover {
        transform: scale(1.3);
        background-color: rgba(11, 20, 26, 0.06);
      }
      .reaction-emoji-btn.active {
        background-color: rgba(0, 168, 132, 0.16);
        box-shadow: inset 0 0 0 1.5px #00a884;
      }
      .reaction-more-btn {
        display: grid;
        place-items: center;
        width: 1.85rem;
        height: 1.85rem;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: #f0f2f5;
        color: #54656f;
        font-size: 1.15rem;
        font-weight: 500;
        cursor: pointer;
        transition: background-color 0.12s ease, color 0.12s ease;
      }
      .reaction-more-btn:hover {
        background-color: #e2e5e9;
        color: #111b21;
      }
      .custom-emoji-popover {
        position: absolute;
        bottom: calc(100% + 8px);
        z-index: 35;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.22);
        border-radius: 0.5rem;
        overflow: hidden;
        background: #ffffff;
      }
      .message.outgoing .custom-emoji-popover {
        right: 0;
        left: auto;
      }
      .message:not(.outgoing) .custom-emoji-popover {
        left: 0;
        right: auto;
      }
      .empty-thread {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: space-between;
        flex: 1;
        padding: 2.5rem 1.5rem 1.5rem;
        color: #667781;
        background: #f0f2f5;
        text-align: center;
        border-bottom: 6px solid #25d366;
        min-height: 0;
      }
      .empty-thread-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        max-width: 32rem;
        margin: auto 0;
      }
      .empty-thread-illustration {
        width: min(20rem, 80%);
        height: auto;
        margin-bottom: 2rem;
      }
      .empty-thread h2 {
        margin: 0 0 0.75rem;
        font-size: 1.85rem;
        font-weight: 300;
        color: #41525d;
      }
      .empty-thread p {
        margin: 0;
        font-size: 0.92rem;
        line-height: 1.6;
        color: #667781;
      }
      .empty-thread .error-msg {
        color: #d32f2f;
        margin-top: 0.75rem;
      }
      .empty-thread-footer {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        font-size: 0.84rem;
        color: #8696a0;
        padding-top: 1rem;
      }
      .empty-thread-footer .lock-icon {
        width: 0.95rem;
        height: 0.95rem;
        flex-shrink: 0;
      }
      .inbox > .details,
      .details {
        align-items: stretch;
        gap: 0.65rem;
        min-height: 0;
        padding: 0;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior-y: contain;
        scrollbar-width: thin;
        scrollbar-color: #cbd5e1 transparent;
        background: #fff;
        text-align: center;
      }
      .inbox > .details.media-open,
      .details.media-open { overflow: hidden; }
      .details > * { flex: 0 0 auto; }
      .details-backdrop { display: none; }
      .details-heading {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        width: 100%;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        padding: 0.65rem 1rem;
        border-block-end: 1px solid #e9edef;
        background: var(--wa-header);
      }
      .details-heading .details-close-button {
        display: none;
      }
      .details.open .details-heading .details-close-button {
        display: grid;
      }
      .details-heading h3 {
        margin: 0;
        text-align: start;
        font-size: 1rem;
      }
      .contact-profile {
        display: grid;
        width: 100%;
        justify-items: center;
        gap: 0.55rem;
        padding: 1rem 1.1rem 1.25rem;
        border-block-end: 1px solid #e6eee9;
      }
      .contact-name {
        max-width: 100%;
        padding-inline: 1rem;
        overflow-wrap: anywhere;
      }
      .contact-profile > span {
        color: var(--muted);
        font-size: 0.8rem;
      }
      .details dl {
        align-self: stretch;
        margin: 0.5rem 1.25rem 0;
        text-align: start;
      }
      .details dl div {
        padding: 0.85rem 0;
        border-block-start: 1px solid #e6eee9;
      }
      .details dl div:first-child {
        border-block-start: none;
      }
      .details dt {
        color: var(--muted);
        font-size: 0.75rem;
      }
      .details dd {
        margin: 0.3rem 0 0;
        overflow-wrap: anywhere;
        font-size: 0.88rem;
      }
      .details dd p { margin: 0.3rem 0; }
      .profile-media { flex: 1 1 0; align-self: stretch; width: 100%; min-height: 0; box-sizing: border-box; overflow-y: auto; overscroll-behavior-y: contain; scrollbar-gutter: stable; padding: 0.75rem 1.25rem 1.25rem; text-align: start; }
      .profile-media > p { color: var(--muted); font-size: 0.82rem; }
      .profile-media-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
      .profile-media-item { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.3rem; }
      .profile-media-item hala-media-preview { display: block; }
      .profile-media-item small { display: block; margin-block-start: 0.3rem; color: var(--muted); }
      .profile-media > button { width: 100%; margin-block-start: 0.7rem; }
      .profile-media-link { display:flex; align-items:center; justify-content:space-between; width:calc(100% - 2.5rem); margin:1rem 1.25rem; padding:.85rem 1rem; border:1px solid var(--line); border-radius:.65rem; background:#fff; color:var(--ink); text-align:start; cursor:pointer; }
      .details-back-button { flex:none; }
      @media (max-width: 1350px) {
        .inbox {
          grid-template-columns: minmax(17rem, 20rem) minmax(0, 1fr);
        }
        .inbox > .thread {
          border-inline-end: 0;
        }
        .inbox > .details:not(.open),
        .inbox > aside.details:not(.open) {
          display: none !important;
        }
        .thread-action-item.contact-info-action {
          display: flex;
        }
        .details-backdrop {
          position: absolute;
          z-index: 19;
          inset: 0;
          display: block;
          width: 100%;
          min-height: 0;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: #111b2166;
        }
        .inbox > .details.open,
        .inbox > aside.details.open {
          position: absolute;
          z-index: 20;
          inset-block: 0;
          inset-inline-end: 0;
          display: flex !important;
          width: min(24rem, 88vw);
          max-height: 100%;
          overflow-y: auto;
          border-inline-start: 1px solid var(--wa-border);
          box-shadow: 0 8px 28px #0b141a3d;
        }
      }
      @media (max-width: 720px) {
        .inbox {
          grid-template-columns: minmax(0, 1fr);
          height: calc(100dvh - var(--shell-header-height, 3.75rem) - 2 * var(--shell-content-padding, 0rem));
          min-height: 0;
          border-inline: 0;
          border-radius: 0;
        }
        .inbox-list,
        .thread {
          grid-column: 1;
          grid-row: 1;
          width: 100%;
          height: 100%;
          min-height: 0;
        }
        .inbox.has-selection .inbox-list,
        .inbox:not(.has-selection) .thread {
          display: none;
        }
        .inbox > .details:not(.open),
        .inbox > aside.details:not(.open) {
          display: none !important;
        }
        .list-header {
          min-height: 2.75rem;
        }
        .list-header h2 { font-size: 1rem; }
        .list-toolbar { gap: .35rem .5rem; padding: .35rem .6rem .5rem; }
        .list-toolbar > .filter-select, .list-toolbar:has(.search-messages-toggle) > .filter-select { grid-row: 1; grid-column: 2; justify-self: end; }
        .filter-select summary { justify-content: center; width: 2.75rem; height: 2.75rem; min-height: 2.75rem; padding: .4rem; border-radius: 50%; gap: .25rem; }
        .filter-select summary .account-color { width: 1.15rem; height: 1.15rem; flex-basis: 1.15rem; }
        .filter-select summary::after { margin-inline-start: 0; width: .3rem; height: .3rem; }
        .selected-account-label { display: none; }
        .filter-options { inset-inline: auto 0; width: min(19rem, calc(100vw - 1.2rem)); max-height: min(22rem, 55dvh); }
        .filter-options button { min-height: 2.75rem; }
        .search-box { grid-column: 1; min-width: 0; }
        .search-box input { min-width: 0; height: 2.75rem; font-size: 1rem; }
        .new-chat-toggle { grid-column: 2; grid-row: 2; width: 2.75rem; height: 2.75rem; min-height: 2.75rem; padding: 0; border-radius: .65rem; }
        .new-chat-toggle svg { display: block; }
        .new-chat-toggle span { display: none; }
        .search-messages-toggle { grid-column: 1 / -1; grid-row: 3; justify-self: start; }
        .filter-tabs-bar { gap: .3rem; padding: .4rem .6rem; }
        .tab-chip { flex: 0 0 auto; min-height: 2.25rem; padding: .3rem .6rem; white-space: nowrap; }
        .conversations {
          height: 0;
        }
        .thread-person {
          flex: 1;
        }
        .mobile-back {
          display: grid;
        }
        .thread-header {
          flex-wrap: nowrap;
          gap: 0.4rem;
          min-height: 4rem;
          padding: 0.45rem 0.5rem;
        }
        .thread-controls {
          flex: none;
        }
        .thread-controls label {
          min-width: 0;
        }
        .thread-controls label select {
          max-width: 8rem;
        }
        .inbox > .details.open,
        .inbox > aside.details.open {
          position: absolute;
          z-index: 20;
          display: flex !important;
          inset-inline: 0;
          inset-block: auto 0;
          width: 100%;
          height: min(78%, 36rem);
          max-height: calc(100% - env(safe-area-inset-top, 1rem));
          border-inline: 0;
          border-block-start: 1px solid var(--wa-border);
          border-start-start-radius: 1rem;
          border-start-end-radius: 1rem;
          box-shadow: 0 -8px 28px #0b141a3d;
        }
        .messages {
          min-height: 0;
          padding: 0.65rem 0.5rem;
        }
        .message {
          max-width: 92%;
        }
      }
      @media (hover: none), (max-width: 720px) {
        .message.is-active {
          box-shadow: 0 0 0 2px #00a884, 0 2px 8px rgba(11, 20, 26, 0.2);
        }
        .message .actions {
          background: rgba(255, 255, 255, 0.95);
          padding: 2px 4px;
          border-radius: 20px;
          box-shadow: 0 2px 8px rgba(11, 20, 26, 0.25);
          backdrop-filter: blur(8px);
        }
        .message.outgoing .actions {
          right: auto;
          left: 0.25rem;
          top: -1.85rem;
        }
        .message:not(.outgoing) .actions {
          left: auto;
          right: 0.25rem;
          top: -1.85rem;
        }
        .message .actions button,
        .message-menu summary {
          background: transparent;
          box-shadow: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .state-spinner {
          animation-duration: 1.8s;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InboxComponent implements OnInit {
  readonly inbox = inject(InboxStore);
  readonly calls = inject(CallHistoryStore);
  readonly messages = inject(MessagesStore);
  readonly accounts = inject(AccountsStore);
  readonly composer = inject(ComposerStore);
  readonly permissions = inject(PermissionsStore);
  readonly realtime = inject(RealtimeService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly http = inject(HttpClient);
  readonly search = signal('');
  readonly accountId = signal('');
  readonly selectedAccountLabel = computed(
    () =>
      this.accounts.accounts().find((account) => account._id === this.accountId())?.label ??
      'كل الأرقام',
  );
  readonly selectedAccountColor = computed(() => this.accountId() ? this.accountColor(this.accountId()) : null);
  private readonly accountColors = computed(() => new Map(this.accounts.accounts()
    .map(account => [account._id, account.color || fallbackAccountColor(account._id)])));

  accountColor(id: string): string {
    return this.accountColors().get(id) ?? '#008069';
  }
  readonly hasConversationFilters = computed(() => !!this.search().trim() || !!this.accountId());
  readonly searchMode = signal<'conversations' | 'messages'>('conversations');
  readonly inChatSearchOpen = signal(false);
  readonly inChatSearchQuery = signal('');
  readonly inChatMatchIndex = signal(0);
  private readonly inChatSearchInput = viewChild<ElementRef<HTMLInputElement>>('inChatSearchInput');
  private readonly newTagInput = viewChild<ElementRef<HTMLInputElement>>('newTagInput');
  private readonly tagFilterDetails = viewChild<ElementRef<HTMLDetailsElement>>('tagFilterDetails');

  readonly inChatMatches = computed(() => {
    const query = this.inChatSearchQuery().trim().toLowerCase();
    if (!query) return [];
    return this.displayMessages().filter((m) => {
      const text = (m.text || m.caption || '').toLowerCase();
      return text.includes(query);
    });
  });

  readonly currentMatchedMessageId = computed(() => {
    const matches = this.inChatMatches();
    if (!matches.length) return null;
    const idx = Math.min(this.inChatMatchIndex(), matches.length - 1);
    return matches[idx]?._id ?? null;
  });

  isMessageHighlighted(messageId: string): boolean {
    if (this.inChatSearchOpen() && this.currentMatchedMessageId() === messageId) {
      return true;
    }
    return this.inbox.highlightMessageId() === messageId;
  }
  private readonly accountFilter = viewChild<ElementRef<HTMLDetailsElement>>('accountFilter');
  private readonly threadActionsMenu = viewChild<ElementRef<HTMLDetailsElement>>('threadActionsMenu');
  private readonly threadActionsTrigger = viewChild<ElementRef<HTMLElement>>('threadActionsTrigger');
  private readonly messagesPane = viewChild<ElementRef<HTMLDivElement>>('messagesPane');
  private messageFlowObserver: ResizeObserver | null = null;
  private followLatestConversationId: string | null = null;
  private readonly contactDetailsCloseButton =
    viewChild<ElementRef<HTMLButtonElement>>('detailsCloseButton');
  readonly selected = computed(() =>
    this.inbox.items().find((item) => item._id === this.inbox.selectedId()),
  );
  readonly displayMessages = computed(() => visibleMessages(this.messages.items()));
  readonly conversationItems = computed(() => [...this.inbox.items()].sort((a, b) =>
    this.activityTime(b).localeCompare(this.activityTime(a))));
  readonly timelineItems = computed<TimelineEntry[]>(() => {
    const selected = this.selected();
    const messages: TimelineContentEntry[] = this.displayMessages().map(message =>
      ({ kind: 'message', id: `message:${message._id}`, timestamp: message.timestamp, message }));
    if (!selected) return messages;
    const calls: TimelineContentEntry[] = this.calls.items()
      .filter(call => call.accountId === selected.accountId && call.contactId === selected.contactId)
      .map(call => ({ kind: 'call', id: `call:${call._id}`, timestamp: call.startedAt, call }));
    const sorted = [...messages, ...calls].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const timeline: TimelineEntry[] = [];
    let previousDay: string | null = null;
    for (const entry of sorted) {
      const day = messageDayKey(entry.timestamp);
      if (day && day !== previousDay) {
        timeline.push({ kind: 'date', id: `date:${day}`, timestamp: entry.timestamp,
          label: messageDayLabel(entry.timestamp), firstInTimeline: timeline.length === 0 });
        previousDay = day;
      }
      timeline.push(entry);
    }
    return timeline;
  });
  latestCall(conversation: ConversationView): CallView | undefined {
    if (!conversation.lastCallAt || conversation.lastCallAt < conversation.lastMessageAt) return undefined;
    return this.calls.items().find(call => call.accountId === conversation.accountId &&
      call.contactId === conversation.contactId && call.startedAt === conversation.lastCallAt);
  }
  activityTime(conversation: ConversationView): string {
    return this.latestCall(conversation)?.startedAt ?? conversation.lastMessageAt;
  }
  callLabel(call: CallView): string {
    const kind = call.isVideo ? 'مكالمة فيديو' : 'مكالمة صوتية';
    if (call.status === 'missed') return `${kind} فائتة`;
    return `${kind} ${call.direction === 'in' ? 'واردة' : 'صادرة'}`;
  }
  conversationPreviewWithCalls(conversation: ConversationView): string {
    const call = this.latestCall(conversation);
    return call ? this.callLabel(call) : conversationPreview(conversation);
  }
  readonly conversationPreview = conversationPreview;
  readonly conversationTimeFormat = conversationTimeFormat;
  readonly contactPhoneNumber = contactPhoneNumber;
  readonly messageTypeLabel = messageTypeLabel;
  readonly messageStatusLabel = messageStatusLabel;
  readonly missingMessageContent = missingMessageContent;
  readonly editingId = signal<string | null>(null);
  readonly editText = signal('');
  readonly forwardId = signal<string | null>(null);
  readonly activeMessageId = signal<string | null>(null);
  readonly showNewChat = signal(false);
  readonly showContactDetails = signal(false);
  readonly detailsPanel = signal<'contact' | 'media'>('contact');
  readonly profileMediaItems = signal<MessageView[]>([]);
  readonly profileMediaCursor = signal<string | null>(null);
  readonly profileMediaLoading = signal(false);
  readonly profileMediaError = signal(false);
  readonly newChatError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  private searchDebounce: ReturnType<typeof setTimeout> | null = null;
  readonly newChat = signal({ accountId: '', to: '', text: '' });
  readonly newChatFields = form(this.newChat, (path) => {
    required(path.accountId);
    required(path.to);
    required(path.text);
  });
  trackConversation = (_: number, item: ConversationView) => item._id;
  accountLabel(id: string): string {
    return this.accounts.accounts().find((account) => account._id === id)?.label ?? 'رقم واتساب';
  }
  closeThreadActionsMenu(restoreFocus = false): void {
    const menu = this.threadActionsMenu()?.nativeElement;
    if (!menu?.open) return;
    menu.open = false;
    if (restoreFocus) this.threadActionsTrigger()?.nativeElement.focus();
  }
  openContactDetails(): void {
    this.closeThreadActionsMenu();
    this.detailsPanel.set('contact');
    this.showContactDetails.set(true);
    const id = this.selected()?._id;
    if (id) void this.refreshProfile(id);
    afterNextRender(() => this.contactDetailsCloseButton()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }
  openMediaPanel(id: string): void {
    this.detailsPanel.set('media');
    this.profileMediaItems.set([]);
    this.profileMediaCursor.set(null);
    this.showContactDetails.set(true);
    void this.loadProfileMedia(id, true);
  }
  showContactInfo(): void {
    this.detailsPanel.set('contact');
  }
  private async refreshProfile(id: string): Promise<void> {
    try {
      let view = await firstValueFrom(this.http.post<ConversationView>(`/api/v1/conversations/${id}/profile/refresh`, {}));
      if (this.selected()?._id !== id) return;
      this.inbox.apply(view);
      for (let attempt = 0; attempt < 10 && view.profileStatus === 'pending'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (this.selected()?._id !== id) return;
        view = await firstValueFrom(this.http.get<ConversationView>(`/api/v1/conversations/${id}`));
        this.inbox.apply(view);
      }
    } catch { /* The cached profile and unavailable state remain visible. */ }
  }
  async loadProfileMedia(id: string, reset = false): Promise<void> {
    if (this.profileMediaLoading()) return;
    if (reset) { this.profileMediaItems.set([]); this.profileMediaCursor.set(null); }
    this.profileMediaLoading.set(true);
    this.profileMediaError.set(false);
    try {
      const cursor = this.profileMediaCursor();
      const page = await firstValueFrom(this.http.get<{ items: MessageView[]; nextCursor: string | null }>(
        `/api/v1/conversations/${id}/media`, { params: cursor ? { cursor, limit: 24 } : { limit: 24 } }));
      if (this.selected()?._id !== id) return;
      this.profileMediaItems.update(items => [...items, ...page.items]);
      this.profileMediaCursor.set(page.nextCursor);
    } catch { if (this.selected()?._id === id) this.profileMediaError.set(true); }
    finally { this.profileMediaLoading.set(false); }
  }
  closeContactDetails(): void {
    if (!this.showContactDetails()) return;
    this.showContactDetails.set(false);
    this.detailsPanel.set('contact');
    const trigger = this.threadActionsTrigger()?.nativeElement;
    trigger?.focus();
    afterNextRender(() => trigger?.focus(), {
      injector: this.injector,
    });
  }
  ngOnInit(): void {
    this.destroyRef.onDestroy(() => this.cancelSearchDebounce());
    this.destroyRef.onDestroy(() => this.messageFlowObserver?.disconnect());
    void this.inbox.load();
    void this.inbox.loadTags();
    if (this.permissions.can('calls:read')) void this.calls.load();
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const id = params.get('conversationId');
      if (!id) {
        this.messageFlowObserver?.disconnect();
        this.messageFlowObserver = null;
        this.followLatestConversationId = null;
        this.showContactDetails.set(false);
        this.detailsPanel.set('contact');
        if (this.inbox.selectedId() !== null) {
          this.inbox.select(null);
          this.messages.clear();
        }
        return;
      }
      if (this.inbox.selectedId() === id && this.messages.loadedConversationId() === id) {
        this.followLatestConversationId = id;
        this.scrollToLatestMessages(id);
        const highlightId = this.inbox.highlightMessageId();
        if (highlightId) {
          this.scrollToMessageId(highlightId);
        }
        return;
      }
      const conversation = this.inbox.items().find((item) => item._id === id);
      if (conversation) {
        this.select(conversation, false);
        return;
      }
      this.showContactDetails.set(false);
      this.detailsPanel.set('contact');
      this.inbox.select(null);
      this.messages.clear();
      void firstValueFrom(this.http.get<ConversationView>(`/api/v1/conversations/${id}`))
        .then((item) => {
          this.inbox.apply(item);
          this.select(item, false);
        })
        .catch(() => this.actionError.set('لا يمكنك فتح هذه المحادثة'));
    });
    void this.accounts.load();
  }
  refresh(): void {
    this.cancelSearchDebounce();
    this.inbox.filter(this.accountId(), this.search());
    void this.inbox.load();
  }
  retryInbox(): void {
    this.cancelSearchDebounce();
    const reset = this.inbox.items().length === 0 || !this.inbox.cursor();
    void this.inbox.load(reset);
  }
  setSearch(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.search.set(val);
    if (this.searchMode() === 'messages') {
      this.cancelSearchDebounce();
      this.searchDebounce = setTimeout(() => {
        this.searchDebounce = null;
        void this.inbox.searchMessages(val, this.accountId());
      }, 350);
      return;
    }
    this.inbox.filter(this.accountId(), this.search());
    this.cancelSearchDebounce();
    this.searchDebounce = setTimeout(() => {
      this.searchDebounce = null;
      void this.inbox.load();
    }, 250);
  }
  setAccountId(value: string): void {
    this.accountId.set(value);
    this.accountFilter()?.nativeElement.removeAttribute('open');
    this.accountFilter()?.nativeElement.querySelector('summary')?.focus();
    this.refresh();
  }
  private cancelSearchDebounce(): void {
    if (this.searchDebounce === null) return;
    clearTimeout(this.searchDebounce);
    this.searchDebounce = null;
  }

  onSelectTab(tab: FilterTab): void {
    this.inbox.setFilterTab(tab);
    void this.inbox.load(true);
  }

  onSelectTag(tag: string | null): void {
    this.inbox.setSelectedTag(tag);
    void this.inbox.load(true);
  }

  tagColor(tag: string) {
    return getTagColor(tag);
  }

  suggestedTags(conversation: ConversationView): string[] {
    const active = new Set(conversation.tags || []);
    const presets = ['عميل VIP', 'مبيعات', 'شكوى', 'مهتم', 'متابعة', 'جديد'];
    const all = [...new Set([...presets, ...this.inbox.availableTags()])];
    return all.filter((t) => !active.has(t)).slice(0, 5);
  }

  async addTag(conversation: ConversationView, tag: string): Promise<void> {
    const trimmed = tag.trim();
    if (!trimmed) return;
    const current = conversation.tags || [];
    if (current.includes(trimmed)) return;
    const updated = [...current, trimmed];
    await this.inbox.updateTags(conversation._id, updated);
  }

  async removeTag(conversation: ConversationView, tagToRemove: string): Promise<void> {
    const current = conversation.tags || [];
    const updated = current.filter((t) => t !== tagToRemove);
    await this.inbox.updateTags(conversation._id, updated);
  }

  async toggleArchiveConversation(conversation: ConversationView): Promise<void> {
    const isCurrentlyArchived = conversation.status === 'archived';
    await this.inbox.archive(conversation._id, !isCurrentlyArchived);
  }

  toggleReadStatus(conversation: ConversationView, event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const isUnread = conversation.unreadCount > 0;
    const url = isUnread ? `/api/v1/conversations/${conversation._id}/read` : `/api/v1/conversations/${conversation._id}/unread`;
    const targetUnreadCount = isUnread ? 0 : 1;
    const me = this.permissions.me();
    this.inbox.apply({ ...conversation, unreadCount: targetUnreadCount });
    void firstValueFrom(this.http.post(url, {})).then(() => {
      if (isUnread) closeMessageNotifications(me, conversation._id, conversation.accountId);
    }).catch(() => {
      this.inbox.apply(conversation);
      this.actionError.set('تعذر تحديث حالة القراءة');
    });
  }

  onConversationContextMenu(conversation: ConversationView, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.toggleReadStatus(conversation);
  }

  toggleSearchMode(): void {
    if (this.searchMode() === 'conversations') {
      this.searchMode.set('messages');
      void this.inbox.searchMessages(this.search(), this.accountId());
    } else {
      this.searchMode.set('conversations');
      this.inbox.clearMessageSearch();
    }
  }

  openMessageResult(result: MessageSearchResultView): void {
    const conversation = this.inbox.items().find((c) => c._id === result.message.conversationId);
    if (conversation) {
      this.select(conversation);
    } else {
      this.inbox.select(result.message.conversationId);
      void this.router.navigate(['/inbox', result.message.conversationId]);
    }
    this.inbox.setHighlightMessageId(result.message._id);
    this.scrollToMessageId(result.message._id);
  }

  clearSearch(): void {
    this.search.set('');
    this.searchMode.set('conversations');
    this.inbox.clearMessageSearch();
    this.inbox.filter(this.accountId(), '');
    void this.inbox.load(true);
  }

  private scrollToMessageId(messageId: string): void {
    setTimeout(() => {
      const container = this.messagesPane()?.nativeElement;
      if (!container) return;
      const el = container.querySelector(`[data-message-id="${messageId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 100);
  }

  nextInChatMatch(): void {
    const matches = this.inChatMatches();
    if (!matches.length) return;
    const nextIdx = (this.inChatMatchIndex() + 1) % matches.length;
    this.inChatMatchIndex.set(nextIdx);
    const target = matches[nextIdx];
    if (target) this.scrollToMessageId(target._id);
  }

  prevInChatMatch(): void {
    const matches = this.inChatMatches();
    if (!matches.length) return;
    const prevIdx = (this.inChatMatchIndex() - 1 + matches.length) % matches.length;
    this.inChatMatchIndex.set(prevIdx);
    const target = matches[prevIdx];
    if (target) this.scrollToMessageId(target._id);
  }

  toggleInChatSearch(): void {
    const next = !this.inChatSearchOpen();
    this.inChatSearchOpen.set(next);
    if (next) {
      setTimeout(() => this.inChatSearchInput()?.nativeElement?.focus(), 60);
    } else {
      this.inChatSearchQuery.set('');
      this.inChatMatchIndex.set(0);
    }
  }

  closeInChatSearch(): void {
    this.inChatSearchOpen.set(false);
    this.inChatSearchQuery.set('');
    this.inChatMatchIndex.set(0);
  }

  setInChatSearchQuery(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.inChatSearchQuery.set(value);
    this.inChatMatchIndex.set(0);
    const matches = this.inChatMatches();
    if (matches.length > 0 && matches[0]) {
      this.scrollToMessageId(matches[0]._id);
    }
  }
  select(item: ConversationView, updateUrl = true): void {
    const changed = this.inbox.selectedId() !== item._id;
    if (changed) {
      this.showContactDetails.set(false);
      this.detailsPanel.set('contact');
      this.profileMediaItems.set([]);
      this.profileMediaCursor.set(null);
    }
    this.messageFlowObserver?.disconnect();
    this.messageFlowObserver = null;
    this.followLatestConversationId = item._id;
    this.inbox.select(item._id);
    if (changed) void this.refreshProfile(item._id);
    if (updateUrl && changed) void this.router.navigate(['/inbox', item._id]);
    void this.messages
      .select(item._id)
      .then(() => this.scrollToLatestMessages(item._id))
      .catch(() => this.actionError.set('تعذر تحميل الرسائل'));
    if (item.unreadCount > 0) {
      const me = this.permissions.me();
      this.inbox.apply({ ...item, unreadCount: 0 });
      void firstValueFrom(this.http.post(`/api/v1/conversations/${item._id}/read`, {}))
        .then(() => closeMessageNotifications(me, item._id, item.accountId)).catch(
        () => {},
      );
    } else closeMessageNotifications(this.permissions.me(), item._id, item.accountId);
  }
  closeConversation(): void {
    this.messageFlowObserver?.disconnect();
    this.messageFlowObserver = null;
    this.followLatestConversationId = null;
    this.inbox.select(null);
    this.messages.clear();
    this.showContactDetails.set(false);
    this.detailsPanel.set('contact');
    this.profileMediaItems.set([]);
    this.profileMediaCursor.set(null);
    this.actionError.set(null);
    void this.router.navigate(['/inbox']);
  }
  onMessagesScroll(): void {
    const id = this.followLatestConversationId;
    const pane = this.messagesPane()?.nativeElement;
    if (!id || !pane || this.inbox.selectedId() !== id) return;
    if (pane.scrollHeight - pane.scrollTop - pane.clientHeight > 64) {
      this.followLatestConversationId = null;
      this.messageFlowObserver?.disconnect();
      this.messageFlowObserver = null;
    }
  }
  private scrollToLatestMessages(id: string): void {
    afterNextRender(() => {
      if (this.followLatestConversationId !== id || this.inbox.selectedId() !== id) return;
      const pane = this.messagesPane()?.nativeElement;
      const flow = pane?.querySelector('.message-flow');
      if (!pane || !flow) return;
      this.messageFlowObserver?.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        this.messageFlowObserver = new ResizeObserver(() => {
          if (this.followLatestConversationId === id && this.inbox.selectedId() === id) {
            pane.scrollTop = pane.scrollHeight;
          }
        });
        this.messageFlowObserver.observe(flow);
      }
      const scrollToBottom = () => {
        if (this.followLatestConversationId === id && this.inbox.selectedId() === id) {
          pane.scrollTop = pane.scrollHeight;
        }
      };
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      requestAnimationFrame(scrollToBottom);
    }, { injector: this.injector });
  }
  private allowed(action: string, conversation: ConversationView): boolean {
    return this.permissions
      .ability()
      .can(
        action,
        subject('Message', { tenantId: conversation.tenantId, accountId: conversation.accountId }),
      );
  }
  canSend(conversation: ConversationView): boolean {
    return this.allowed('send', conversation);
  }
  canEdit(conversation: ConversationView): boolean {
    return this.allowed('edit', conversation);
  }
  canDelete(conversation: ConversationView): boolean {
    return this.allowed('delete', conversation);
  }
  canSendAccount(accountId: string): boolean {
    const current = this.permissions.me();
    return Boolean(
      current &&
      this.permissions
        .ability()
        .can('send', subject('Message', { tenantId: current.tenantId, accountId })),
    );
  }
  sendNewChat(): void {
    const input = this.newChat();
    if (!input.accountId || !input.to.trim() || !input.text.trim()) return;
    void firstValueFrom(
      this.http.post<MessageView>('/api/v1/messages', {
        type: 'text',
        accountId: input.accountId,
        to: input.to.trim(),
        text: input.text.trim(),
        clientMessageId: crypto.randomUUID(),
      }),
    )
      .then(async (message) => {
        this.newChatError.set(null);
        this.showNewChat.set(false);
        this.newChat.set({ accountId: '', to: '', text: '' });
        this.inbox.filter('', '');
        await this.inbox.load();
        const conversation = this.inbox.items().find((item) => item._id === message.conversationId);
        if (conversation) this.select(conversation);
      })
      .catch(() => this.newChatError.set('تعذر بدء المحادثة'));
  }
  retry(message: MessageView): void {
    void this.composer
      .retry(message)
      .then(() => this.actionError.set(null))
      .catch(() => this.actionError.set('تعذرت إعادة المحاولة'));
  }
  edit(message: MessageView): void {
    void this.composer
      .edit(message, this.editText())
      .then(() => {
        this.editingId.set(null);
        this.actionError.set(null);
      })
      .catch(() => this.actionError.set('تعذر تعديل الرسالة'));
  }
  onEditInput(event: Event): void {
    this.editText.set((event.target as HTMLInputElement).value);
  }
  onMessageMenuToggle(event: Event): void {
    const menu = event.currentTarget as HTMLDetailsElement;
    if (menu.open) requestAnimationFrame(() => menu.scrollIntoView({ block: 'nearest' }));
  }
  remove(message: MessageView, scope: 'me' | 'everyone'): void {
    void this.composer
      .remove(message, scope)
      .then(() => this.actionError.set(null))
      .catch(() => this.actionError.set('تعذر حذف الرسالة'));
  }
  forward(message: MessageView, select: HTMLSelectElement): void {
    const ids = [...select.selectedOptions].map((option) => option.value);
    if (ids.length)
      void this.composer
        .forward(message, ids)
        .then(() => {
          this.forwardId.set(null);
          this.actionError.set(null);
        })
        .catch(() => this.actionError.set('تعذر تحويل الرسالة'));
  }

  getQuotedMessage(message: MessageView): MessageView | undefined {
    if (!message.quotedWaMessageId) return undefined;
    const target = message.quotedWaMessageId;
    return this.messages.items().find((item) => item.waMessageId === target || item._id === target);
  }

  getQuotedSenderName(quoted: MessageView, conversation: ConversationView): string {
    return quoted.direction === 'out' ? 'أنت' : (conversation.contactName || 'جهة الاتصال');
  }

  getQuotedSnippet(quoted: MessageView): string {
    if (quoted.text) return quoted.text;
    if (quoted.caption) return quoted.caption;
    if (quoted.type === 'voice' || quoted.type === 'audio') return '🎙 رسالة صوتية';
    if (quoted.type === 'image') return '📷 صورة';
    if (quoted.type === 'video') return '🎥 فيديو';
    if (quoted.type === 'document') return '📄 مستند';
    if (quoted.type === 'location') return '📍 موقع جغرافي';
    if (quoted.type === 'contacts') return '👤 جهة اتصال';
    if (quoted.type === 'poll') return `📊 استطلاع: ${quoted.poll?.question ?? ''}`;
    return 'مرفق أو رسالة';
  }

  jumpToMessage(id: string): void {
    const el = document.getElementById('msg-' + id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('flash-highlight');
      setTimeout(() => el.classList.remove('flash-highlight'), 1200);
    }
  }

  readonly quickEmojis = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  readonly reactionPickerMessageId = signal<string | null>(null);
  readonly showCustomEmojiPicker = signal<boolean>(false);

  onMessageClick(messageId: string, event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('.actions, .reaction-picker, .reaction-badge, button, a, details, video, audio, input, textarea, select')) {
      return;
    }
    this.activeMessageId.update(current => (current === messageId ? null : messageId));
  }

  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    const threadActionsMenu = this.threadActionsMenu()?.nativeElement;
    if (threadActionsMenu?.open && !target?.closest('.thread-actions-menu')) {
      threadActionsMenu.open = false;
    }
    if (this.activeMessageId() && !target?.closest('.message')) {
      this.activeMessageId.set(null);
    }
    if (this.reactionPickerMessageId()) {
      if (target?.closest('.reaction-picker') || target?.closest('.react-btn') || target?.closest('emoji-picker')) {
        return;
      }
      this.reactionPickerMessageId.set(null);
      this.showCustomEmojiPicker.set(false);
    }
  }

  onEscape(): void {
    if (this.threadActionsMenu()?.nativeElement.open) {
      this.closeThreadActionsMenu(true);
      return;
    }
    const accountFilter = this.accountFilter()?.nativeElement;
    if (accountFilter?.open) {
      accountFilter.open = false;
      accountFilter.querySelector('summary')?.focus();
    }
    this.activeMessageId.set(null);
    if (this.reactionPickerMessageId()) {
      this.reactionPickerMessageId.set(null);
      this.showCustomEmojiPicker.set(false);
    }
  }

  toggleReactionPicker(messageId: string, event?: Event): void {
    if (event) event.stopPropagation();
    if (this.reactionPickerMessageId() === messageId) {
      this.reactionPickerMessageId.set(null);
      this.showCustomEmojiPicker.set(false);
    } else {
      this.reactionPickerMessageId.set(messageId);
      this.showCustomEmojiPicker.set(false);
    }
  }

  toggleCustomEmojiPicker(event?: Event): void {
    if (event) event.stopPropagation();
    this.showCustomEmojiPicker.set(!this.showCustomEmojiPicker());
  }

  getMessageReactions(
    message: MessageView,
  ): { emoji: string; count: number; users: string[]; hasUser: boolean }[] {
    const allMessages = this.messages.items();
    const targetWaId = message.waMessageId;
    const targetClientId = message.clientMessageId?.replaceAll('-', '').toUpperCase();
    const targetId = message._id;

    const matching = allMessages.filter(
      (item) =>
        item.type === 'reaction' &&
        item.reaction?.targetWaMessageId &&
        (item.reaction.targetWaMessageId === targetWaId ||
          (targetClientId && item.reaction.targetWaMessageId === targetClientId) ||
          item.reaction.targetWaMessageId === targetId),
    );

    if (!matching.length) return [];

    const latestBySender = new Map<string, { emoji: string; direction: 'in' | 'out' }>();
    const sorted = [...matching].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    for (const r of sorted) {
      latestBySender.set(r.direction, {
        emoji: r.reaction?.emoji?.trim() ?? '',
        direction: r.direction,
      });
    }

    const groupMap = new Map<string, { count: number; users: string[]; hasUser: boolean }>();
    const contactName = this.selected()?.contactName || 'جهة الاتصال';

    for (const [_, item] of latestBySender.entries()) {
      if (!item.emoji) continue;
      const isMe = item.direction === 'out';
      const userName = isMe ? 'أنت' : contactName;

      const group = groupMap.get(item.emoji);
      if (group) {
        group.count += 1;
        group.users.push(userName);
        if (isMe) group.hasUser = true;
      } else {
        groupMap.set(item.emoji, {
          count: 1,
          users: [userName],
          hasUser: isMe,
        });
      }
    }

    return [...groupMap.entries()].map(([emoji, data]) => ({
      emoji,
      count: data.count,
      users: data.users,
      hasUser: data.hasUser,
    }));
  }

  getUserReaction(message: MessageView): string | null {
    const reactions = this.getMessageReactions(message);
    const userReaction = reactions.find((r) => r.hasUser);
    return userReaction ? userReaction.emoji : null;
  }

  getReactionTooltip(
    reactions: { emoji: string; count: number; users: string[]; hasUser: boolean }[],
  ): string {
    return reactions
      .map((r) => `${r.users.join('، ')}: ${r.emoji}`)
      .join(' · ');
  }

  async reactToMessage(message: MessageView, emoji: string): Promise<void> {
    const conversation = this.selected();
    if (!conversation) return;
    const currentReaction = this.getUserReaction(message);
    const emojiToSend = currentReaction === emoji ? '' : emoji;
    this.reactionPickerMessageId.set(null);
    this.showCustomEmojiPicker.set(false);

    try {
      const res = await firstValueFrom(
        this.http.post<MessageView>('/api/v1/messages', {
          type: 'reaction',
          accountId: conversation.accountId,
          conversationId: conversation._id,
          to: conversation.contactPhoneE164 || conversation.contactWaId,
          targetMessageId: message._id,
          emoji: emojiToSend,
          clientMessageId: crypto.randomUUID(),
        }),
      );
      this.messages.upsert(res);
      this.actionError.set(null);
    } catch {
      this.actionError.set('تعذر إرسال التفاعل');
    }
  }

  onCustomEmojiSelected(message: MessageView, emoji: string): void {
    void this.reactToMessage(message, emoji);
  }

  onReactionBadgeClick(
    message: MessageView,
    reactions: { emoji: string; count: number; users: string[]; hasUser: boolean }[],
    event?: Event,
  ): void {
    if (event) event.stopPropagation();
    const userReaction = this.getUserReaction(message);
    if (userReaction) {
      void this.reactToMessage(message, userReaction);
    } else {
      this.toggleReactionPicker(message._id, event);
    }
  }
}
