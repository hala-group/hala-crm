import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { type ConversationView } from '@hala/shared';
import { ContactAvatarService } from './contact-avatar.service';

@Component({
  selector: 'hala-contact-avatar',
  template: `
    @if (source(); as url) { <img [src]="url" alt="" /> }
    @else { <span>{{ conversation().contactName.trim().charAt(0) || '؟' }}</span> }
  `,
  styles: [`
    :host { display:grid; flex:none; place-items:center; width:3.15rem; height:3.15rem; overflow:hidden; border-radius:50%; background:#dfe5e7; color:#54656d; font-size:1.25rem; font-weight:600; }
    :host(.thread) { width:2.8rem; height:2.8rem; font-size:1.12rem; }
    :host(.detail) { width:4rem; height:4rem; background:#d9fdd3; color:#176f57; font-size:1.45rem; font-weight:700; }
    img { width:100%; height:100%; object-fit:cover; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class ContactAvatarComponent {
  readonly conversation = input.required<ConversationView>();
  readonly source = signal<string | null>(null);
  private readonly avatars = inject(ContactAvatarService);
  private readonly destroyRef = inject(DestroyRef);
  private generation = 0;
  private destroyed = false;
  private activeId: string | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => { this.destroyed = true; this.setSource(null); });
    effect(() => {
      const id = this.conversation()._id;
      if (id === this.activeId) return;
      this.activeId = id;
      const generation = ++this.generation;
      this.setSource(null);
      void this.load(id, generation);
    });
  }

  private setSource(url: string | null): void {
    const previous = untracked(this.source);
    if (previous) URL.revokeObjectURL(previous);
    this.source.set(url);
  }

  private async load(id: string, generation: number): Promise<void> {
    try {
      const blob = await this.avatars.load(id);
      if (!blob || this.destroyed || generation !== this.generation) return;
      this.setSource(URL.createObjectURL(blob));
    } catch { /* Keep the initials when the number is offline or the photo is private. */ }
  }
}
