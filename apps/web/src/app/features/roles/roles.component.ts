import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { createRoleSchema, PERMISSIONS, type Permission } from '@hala/shared';
import { RolesStore } from './roles.store';
import { type RoleVm } from '../../core/models';
import { HasPermissionDirective } from '../../shared/has-permission.directive';

const groups = [...new Set(PERMISSIONS.map(permission => permission.split(':')[0]))].map(resource => ({
  resource,
  permissions: PERMISSIONS.filter(permission => permission.startsWith(`${resource}:`))
}));

@Component({
  selector: 'hala-roles',
  imports: [FormField, HasPermissionDirective],
  template: `
    <section class="page">
      <h1>الأدوار والصلاحيات</h1>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <div class="columns">
        <div class="panel">
          <h2>الأدوار</h2>
          @for (role of roles.roles(); track role._id) {
            <div class="row">
              <span>{{ role.name }} @if (role.isSystem) { <small>نظام</small> }</span>
              @if (!role.isSystem) {
                <button type="button" *halaHasPermission="'roles:manage'" (click)="edit(role)">تعديل</button>
                <button type="button" *halaHasPermission="'roles:manage'" (click)="remove(role._id)">حذف</button>
              }
            </div>
          }
        </div>
        <form class="panel" *halaHasPermission="'roles:manage'" (submit)="save($event)">
          <h2>{{ editingId() ? 'تعديل دور' : 'دور مخصص جديد' }}</h2>
          <label>الاسم <input [formField]="fields.name" /></label>
          <label>الوصف <input [formField]="fields.description" /></label>
          <h3>الصلاحيات</h3>
          @for (group of groups; track group.resource) {
            <fieldset>
              <legend>{{ group.resource }}</legend>
              @for (permission of group.permissions; track permission) {
                <label class="checkbox"><input type="checkbox" [checked]="draft().permissions.includes(permission)" (change)="toggle(permission)" />{{ permission }}</label>
              }
            </fieldset>
          }
          <button type="submit">حفظ</button>
          @if (editingId()) { <button type="button" (click)="reset()">إلغاء</button> }
        </form>
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class RolesComponent implements OnInit {
  readonly roles = inject(RolesStore);
  readonly groups = groups;
  readonly draft = signal<{ name: string; description: string; permissions: Permission[] }>({ name: '', description: '', permissions: [] });
  readonly fields = form(this.draft);
  readonly editingId = signal<string | null>(null);
  readonly error = signal('');

  ngOnInit(): void { void this.roles.load().catch(() => this.error.set('تعذر تحميل الأدوار.')); }
  edit(role: RoleVm): void {
    this.editingId.set(role._id);
    this.draft.set({ name: role.name, description: role.description ?? '', permissions: [...role.permissions] });
  }
  reset(): void {
    this.editingId.set(null);
    this.draft.set({ name: '', description: '', permissions: [] });
  }
  toggle(permission: Permission): void {
    this.draft.update(current => ({
      ...current,
      permissions: current.permissions.includes(permission)
        ? current.permissions.filter(value => value !== permission)
        : [...current.permissions, permission]
    }));
  }
  async save(event: Event): Promise<void> {
    event.preventDefault();
    const parsed = createRoleSchema.safeParse(this.draft());
    if (!parsed.success) { this.error.set('أدخل اسمًا صحيحًا وحدد الصلاحيات.'); return; }
    try {
      const id = this.editingId();
      if (id) await this.roles.update(id, parsed.data);
      else await this.roles.create(parsed.data);
      this.error.set('');
      this.reset();
    } catch { this.error.set('تعذر حفظ الدور.'); }
  }
  async remove(id: string): Promise<void> {
    try { await this.roles.remove(id); this.error.set(''); }
    catch { this.error.set('لا يمكن حذف هذا الدور وهو مُستخدم أو محمي.'); }
  }
}
