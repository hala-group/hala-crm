import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, output, viewChild } from '@angular/core';
import Picker from 'emoji-picker-element/picker';
import arabic from 'emoji-picker-element/i18n/ar';

@Component({
  selector: 'hala-emoji-picker',
  template: '<div #host aria-label="اختر رمزاً تعبيرياً"></div>',
  styles: [`
    :host { display:block; }
    emoji-picker { display:block; width:100%; height:min(24rem,48vh); --num-columns:8; --emoji-size:1.35rem; --background:#fff; --border-color:#dfe5e7; --input-border-color:#d1d7db; --input-font-color:#111b21; --category-font-color:#54656f; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class EmojiPickerComponent implements AfterViewInit {
  readonly emojiSelected = output<string>();
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  ngAfterViewInit(): void {
    const picker = new Picker({
      locale: 'en',
      i18n: arabic,
      dataSource: '/assets/emoji/en.json'
    });
    picker.addEventListener('emoji-click', event => {
      if (event.detail.unicode) this.emojiSelected.emit(event.detail.unicode);
    });
    this.host().nativeElement.append(picker);
  }
}
