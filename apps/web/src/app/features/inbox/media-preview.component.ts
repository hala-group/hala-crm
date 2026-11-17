import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { mediaKindLabel, mediaSourceUrl } from './media-display';

@Component({
  selector: 'hala-media-preview',
  template: `
    @if (loading()) {
      <div class="media-state" role="status">
        <span class="spinner" aria-hidden="true"></span>جارٍ تحميل {{ label() }}…
      </div>
    } @else if (error()) {
      <div class="media-state media-error" role="alert">
        <span>تعذر تحميل {{ label() }}</span>
        <button type="button" (click)="retry()">إعادة المحاولة</button>
      </div>
    } @else if (url(); as src) {
      @if (kind() === 'image' || kind() === 'sticker') {
        <button
          class="image-open"
          type="button"
          (click)="openFullImage()"
          [attr.aria-label]="'عرض ' + label() + ' بالحجم الكامل'"
        >
          <img [src]="src" [alt]="label()" decoding="async" />
          <span class="image-expand" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"
              />
            </svg>
          </span>
        </button>
        <dialog
          #imageDialog
          class="image-dialog"
          [attr.aria-label]="'معاينة ' + label()"
          (click)="closeOnBackdrop($event)"
        >
          <header class="dialog-header">
            <span>{{ label() }}</span>
            <button
              class="dialog-close"
              type="button"
              (click)="closeFullImage()"
              aria-label="إغلاق المعاينة"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
              >
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </header>
          @if (fullLoading()) {
            <div class="full-state" role="status">جارٍ تحميل الصورة الأصلية…</div>
          }
          @if (fullError()) {
            <div class="full-state" role="alert">
              تعذر تحميل الصورة الأصلية
              <button type="button" (click)="retryFullImage()">إعادة المحاولة</button>
            </div>
          }
          <img class="full-image" [src]="fullUrl() ?? src" [alt]="label()" />
        </dialog>
      } @else if (kind() === 'video') {
        <video
          class="media-video"
          [src]="src"
          controls
          playsinline
          preload="metadata"
          [attr.aria-label]="label()"
        ></video>
      } @else if (kind() === 'voice' || kind() === 'audio') {
        <div class="wa-voice-player" [class.outgoing]="outgoing()">
          <audio
            #audioPlayer
            [src]="src"
            preload="metadata"
            (loadedmetadata)="onAudioMetadata($event)"
            (timeupdate)="onAudioTimeUpdate($event)"
            (ended)="onAudioEnded()"
            (pause)="onAudioPause()"
            (play)="onAudioPlay()"
            style="display:none"
          ></audio>

          <div class="voice-avatar-wrap">
            <div class="voice-avatar" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
              </svg>
            </div>
            <span class="voice-mic-badge" [class.played]="hasPlayed()">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
              </svg>
            </span>
          </div>

          <div class="voice-main">
            <div class="voice-top-row">
              <button
                type="button"
                class="voice-play-btn"
                (click)="togglePlay(audioPlayer)"
                [attr.aria-label]="isPlaying() ? 'إيقاف مؤقت' : 'تشغيل الصوت'"
              >
                @if (isPlaying()) {
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                  </svg>
                } @else {
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                }
              </button>

              <div
                class="voice-waveform"
                (click)="seekWaveform($event, audioPlayer)"
                role="slider"
                aria-label="شريط الصوت"
                [attr.aria-valuenow]="currentTime()"
                [attr.aria-valuemin]="0"
                [attr.aria-valuemax]="duration()"
              >
                @for (h of waveformHeights; track $index) {
                  @let active = ($index / waveformHeights.length) <= progressRatio();
                  <span
                    class="wave-bar"
                    [class.active]="active"
                    [class.played]="hasPlayed()"
                    [style.height.%]="h"
                  ></span>
                }
                <span class="wave-scrubber" [class.played]="hasPlayed()" [style.left.%]="progressRatio() * 100"></span>
              </div>
            </div>

            <div class="voice-bottom-row">
              <span class="voice-duration">{{ formattedTime() }}</span>
              @if (isPlaying() || playbackRate() !== 1) {
                <button
                  type="button"
                  class="voice-speed-pill"
                  (click)="cyclePlaybackRate(audioPlayer)"
                  title="سرعة التشغيل"
                >
                  {{ playbackRate() }}x
                </button>
              }
            </div>
          </div>
        </div>
      } @else {
        <a class="document-card" [href]="src" download="مرفق">
          <span class="document-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <path d="M14 2v6h6M8 13h8M8 17h8" />
            </svg>
          </span>
          <span class="document-copy"
            ><strong>{{ label() }}</strong
            ><small>اضغط لتنزيل المرفق</small></span
          >
          <svg
            class="download-icon"
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 3v12m-5-5 5 5 5-5M5 20h14" />
          </svg>
        </a>
      }
    }
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        max-width: 100%;
        color: inherit;
      }
      .media-state {
        display: flex;
        min-height: 3.25rem;
        align-items: center;
        justify-content: center;
        gap: 0.6rem;
        padding: 0.7rem;
        border: 1px solid #dce8e2;
        border-radius: 0.65rem;
        background: #fff;
        color: #54656d;
        font-size: 0.82rem;
        text-align: center;
      }
      .spinner {
        width: 1rem;
        height: 1rem;
        border: 2px solid #cbded3;
        border-block-start-color: #008069;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }
      .media-error {
        flex-wrap: wrap;
        border-color: #f0c7c7;
        background: #fff8f8;
        color: #862b2b;
      }
      .media-error button,
      .full-state button {
        min-height: 2rem;
        padding: 0.35rem 0.65rem;
        border-radius: 0.45rem;
        background: #176f57;
        color: #fff;
        font-size: 0.78rem;
      }
      .image-open {
        position: relative;
        display: block;
        width: 100%;
        max-width: 100%;
        padding: 0;
        overflow: hidden;
        border: 0;
        border-radius: 0.45rem;
        background: transparent;
        color: inherit;
      }
      .image-open img {
        display: block;
        width: 100%;
        max-height: min(22rem, 55vh);
        object-fit: contain;
        border-radius: 0.45rem;
      }
      .image-open:focus-visible {
        outline: 2px solid #008069;
        outline-offset: 2px;
      }
      .image-expand {
        position: absolute;
        inset-inline-end: 0.45rem;
        inset-block-end: 0.45rem;
        display: grid;
        place-items: center;
        width: 2rem;
        height: 2rem;
        border: 1px solid #fff8;
        border-radius: 50%;
        background: #111b21b8;
        color: #fff;
        opacity: 0;
        transition: opacity 0.15s ease;
      }
      .image-expand svg {
        width: 1.1rem;
        height: 1.1rem;
      }
      .image-open:hover .image-expand,
      .image-open:focus-visible .image-expand {
        opacity: 1;
      }
      .image-dialog {
        width: 100vw;
        height: 100dvh;
        max-width: 100vw;
        max-height: 100dvh;
        margin: auto;
        padding: env(safe-area-inset-top, 1rem) env(safe-area-inset-right, 1rem)
          env(safe-area-inset-bottom, 1rem) env(safe-area-inset-left, 1rem);
        overflow: hidden;
        border: 0;
        background: #111b21;
        color: #fff;
      }
      .image-dialog::backdrop {
        background: #111b21ed;
      }
      .dialog-header {
        display: flex;
        height: 3rem;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
      }
      .dialog-close {
        display: grid;
        flex: none;
        width: 2.6rem;
        height: 2.6rem;
        place-items: center;
        padding: 0.55rem;
        border: 1px solid #ffffff38;
        border-radius: 50%;
        background: #ffffff16;
        color: #fff;
      }
      .dialog-close svg {
        width: 1.25rem;
        height: 1.25rem;
      }
      .full-image {
        display: block;
        width: 100%;
        height: calc(100% - 3rem);
        object-fit: contain;
      }
      .full-state {
        position: absolute;
        inset-inline: 1rem;
        inset-block-end: 1rem;
        display: flex;
        justify-content: center;
        gap: 0.75rem;
        padding: 0.65rem;
        border-radius: 0.5rem;
        background: #111b21d9;
        color: white;
        font-size: 0.82rem;
      }
      .media-video {
        display: block;
        width: 100%;
        height: auto;
        max-height: min(24rem, 55vh);
        border-radius: 0.5rem;
        background: #111b21;
        object-fit: contain;
      }
      .wa-voice-player {
        display: flex;
        align-items: center;
        gap: 0.65rem;
        width: 19.5rem;
        max-width: 100%;
        min-width: 16rem;
        padding: 0.35rem 0.25rem 0.2rem;
        direction: ltr !important;
        user-select: none;
      }
      .voice-avatar-wrap {
        position: relative;
        flex: none;
        width: 2.75rem;
        height: 2.75rem;
      }
      .voice-avatar {
        display: grid;
        place-items: center;
        width: 100%;
        height: 100%;
        border-radius: 50%;
        background: #dfe5e7;
        color: #8696a0;
        overflow: hidden;
      }
      .voice-avatar svg {
        width: 1.85rem;
        height: 1.85rem;
      }
      .voice-mic-badge {
        position: absolute;
        inset-block-end: -2px;
        inset-inline-end: -2px;
        display: grid;
        place-items: center;
        width: 1.15rem;
        height: 1.15rem;
        border-radius: 50%;
        border: 2px solid #fff;
        background: #00a884;
        color: #fff;
        transition: background-color 0.2s ease;
      }
      .voice-mic-badge.played {
        background: #53bdeb;
      }
      .voice-mic-badge svg {
        width: 0.7rem;
        height: 0.7rem;
      }
      .voice-main {
        display: flex;
        flex-direction: column;
        flex: 1 1 auto;
        gap: 0.25rem;
        min-width: 0;
      }
      .voice-top-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }
      .voice-play-btn {
        display: grid;
        place-items: center;
        flex: none;
        width: 2.25rem;
        height: 2.25rem;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: #54656f;
        cursor: pointer;
        transition: transform 0.1s ease, color 0.15s ease;
      }
      .voice-play-btn:hover {
        color: #111b21;
        transform: scale(1.06);
      }
      .voice-play-btn svg {
        width: 1.65rem;
        height: 1.65rem;
      }
      .voice-waveform {
        position: relative;
        display: flex;
        align-items: center;
        gap: 2px;
        flex: 1 1 auto;
        height: 1.85rem;
        cursor: pointer;
        padding: 0.2rem 0;
      }
      .wave-bar {
        flex: 1 1 auto;
        min-width: 2px;
        border-radius: 2px;
        background-color: #b4c1c9;
        transition: background-color 0.1s ease;
      }
      .wave-bar.active {
        background-color: #00a884;
      }
      .wave-bar.active.played {
        background-color: #53bdeb;
      }
      .wave-scrubber {
        position: absolute;
        top: 50%;
        width: 0.75rem;
        height: 0.75rem;
        margin-left: -0.375rem;
        margin-top: -0.375rem;
        border-radius: 50%;
        background-color: #00a884;
        pointer-events: none;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
        transition: transform 0.05s ease;
      }
      .wave-scrubber.played {
        background-color: #53bdeb;
      }
      .voice-bottom-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-inline-start: 2.85rem;
        font-size: 0.72rem;
        color: #667781;
      }
      .voice-duration {
        font-family: inherit;
        font-variant-numeric: tabular-nums;
      }
      .voice-speed-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.1rem 0.45rem;
        border: 0;
        border-radius: 1rem;
        background: #e9edef;
        color: #54656f;
        font-size: 0.68rem;
        font-weight: 600;
        cursor: pointer;
        transition: background-color 0.15s ease;
      }
      .voice-speed-pill:hover {
        background: #dfe5e7;
      }
      .document-card {
        display: flex;
        width: 100%;
        min-height: 4.25rem;
        align-items: center;
        gap: 0.75rem;
        padding: 0.7rem;
        border: 1px solid #dce8e2;
        border-radius: 0.65rem;
        background: #f7fbf8;
        color: #19342e;
        text-decoration: none;
      }
      .document-icon {
        display: grid;
        flex: none;
        width: 2.5rem;
        height: 2.5rem;
        place-items: center;
        border-radius: 0.5rem;
        background: #e0f1e9;
        color: #176f57;
      }
      .document-icon svg {
        width: 1.35rem;
        height: 1.35rem;
      }
      .document-copy {
        display: grid;
        min-width: 0;
        flex: 1;
        gap: 0.2rem;
      }
      .document-copy strong {
        font-size: 0.85rem;
      }
      .document-copy small {
        color: #667781;
        font-size: 0.72rem;
      }
      .download-icon {
        flex: none;
        width: 1.25rem;
        height: 1.25rem;
        color: #176f57;
      }
      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }
      @media (max-width: 720px) {
        .image-open img {
          max-height: 48dvh;
        }
        .media-video {
          max-height: 45dvh;
        }
        .document-card {
          min-height: 3.75rem;
        }
        .image-expand {
          opacity: 1;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .spinner {
          animation-duration: 1.8s;
        }
        .image-expand {
          transition: none;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaPreviewComponent {
  readonly id = input.required<string>();
  readonly kind = input.required<string>();
  readonly outgoing = input<boolean>(false);
  readonly url = signal<string | null>(null);
  readonly loading = signal(true);
  readonly error = signal(false);
  readonly fullUrl = signal<string | null>(null);
  readonly fullLoading = signal(false);
  readonly fullError = signal(false);
  readonly label = computed(() => mediaKindLabel(this.kind()));
  readonly isPlaying = signal(false);
  readonly hasPlayed = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly playbackRate = signal(1);

  readonly waveformHeights: number[] = [
    32, 55, 38, 75, 48, 90, 65, 42, 80, 58, 28, 70, 88, 52, 38, 62, 78, 42, 68, 85, 48, 62, 38, 78, 58, 42, 72, 48, 32, 58, 38, 22
  ];

  readonly progressRatio = computed(() => {
    const dur = this.duration();
    if (!dur || dur <= 0) return 0;
    return Math.min(1, Math.max(0, this.currentTime() / dur));
  });

  readonly formattedTime = computed(() => {
    const secs = this.isPlaying() ? Math.floor(this.currentTime()) : Math.floor(this.duration());
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  });

  private readonly reloadAttempt = signal(0);
  private readonly http = inject(HttpClient);
  private readonly imageDialog = viewChild<ElementRef<HTMLDialogElement>>('imageDialog');
  private previewObjectUrl: string | null = null;
  private fullObjectUrl: string | null = null;

  togglePlay(audio: HTMLAudioElement): void {
    if (audio.paused) {
      void audio.play().then(() => {
        this.isPlaying.set(true);
        this.hasPlayed.set(true);
      });
    } else {
      audio.pause();
      this.isPlaying.set(false);
    }
  }

  onAudioPlay(): void {
    this.isPlaying.set(true);
    this.hasPlayed.set(true);
  }

  onAudioPause(): void {
    this.isPlaying.set(false);
  }

  onAudioEnded(): void {
    this.isPlaying.set(false);
    this.currentTime.set(0);
  }

  onAudioTimeUpdate(event: Event): void {
    const audio = event.target as HTMLAudioElement;
    this.currentTime.set(audio.currentTime);
  }

  onAudioMetadata(event: Event): void {
    const audio = event.target as HTMLAudioElement;
    if (audio.duration && !Number.isNaN(audio.duration) && Number.isFinite(audio.duration)) {
      this.duration.set(audio.duration);
    }
  }

  seekWaveform(event: MouseEvent, audio: HTMLAudioElement): void {
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const ratio = Math.min(1, Math.max(0, clickX / rect.width));
    const dur = audio.duration;
    if (dur && Number.isFinite(dur)) {
      audio.currentTime = ratio * dur;
      this.currentTime.set(audio.currentTime);
    }
  }

  cyclePlaybackRate(audio: HTMLAudioElement): void {
    const current = this.playbackRate();
    const next = current === 1 ? 1.5 : current === 1.5 ? 2 : 1;
    this.playbackRate.set(next);
    audio.playbackRate = next;
  }

  constructor() {
    effect((onCleanup) => {
      const id = this.id();
      const kind = this.kind();
      this.reloadAttempt();
      this.loading.set(true);
      this.error.set(false);
      this.url.set(null);
      this.fullUrl.set(null);
      this.fullLoading.set(false);
      this.fullError.set(false);
      this.revokePreviewUrl();
      this.revokeFullUrl();
      let cancelled = false;
      void firstValueFrom(this.http.get(mediaSourceUrl(id, kind), { responseType: 'blob' }))
        .then((blob) => {
          if (cancelled) return;
          this.previewObjectUrl = URL.createObjectURL(blob);
          this.url.set(this.previewObjectUrl);
          this.loading.set(false);
        })
        .catch(() => {
          if (cancelled) return;
          this.error.set(true);
          this.loading.set(false);
        });
      onCleanup(() => {
        cancelled = true;
        this.revokePreviewUrl();
        this.revokeFullUrl();
      });
    });
  }

  retry(): void {
    this.reloadAttempt.update((value) => value + 1);
  }

  async openFullImage(): Promise<void> {
    const dialog = this.imageDialog()?.nativeElement;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    if (this.fullUrl() || this.fullLoading()) return;
    const id = this.id();
    const kind = this.kind();
    this.fullLoading.set(true);
    this.fullError.set(false);
    try {
      const blob = await firstValueFrom(
        this.http.get(mediaSourceUrl(id, kind, true), { responseType: 'blob' }),
      );
      if (id !== this.id() || kind !== this.kind()) return;
      this.revokeFullUrl();
      this.fullObjectUrl = URL.createObjectURL(blob);
      this.fullUrl.set(this.fullObjectUrl);
    } catch {
      if (id === this.id() && kind === this.kind()) this.fullError.set(true);
    } finally {
      if (id === this.id() && kind === this.kind()) this.fullLoading.set(false);
    }
  }

  retryFullImage(): void {
    this.fullError.set(false);
    void this.openFullImage();
  }

  closeFullImage(): void {
    const dialog = this.imageDialog()?.nativeElement;
    if (dialog?.open) dialog.close();
  }

  closeOnBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.closeFullImage();
  }

  private revokePreviewUrl(): void {
    if (this.previewObjectUrl) URL.revokeObjectURL(this.previewObjectUrl);
    this.previewObjectUrl = null;
  }

  private revokeFullUrl(): void {
    if (this.fullObjectUrl) URL.revokeObjectURL(this.fullObjectUrl);
    this.fullObjectUrl = null;
  }
}
