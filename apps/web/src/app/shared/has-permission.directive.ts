import { Directive, effect, inject, input, TemplateRef, ViewContainerRef } from '@angular/core';
import { type Permission } from '@hala/shared';
import { PermissionsStore } from '../core/permissions.store';

@Directive({ selector: '[halaHasPermission]' })
export class HasPermissionDirective {
  readonly halaHasPermission = input.required<Permission>();
  private readonly template = inject(TemplateRef<unknown>);
  private readonly container = inject(ViewContainerRef);
  private readonly permissions = inject(PermissionsStore);
  private shown = false;

  constructor() {
    effect(() => {
      const allowed = this.permissions.can(this.halaHasPermission());
      if (allowed && !this.shown) {
        this.container.createEmbeddedView(this.template);
        this.shown = true;
      } else if (!allowed && this.shown) {
        this.container.clear();
        this.shown = false;
      }
    });
  }
}
