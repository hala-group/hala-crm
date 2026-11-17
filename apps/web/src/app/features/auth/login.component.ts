import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { FormField, form } from '@angular/forms/signals';
import { loginSchema } from '@hala/shared';
import { AuthStore } from '../../core/auth.store';

@Component({
  selector: 'hala-login',
  imports: [FormField, NgOptimizedImage],
  template: `
    <main class="auth-page">
      <form class="panel" (submit)="submit($event)">
        <div class="auth-brand">
          <img ngSrc="/assets/imgs/logo.webp" width="84" height="84" priority alt="Hala CRM" />
          <h1>Hala CRM</h1>
          <p>تسجيل الدخول</p>
        </div>
        <label>البريد الإلكتروني <input type="email" autocomplete="username" [formField]="fields.email" /></label>
        <label>كلمة المرور <input type="password" autocomplete="current-password" [formField]="fields.password" /></label>
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
        <button type="submit" [disabled]="auth.loading()">دخول</button>
      </form>
    </main>
  `,
  styles: [`
    .auth-brand { display: grid; justify-items: center; gap: .6rem; margin-block-end: .5rem; }
    .auth-brand img { width: 5.25rem; height: 5.25rem; border-radius: 50%; object-fit: cover; }
    .auth-brand h1 { margin: 0; text-align: center; }
    .auth-brand p { margin: 0; color: #526b60; font-size: 1.15rem; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LoginComponent {
  readonly auth = inject(AuthStore);
  readonly model = signal({ email: '', password: '' });
  readonly fields = form(this.model);
  readonly error = signal('');

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    const parsed = loginSchema.safeParse(this.model());
    if (!parsed.success) { this.error.set('تحقق من بيانات الدخول.'); return; }
    this.error.set('');
    try { await this.auth.login(parsed.data); }
    catch { this.error.set('تعذر تسجيل الدخول. تحقق من بياناتك وحاول مجددًا.'); }
  }
}
