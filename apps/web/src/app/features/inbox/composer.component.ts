import { ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { FormField, form, required } from '@angular/forms/signals';
import { type ConversationView, type OutgoingMessageInput, type ComposerMessageInput, subject } from '@hala/shared';
import { ComposerStore } from './composer.store';
import { MessagesStore } from './messages.store';
import { PermissionsStore } from '../../core/permissions.store';
import { AccountsStore } from '../accounts/accounts.store';
import { RealtimeService } from '../../core/realtime.service';
import { EmojiPickerComponent } from './emoji-picker.component';

type ComposerType = OutgoingMessageInput['type'];
const mediaKinds = new Set<ComposerType>(['image', 'video', 'audio', 'voice', 'document', 'sticker']);

@Component({
  selector: 'hala-composer', imports: [FormField, EmojiPickerComponent],
  template: `
    @if (canSend()) {
      <section class="composer" (dragover)="dragOver($event)" (drop)="drop($event)" (paste)="paste($event)">
        @if (store.replyToMessageId()) {
          <div class="reply-banner"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h9a7 7 0 0 1 7 7v3"/></svg><span><strong>الرد على رسالة</strong><small>{{ replyTarget()?.text || replyTarget()?.caption || 'مرفق أو رسالة' }}</small></span><button type="button" aria-label="إلغاء الرد" title="إلغاء الرد" (click)="store.reply(null)"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>
        }
        @if (store.previewUrl(); as preview) {
          @if (store.type() !== 'voice') {
            <div class="attachment-preview">
              <div class="preview-content">
                @if (store.type() === 'image' || store.type() === 'sticker') { <img [src]="preview" alt="معاينة المرفق" /> }
                @else if (store.type() === 'video') { <video [src]="preview" controls></video> }
                @else if (store.type() === 'audio') { <audio [src]="preview" controls></audio> }
                @else { <span class="file-name">{{ store.fileName() }}</span> }
              </div>
              <button type="button" class="icon-action remove-attachment" aria-label="إزالة المرفق" title="إزالة المرفق" (click)="clearAttachment()"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg></button>
            </div>
          }
        }
        @if (store.uploading()) { <div class="upload-status" role="status">جارٍ معالجة ورفع الملف…</div> }
        @if (store.type() !== 'text' && store.type() !== 'voice') {
          <div class="type-fields">
            @switch (store.type()) {
              @case ('image') { <input placeholder="أضف تعليقاً للصورة" [formField]="fields.caption" (keydown.enter)="onMessageEnter($event)" /> }
              @case ('video') { <input placeholder="أضف تعليقاً للفيديو" [formField]="fields.caption" (keydown.enter)="onMessageEnter($event)" /> }
              @case ('audio') { <span class="field-hint">اختر ملفاً صوتياً من زر الإرفاق</span> }
              @case ('document') { <input placeholder="تعليق المستند (اختياري)" [formField]="fields.caption" (keydown.enter)="onMessageEnter($event)" /> }
              @case ('sticker') { <span class="field-hint">اختر صورة ملصق من زر الإرفاق</span> }
              @case ('location') { <button class="secondary-action" type="button" (click)="useCurrentLocation()"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>استخدم موقعي الحالي</button>
                <input type="number" step="any" placeholder="خط العرض" [formField]="fields.lat" />
                <input type="number" step="any" placeholder="خط الطول" [formField]="fields.lng" />
                <input placeholder="اسم المكان (اختياري)" [formField]="fields.locationName" /> }
              @case ('contacts') { <input placeholder="اسم جهة الاتصال" [formField]="fields.contactName" />
                <input placeholder="رقم الهاتف" [formField]="fields.contactPhone" /> }
              @case ('poll') { <input placeholder="سؤال الاستطلاع" [formField]="fields.pollQuestion" />
                <textarea placeholder="خيار في كل سطر" [formField]="fields.pollOptions"></textarea> }
              @case ('template') { <input placeholder="اسم القالب المعتمد" [formField]="fields.templateName" />
                <input placeholder="اللغة مثل ar أو en_US" [formField]="fields.templateLanguage" />
                <textarea placeholder="مكوّنات القالب JSON (اختياري)" [formField]="fields.templateComponents"></textarea> }
              @case ('interactive') { <select [formField]="fields.interactiveKind"><option value="buttons">أزرار</option><option value="list">قائمة</option></select>
                <input placeholder="نص الرسالة" [formField]="fields.interactiveBody" />
                <textarea placeholder="خيارات الرسالة، خيار في كل سطر" [formField]="fields.interactiveOptions"></textarea> }
            }
          </div>
        }
        <div class="composer-toolbar" [class.text-mode]="store.type() === 'text' && !recording()">
          @if (recording()) {
            <div class="voice-bar voice-recording-bar">
              <button type="button" class="icon-action record-discard" aria-label="إلغاء التسجيل" title="إلغاء التسجيل" (click)="cancelRecording()">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg>
              </button>
              <div class="record-meta">
                <span class="record-dot" aria-hidden="true"></span>
                <span class="record-timer" aria-live="polite">{{ formattedDuration() }}</span>
              </div>
              <div class="record-waveform" aria-hidden="true">
                @for (h of waveBars(); track $index) {
                  <span class="wave-bar" [style.height.px]="h"></span>
                }
              </div>
              <button type="button" class="icon-action record-stop" aria-label="إيقاف التسجيل للمعاينة" title="إيقاف التسجيل للمعاينة" (click)="stopRecording()">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5" /></svg>
              </button>
              <button class="send-button" type="button" (click)="sendRecording()" [disabled]="store.uploading() || store.sending()" aria-label="إرسال التسجيل" title="إرسال التسجيل">
                @if (store.uploading() || store.sending()) { <span class="send-spinner" aria-hidden="true"></span> }
                @else { <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg> }
              </button>
            </div>
          } @else if (store.type() === 'voice' && store.previewUrl(); as preview) {
            <div class="voice-bar voice-preview-bar">
              <button type="button" class="icon-action record-discard" aria-label="حذف التسجيل" title="حذف التسجيل" (click)="clearAttachment()">
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6m4-6v6M5 7l1 14h12l1-14M9 7V4h6v3"/></svg>
              </button>
              <button type="button" class="voice-play-btn" [attr.aria-label]="previewPlaying() ? 'إيقاف مؤقت' : 'تشغيل'" [title]="previewPlaying() ? 'إيقاف مؤقت' : 'تشغيل'" (click)="togglePreviewPlayback()">
                @if (previewPlaying()) {
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                } @else {
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4.5v15a1 1 0 0 0 1.52.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 6 4.5Z"/></svg>
                }
              </button>
              <div class="voice-preview-track">
                <input type="range" class="voice-slider" min="0" [max]="previewDuration() || 100" [value]="previewCurrentTime()" (input)="onSeekPreview($event)" aria-label="موقع التشغيل" />
                <span class="voice-preview-time">{{ formattedPreviewTime() }}</span>
              </div>
              <audio #previewAudio [src]="preview" (timeupdate)="onPreviewTimeUpdate()" (ended)="onPreviewEnded()" (loadedmetadata)="onPreviewLoaded()" class="visually-hidden"></audio>
              <button class="send-button" type="button" (click)="submit()" [disabled]="store.uploading() || store.sending()" [attr.aria-label]="store.sending() ? 'جارٍ الإرسال' : 'إرسال'" [title]="store.sending() ? 'جارٍ الإرسال' : 'إرسال'">
                @if (store.sending()) { <span class="send-spinner" aria-hidden="true"></span> }
                @else { <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg> }
              </button>
            </div>
          } @else {
            <div class="composer-tools">
              @if (canAttachMedia()) {
                <label class="icon-action attachment-button" title="إرفاق ملف">
                  <input class="visually-hidden" type="file" accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip" aria-label="إرفاق ملف" (change)="pickFile($event)" />
                  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-2.8-2.8l8-8"/></svg>
                </label>
              }
              @if (store.type() === 'text') {
                <button class="icon-action emoji-toggle" type="button" aria-label="الرموز التعبيرية" title="الرموز التعبيرية" [attr.aria-expanded]="emojiOpen()" (click)="toggleEmojiPicker()"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 14c1 2 2.5 3 4 3s3-1 4-3"/><path d="M9 9h.01M15 9h.01"/></svg></button>
                @if (emojiOpen()) { @defer { <hala-emoji-picker class="emoji-picker" (emojiSelected)="addEmoji($event)" /> } }
              }
              @if (supports('voice')) { <button class="icon-action voice-toggle" type="button" (click)="startRecording()" aria-label="تسجيل رسالة صوتية" title="تسجيل رسالة صوتية"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg></button> }
            </div>
            @if (store.type() === 'text') {
              <textarea #messageInput class="message-input" aria-label="نص الرسالة" placeholder="اكتب رسالة" rows="1" [formField]="fields.text" (input)="typing()" (keydown.enter)="onMessageEnter($event)"></textarea>
            }
            <button class="send-button" type="button" (click)="submit()" [disabled]="store.uploading() || store.sending()" [attr.aria-label]="store.sending() ? 'جارٍ الإرسال' : 'إرسال'" [title]="store.sending() ? 'جارٍ الإرسال' : 'إرسال'">
              @if (store.sending()) { <span class="send-spinner" aria-hidden="true"></span> }
              @else { <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg> }
            </button>
          }
        </div>
        @if (store.error(); as error) { <p class="composer-error" role="alert">{{ error }}</p> }
      </section>
    } @else { <p>ليس لديك صلاحية الرد على هذا الرقم.</p> }
  `,
  styles: [`
    :host { position:relative; z-index:3; display:block; flex:none; max-height:min(45vh,24rem); overflow:visible; border-block-start:1px solid #d1d7db; background:#f0f2f5; }
    .composer { display:grid; gap:.35rem; width:100%; margin-inline:auto; padding:.5rem .75rem; }
    .reply-banner { display:flex; align-items:center; gap:.5rem; min-width:0; margin-inline:2.7rem; padding:.35rem .6rem; border-inline-start:3px solid #008069; border-radius:.45rem; background:#fff; color:#54656f; font-size:.78rem; box-shadow:0 1px 2px #0b141a12; }
    .reply-banner > svg { flex:none; width:1rem; height:1rem; color:#008069; }
    .reply-banner > span { display:grid; flex:1; min-width:0; gap:.1rem; }
    .reply-banner strong { color:#008069; font-size:.78rem; }
    .reply-banner small { overflow:hidden; color:#667781; text-overflow:ellipsis; white-space:nowrap; }
    .reply-banner button { display:grid; width:1.8rem; height:1.8rem; place-items:center; padding:.25rem; border-radius:50%; background:transparent; color:#54656f; }
    .reply-banner button:hover { background:#e5e9eb; }
    .reply-banner button svg { width:1rem; height:1rem; }
    .attachment-preview { position:relative; display:flex; align-items:center; width:fit-content; max-width:100%; min-height:3.25rem; padding:.4rem; border:1px solid #dfe5e7; border-radius:.6rem; background:#f7f8f8; }
    .preview-content { min-width:0; }
    .composer img, .composer video { display:block; max-width:min(16rem,65vw); max-height:9rem; border-radius:.4rem; object-fit:contain; }
    .composer audio { display:block; width:min(20rem,68vw); max-width:100%; }
    .file-name { display:block; max-width:min(24rem,68vw); overflow:hidden; padding:.45rem .6rem; color:#34464f; font-size:.85rem; text-overflow:ellipsis; white-space:nowrap; }
    .icon-action { display:grid; flex:none; width:2.35rem; height:2.35rem; place-items:center; padding:.48rem; border:1px solid transparent; border-radius:50%; background:transparent; color:#54656f; cursor:pointer; }
    .icon-action:hover, .icon-action:focus-visible { border-color:#d9e2e4; background:#e9edef; color:#008069; }
    .icon-action svg { width:1.3rem; height:1.3rem; }
    .remove-attachment { width:2rem; height:2rem; align-self:flex-start; padding:.4rem; }
    .type-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr)); align-items:center; gap:.45rem; max-height:22vh; overflow-y:auto; padding:.15rem 0; }
    .type-fields input, .type-fields textarea, .type-fields select { min-width:0; min-height:2.65rem; }
    .type-fields textarea { min-height:4.25rem; max-height:9rem; resize:vertical; }
    .field-hint { color:#667781; font-size:.8rem; }
    .secondary-action { display:inline-flex; align-items:center; justify-content:center; gap:.45rem; min-height:2.65rem; padding:.45rem .75rem; border:1px solid #d9e2e4; border-radius:.55rem; background:#f7f8f8; color:#12684f; font-size:.82rem; }
    .secondary-action:hover { background:#edf6f2; }
    .secondary-action svg { width:1.15rem; height:1.15rem; }
    .composer-toolbar { display:flex; align-items:center; gap:.35rem; min-width:0; width:100%; }
    .composer-tools { position:relative; display:flex; flex:none; align-items:center; gap:.05rem; }
    .attachment-button { position:relative; overflow:hidden; }
    .attachment-button:focus-within { outline:2px solid #008069; outline-offset:2px; }
    .visually-hidden { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); clip-path:inset(50%); white-space:nowrap; }
    .voice-toggle:hover { color:#008069; }
    .emoji-picker { position:absolute; z-index:10; inset-inline-start:0; inset-block-end:calc(100% + .45rem); width:min(21rem,calc(100vw - 1.5rem)); overflow:hidden; border:1px solid #dfe5e7; border-radius:.7rem; background:#fff; box-shadow:0 8px 24px #0b141a24; }
    .send-button { display:grid; flex:none; width:2.55rem; height:2.55rem; place-items:center; padding:.55rem; border-radius:50%; background:#008069; color:#fff; box-shadow:0 1px 2px #0b141a20; }
    .send-button:hover:not(:disabled) { background:#006b5b; }
    .send-button:focus-visible { outline:3px solid #00806955; outline-offset:2px; }
    .send-button svg { width:1.4rem; height:1.4rem; }
    .send-button:disabled { cursor:wait; opacity:.62; }
    .send-spinner { width:1.1rem; height:1.1rem; border:2px solid #ffffff70; border-block-start-color:#fff; border-radius:50%; animation:spin .8s linear infinite; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .upload-status, .composer-error { margin:0; padding:.25rem .4rem; font-size:.78rem; }
    .upload-status { color:#667781; }
    .composer-error { color:#a62030; }
    .message-input { flex:1 1 auto; width:100%; min-width:0; min-height:2.55rem; max-height:9rem; padding:.57rem .85rem; border:1px solid #fff; border-radius:.55rem; background:#fff; resize:none; line-height:1.45; box-shadow:0 1px 2px #0b141a12; }
    .message-input:focus { border-color:#008069; outline:2px solid #00806925; }

    /* WhatsApp Voice Recording & Preview UI */
    .voice-bar { display:flex; align-items:center; gap:.5rem; width:100%; min-width:0; min-height:2.65rem; }
    .record-discard { color:#8696a0; }
    .record-discard:hover { color:#ea4335; background:#fee2e2; }
    .record-meta { display:flex; align-items:center; gap:.4rem; flex:none; }
    .record-dot { width:.65rem; height:.65rem; border-radius:50%; background:#ea4335; animation:record-pulse 1.2s ease-in-out infinite; }
    @keyframes record-pulse { 0%, 100% { opacity:1; transform:scale(1); } 50% { opacity:.35; transform:scale(.8); } }
    .record-timer { font-size:.92rem; font-weight:600; color:#111b21; font-variant-numeric:tabular-nums; min-width:2.4rem; }
    .record-waveform { display:flex; align-items:center; justify-content:center; gap:2.5px; flex:1 1 auto; min-width:0; height:1.9rem; overflow:hidden; padding-inline:.35rem; }
    .wave-bar { width:3px; min-height:4px; max-height:24px; border-radius:2px; background:#8696a0; transition:height 60ms ease-out; }
    .record-stop { border:1px solid #fca5a5; background:#fef2f2; color:#dc2626; }
    .record-stop:hover { background:#fee2e2; color:#b91c1c; transform:scale(1.05); }
    .record-stop svg { width:1.1rem; height:1.1rem; }

    /* Voice Preview Bar */
    .voice-preview-bar { background:#fff; padding:.2rem .6rem; border-radius:.55rem; box-shadow:0 1px 2px #0b141a12; }
    .voice-play-btn { display:grid; flex:none; width:2.25rem; height:2.25rem; place-items:center; border-radius:50%; background:#008069; color:#fff; border:none; cursor:pointer; transition:background .15s ease; }
    .voice-play-btn:hover { background:#006b5b; }
    .voice-play-btn svg { width:1.15rem; height:1.15rem; }
    .voice-preview-track { display:flex; align-items:center; gap:.55rem; flex:1 1 auto; min-width:0; }
    .voice-slider { flex:1 1 auto; min-width:0; height:4px; direction:ltr; accent-color:#008069; cursor:pointer; }
    .voice-preview-time { flex:none; font-size:.78rem; color:#54656f; font-variant-numeric:tabular-nums; }

    .composer input, .composer textarea, .composer select, .composer button { font:inherit; }
    .composer input, .composer textarea, .composer select { min-width:0; }
    input, textarea, select, button { font: inherit; }
    @media (max-width:720px) {
      :host { max-height:min(52vh,26rem); }
      .composer { padding:.5rem .6rem .65rem; }
      .composer-toolbar { display:flex; gap:.25rem; }
      .composer-tools { min-width:0; gap:0; }
      .composer-toolbar.text-mode .message-input { min-width:4rem; }
      .reply-banner { margin-inline:0; }
      .send-button { flex:none; }
      .type-fields { grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr)); }
      .record-waveform { gap:1.5px; }
      .wave-bar { width:2px; }
    }
    @media (max-width:390px) {
      .icon-action { width:2.15rem; height:2.15rem; padding:.4rem; }
      .send-button { width:2.4rem; height:2.4rem; }
      .voice-bar { gap:.3rem; }
    }
  `], changeDetection: ChangeDetectionStrategy.OnPush
})
export class ComposerComponent {
  readonly conversation = input.required<ConversationView>();
  readonly store = inject(ComposerStore);
  private readonly messages = inject(MessagesStore);
  readonly replyTarget = computed(() => this.messages.items().find(message => message._id === this.store.replyToMessageId()));
  private readonly permissions = inject(PermissionsStore);
  private readonly accounts = inject(AccountsStore);
  private readonly realtime = inject(RealtimeService);
  private readonly destroyRef = inject(DestroyRef);

  readonly recording = signal(false);
  readonly recordingDuration = signal(0);
  readonly waveBars = signal<number[]>(Array.from({ length: 28 }, () => 4));
  readonly previewPlaying = signal(false);
  readonly previewCurrentTime = signal(0);
  readonly previewDuration = signal(0);
  private readonly previewAudio = viewChild<ElementRef<HTMLAudioElement>>('previewAudio');

  readonly formattedDuration = computed(() => {
    const sec = this.recordingDuration();
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  });

  readonly formattedPreviewTime = computed(() => {
    const cur = Math.floor(this.previewCurrentTime());
    const dur = Math.floor(this.previewDuration());
    const curM = Math.floor(cur / 60);
    const curS = cur % 60;
    const durM = Math.floor(dur / 60);
    const durS = dur % 60;
    const curStr = `${curM}:${curS < 10 ? '0' : ''}${curS}`;
    if (dur <= 0) return curStr;
    const durStr = `${durM}:${durS < 10 ? '0' : ''}${durS}`;
    return `${curStr} / ${durStr}`;
  });

  readonly emojiOpen = signal(false);
  private readonly messageInput = viewChild<ElementRef<HTMLTextAreaElement>>('messageInput');
  readonly draft = signal({ text: '', caption: '', lat: '', lng: '', locationName: '', contactName: '',
    contactPhone: '', pollQuestion: '', pollOptions: '',
    templateName: '', templateLanguage: 'ar', templateComponents: '', interactiveKind: 'buttons' as 'buttons' | 'list',
    interactiveBody: '', interactiveOptions: '' });
  readonly fields = form(this.draft, path => { required(path.text); });
  readonly canSend = computed(() => {
    const conversation = this.conversation();
    return this.permissions.ability().can('send', subject('Message', {
      tenantId: conversation.tenantId, accountId: conversation.accountId
    }));
  });

  private recorder: MediaRecorder | null = null;
  private microphone: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId?: number;
  private recordingTimer?: ReturnType<typeof setInterval>;
  private discardRecording = false;
  private autoSendOnStop = false;
  private typingTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.cleanUpRecordingStream();
      this.clearPreviewAudio();
      if (this.typingTimer) clearTimeout(this.typingTimer);
    });
  }

  supports(type: ComposerType): boolean {
    const account = this.accounts.accounts().find(item => item._id === this.conversation().accountId);
    if (!account?.capabilities.includes(type)) return false;
    if (mediaKinds.has(type)) return this.permissions.ability().can('send_media', subject('Message', {
      tenantId: this.conversation().tenantId, accountId: this.conversation().accountId
    }));
    return true;
  }

  canAttachMedia(): boolean { return [...mediaKinds].some(type => this.supports(type)); }
  toggleEmojiPicker(): void { this.emojiOpen.update(open => !open); }
  addEmoji(emoji: string): void {
    if (this.store.type() !== 'text') return;
    const textarea = this.messageInput()?.nativeElement;
    const text = this.draft().text;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? text.length;
    this.draft.update(value => ({ ...value, text: `${value.text.slice(0, start)}${emoji}${value.text.slice(end)}` }));
    this.emojiOpen.set(false);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  }
  onMessageEnter(event: Event): void {
    const keyEvent = event as KeyboardEvent;
    if (keyEvent.shiftKey || keyEvent.altKey || keyEvent.isComposing) return;
    keyEvent.preventDefault();
    void this.submit();
  }
  typing(): void {
    const id = this.conversation()._id;
    this.realtime.setTyping(id, true);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(() => this.realtime.setTyping(id, false), 2000);
  }

  private async upload(file: File): Promise<void> {
    if (this.store.uploading()) return;
    let type = this.store.type();
    const matchesSelectedType = type === 'image' || type === 'sticker' ? file.type.startsWith('image/')
      : type === 'video' ? file.type.startsWith('video/')
        : type === 'audio' || type === 'voice' ? file.type.startsWith('audio/')
          : type === 'document';
    if (!mediaKinds.has(type) || !matchesSelectedType) {
      type = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'document';
      this.store.setType(type);
    }
    if (!this.supports(type)) {
      this.store.setError('نوع المرفق غير مدعوم لهذا الرقم');
      return;
    }
    await this.store.upload(file, this.conversation().accountId, type as 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker');
  }
  pickFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.upload(file).catch(() => {});
  }
  dragOver(event: DragEvent): void { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); }
  drop(event: DragEvent): void { const file = event.dataTransfer?.files[0]; if (file) { event.preventDefault(); void this.upload(file).catch(() => {}); } }
  paste(event: ClipboardEvent): void { const file = event.clipboardData?.files[0]; if (file) { event.preventDefault(); void this.upload(file).catch(() => {}); } }

  private clearPreviewAudio(): void {
    const el = this.previewAudio()?.nativeElement;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    this.previewPlaying.set(false);
    this.previewCurrentTime.set(0);
    this.previewDuration.set(0);
  }

  clearAttachment(): void {
    this.clearPreviewAudio();
    this.store.clearAttachment();
    this.draft.update(value => ({ ...value, caption: '' }));
  }

  useCurrentLocation(): void {
    if (!navigator.geolocation) { this.store.setError('المتصفح لا يدعم تحديد الموقع'); return; }
    navigator.geolocation.getCurrentPosition(position => this.draft.update(value => ({ ...value,
      lat: String(position.coords.latitude), lng: String(position.coords.longitude)
    })), () => this.store.setError('تعذر الحصول على الموقع الحالي'), { timeout: 10000 });
  }

  async startRecording(): Promise<void> {
    if (this.recording()) return;
    if (!this.supports('voice')) return;
    this.discardRecording = false;
    this.autoSendOnStop = false;
    this.clearPreviewAudio();
    this.store.setType('voice');
    try {
      this.microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.store.setType('text');
      this.store.setError('تعذر الوصول إلى الميكروفون');
      return;
    }

    let mimeType = 'audio/webm;codecs=opus';
    if (typeof MediaRecorder !== 'undefined') {
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
        else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) mimeType = 'audio/ogg;codecs=opus';
        else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
        else mimeType = '';
      }
    }
    const chunks: BlobPart[] = [];
    const options = mimeType ? { mimeType } : undefined;
    const recorder = options ? new MediaRecorder(this.microphone, options) : new MediaRecorder(this.microphone);
    this.recorder = recorder;
    recorder.ondataavailable = event => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (this.discardRecording) {
        this.discardRecording = false;
        return;
      }
      const file = new File(chunks, 'voice.webm', { type: recorder.mimeType || 'audio/webm' });
      void this.handleVoiceRecordingComplete(file);
    };

    recorder.start(100);
    this.recording.set(true);
    this.recordingDuration.set(0);
    this.recordingTimer = setInterval(() => this.recordingDuration.update(d => d + 1), 1000);
    this.startVisualizer();
  }

  stopRecording(): void {
    if (!this.recording()) return;
    this.autoSendOnStop = false;
    this.cleanUpRecordingStream();
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.recorder = null;
    this.recording.set(false);
  }

  sendRecording(): void {
    if (!this.recording()) return;
    if (this.store.uploading() || this.store.sending()) return;
    this.autoSendOnStop = true;
    this.cleanUpRecordingStream();
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.recorder = null;
    this.recording.set(false);
  }

  cancelRecording(): void {
    this.discardRecording = true;
    this.autoSendOnStop = false;
    this.cleanUpRecordingStream();
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.recorder = null;
    this.recording.set(false);
    this.store.setType('text');
  }

  toggleRecording(): void {
    if (this.recording()) this.stopRecording();
    else void this.startRecording();
  }

  private cleanUpRecordingStream(): void {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = undefined;
    }
    if (this.recordingTimer) {
      clearInterval(this.recordingTimer);
      this.recordingTimer = undefined;
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
      this.analyser = null;
    }
    if (this.microphone) {
      this.microphone.getTracks().forEach(track => track.stop());
      this.microphone = null;
    }
  }

  private startVisualizer(): void {
    try {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass && this.microphone) {
        const audioCtx = new AudioContextClass();
        const source = audioCtx.createMediaStreamSource(this.microphone);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 64;
        analyser.smoothingTimeConstant = 0.65;
        source.connect(analyser);
        this.audioCtx = audioCtx;
        this.analyser = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const updateWave = () => {
          if (!this.recording()) return;
          analyser.getByteFrequencyData(dataArray);
          const barCount = 28;
          const step = Math.max(1, Math.floor(dataArray.length / barCount));
          const bars: number[] = [];
          for (let i = 0; i < barCount; i++) {
            const val = dataArray[i * step] ?? 0;
            const height = Math.max(4, Math.min(26, Math.round((val / 255) * 22 + 4)));
            bars.push(height);
          }
          this.waveBars.set(bars);
          this.animFrameId = requestAnimationFrame(updateWave);
        };
        updateWave();
      }
    } catch {
      this.waveBars.set([5, 10, 16, 8, 12, 20, 14, 8, 18, 22, 12, 6, 15, 20, 10, 14, 18, 8, 22, 15, 9, 16, 12, 18, 8, 12, 6, 4]);
    }
  }

  private async handleVoiceRecordingComplete(file: File): Promise<void> {
    try {
      await this.store.upload(file, this.conversation().accountId, 'voice');
      if (this.autoSendOnStop) {
        this.autoSendOnStop = false;
        await this.submit();
      }
    } catch {
      this.autoSendOnStop = false;
    }
  }

  togglePreviewPlayback(): void {
    const el = this.previewAudio()?.nativeElement;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
      this.previewPlaying.set(true);
    } else {
      el.pause();
      this.previewPlaying.set(false);
    }
  }

  onPreviewTimeUpdate(): void {
    const el = this.previewAudio()?.nativeElement;
    if (el) this.previewCurrentTime.set(el.currentTime);
  }

  onPreviewLoaded(): void {
    const el = this.previewAudio()?.nativeElement;
    if (el && !Number.isNaN(el.duration) && Number.isFinite(el.duration)) {
      this.previewDuration.set(el.duration);
    }
  }

  onPreviewEnded(): void {
    this.previewPlaying.set(false);
    this.previewCurrentTime.set(0);
  }

  onSeekPreview(event: Event): void {
    const target = event.target as HTMLInputElement;
    const time = Number(target.value);
    const el = this.previewAudio()?.nativeElement;
    if (el) {
      el.currentTime = time;
      this.previewCurrentTime.set(time);
    }
  }

  async submit(): Promise<void> {
    if (this.store.uploading() || this.store.sending()) return;
    const value = this.draft();
    let data: ComposerMessageInput;
    const type = this.store.type();
    if (type === 'text') { if (!value.text.trim()) return; data = { type, text: value.text.trim(), linkPreview: true }; }
    else if (mediaKinds.has(type)) {
      if (!this.store.mediaId()) return;
      data = { type, mediaId: this.store.mediaId()!, caption: value.caption } as ComposerMessageInput;
    } else if (type === 'location') data = { type, lat: Number(value.lat), lng: Number(value.lng), name: value.locationName };
    else if (type === 'contacts') data = { type, contacts: [{ name: value.contactName, phones: [value.contactPhone] }] };
    else if (type === 'poll') data = { type, question: value.pollQuestion,
      options: value.pollOptions.split('\n').map(item => item.trim()).filter(Boolean), selectableCount: 1 };
    else if (type === 'template') {
      let components: unknown = [];
      try { if (value.templateComponents.trim()) components = JSON.parse(value.templateComponents); }
      catch { this.store.setError('مكوّنات القالب ليست بصيغة JSON صحيحة'); return; }
      data = { type, name: value.templateName.trim(), language: value.templateLanguage.trim(), components };
    } else if (type === 'interactive') {
      const options = value.interactiveOptions.split('\n').map(item => item.trim()).filter(Boolean);
      const action = value.interactiveKind === 'buttons'
        ? { buttons: options.slice(0, 3).map((title, index) => ({ type: 'reply', reply: { id: `option_${index + 1}`, title } })) }
        : { button: 'الخيارات', sections: [{ title: 'خيارات', rows: options.slice(0, 10).map((title, index) => ({ id: `option_${index + 1}`, title })) }] };
      data = { type, kind: value.interactiveKind, body: value.interactiveBody.trim(), data: { action } };
    }
    else return;
    this.clearPreviewAudio();
    const sent = await this.store.send(this.conversation(), data);
    if (sent) {
      this.draft.set({ text: '', caption: '', lat: '', lng: '', locationName: '', contactName: '',
        contactPhone: '', pollQuestion: '', pollOptions: '',
        templateName: '', templateLanguage: 'ar', templateComponents: '', interactiveKind: 'buttons',
        interactiveBody: '', interactiveOptions: '' });
      this.emojiOpen.set(false);
    }
  }
}
