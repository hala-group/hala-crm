import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormField, form } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { acceptInviteSchema } from '@hala/shared';

@Component({
  selector: 'hala-accept-invite',
  imports: [FormField, RouterLink],
  template: `
    <main class="auth-page">
      <form class="panel" (submit)="submit($event)">
        <h1>قبول الدعوة</h1>
        <label>رمز الدعوة <input [formField]="fields.token" /></label>
        <label>كلمة مرور جديدة <input type="password" autocomplete="new-password" [formField]="fields.password" /></label>
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
        @if (done()) { <p>تم تفعيل حسابك. <a routerLink="/login">سجّل الدخول</a></p> }
        @else { <button type="submit">تفعيل الحساب</button> }
      </form>
    </main>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AcceptInviteComponent {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  readonly model = signal({ token: this.route.snapshot.queryParamMap.get('token') ?? '', password: '' });
  readonly fields = form(this.model);
  readonly error = signal('');
  readonly done = signal(false);

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const parsed = acceptInviteSchema.safeParse(this.model());
    if (!parsed.success) { this.error.set('أدخل رمزًا صحيحًا وكلمة مرور من 12 حرفًا على الأقل.'); return; }
    try {
      await firstValueFrom(this.http.post('/api/v1/auth/accept-invite', parsed.data));
      this.done.set(true);
      this.error.set('');
    } catch { this.error.set('الدعوة غير صالحة أو انتهت صلاحيتها.'); }
  }
}
